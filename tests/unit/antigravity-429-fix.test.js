import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { CLOUD_CODE_API } from "../../open-sse/config/appConstants.js";

// The executor imports cleanJSONSchemaForAntigravity by name; wrap it in a
// spy so the schema-crash fallback path can be exercised deterministically.
vi.mock("../../open-sse/translator/formats/gemini.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    cleanJSONSchemaForAntigravity: vi.fn(actual.cleanJSONSchemaForAntigravity),
  };
});

import { cleanJSONSchemaForAntigravity } from "../../open-sse/translator/formats/gemini.js";

const creds = { projectId: "proj-1", connectionId: "conn-1" };

function baseBody(overrides = {}) {
  return {
    request: {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      ...overrides,
    },
  };
}

// Endpoint pin: decolua/9router PR #3208 claimed switching to the production
// host fixes 429 RESOURCE_EXHAUSTED. Live verification (2026-08-13, 7 stored
// accounts, executor-built requests) showed the OPPOSITE: production
// (cloudcode-pa.googleapis.com) returned 429 on every account while the canary
// host returned real 200 completions. The endpoint switch was therefore NOT
// ported — only the request-size optimizations were. These tests pin the
// canary endpoint so any future change is deliberate.
describe("antigravity 429 fix — endpoint stays on canary (live-verified)", () => {
  it("routes chat traffic to the canary host that empirically works", () => {
    expect(PROVIDERS.antigravity.baseUrls[0]).toBe("https://daily-cloudcode-pa.googleapis.com");
  });

  it("uses the canary host for loadCodeAssist/onboardUser provisioning", () => {
    expect(CLOUD_CODE_API.antigravity.loadCodeAssist).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"
    );
  });

  it("builds URLs against the canary host", () => {
    const ag = new AntigravityExecutor();
    expect(ag.buildUrl("gemini-3.6-flash-high", true)).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"
    );
  });
});

describe("antigravity 429 fix — JSON Schema $ref resolution", () => {
  it("inlines #/$defs references before stripping unsupported keywords", () => {
    const schema = {
      type: "object",
      properties: {
        point: { $ref: "#/$defs/Point" },
      },
      $defs: {
        Point: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" } },
          required: ["x"],
        },
      },
    };

    const cleaned = cleanJSONSchemaForAntigravity(structuredClone(schema));
    expect(cleaned.$defs).toBeUndefined();
    expect(cleaned.properties.point).toMatchObject({
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" } },
    });
    expect(cleaned.properties.point.required).toEqual(["x"]);
  });

  it("inlines draft-07 #/definitions references", () => {
    const schema = {
      type: "object",
      properties: {
        id: { $ref: "#/definitions/Id" },
      },
      definitions: { Id: { type: "string", minLength: 1 } },
    };

    const cleaned = cleanJSONSchemaForAntigravity(structuredClone(schema));
    expect(cleaned.definitions).toBeUndefined();
    // minLength is unsupported → stripped after inlining, but type survives
    expect(cleaned.properties.id).toEqual({ type: "string" });
  });

  it("falls back to a string placeholder for unresolvable $ref", () => {
    const schema = {
      type: "object",
      properties: { a: { $ref: "#/$defs/Missing" } },
      $defs: {},
    };

    const cleaned = cleanJSONSchemaForAntigravity(structuredClone(schema));
    expect(cleaned.properties.a).toEqual({ type: "string", description: "(unresolved reference)" });
  });
});

describe("antigravity 429 fix — request size optimization", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("flattens nested tool schemas beyond depth 2 to simple types", () => {
    const ag = new AntigravityExecutor();
    const out = ag.transformRequest(
      "gemini-3.6-flash-high",
      baseBody({
        tools: [
          {
            functionDeclarations: [
              {
                name: "deep_tool",
                description: "x".repeat(300),
                parameters: {
                  type: "object",
                  properties: {
                    level1: {
                      type: "object",
                      description: "y".repeat(200),
                      properties: {
                        level2: {
                          type: "object",
                          properties: {
                            level3: { type: "object", properties: { deep: { type: "string" } } },
                          },
                        },
                      },
                    },
                  },
                },
              },
            ],
          },
        ],
      }),
      true,
      creds
    );

    const decl = out.request.tools[0].functionDeclarations[0];
    // Tool description trimmed to MAX_TOOL_DESC_CHARS (200)
    expect(decl.description.length).toBeLessThanOrEqual(200);
    // Schema descriptions trimmed to MAX_SCHEMA_DESC_CHARS (150)
    expect(decl.parameters.properties.level1.description.length).toBeLessThanOrEqual(150);
    // Depth-2 object collapsed to a string hint
    expect(decl.parameters.properties.level1.properties.level2).toEqual({
      type: "string",
      description: expect.stringContaining("JSON object with properties: level3"),
    });
  });

  it("caps tool count at 40, keeping native Antigravity tools first", () => {
    const ag = new AntigravityExecutor();
    const custom = Array.from({ length: 45 }, (_, i) => ({
      name: `custom_${i}`,
      description: "client tool",
      parameters: { type: "object", properties: {} },
    }));
    const native = [
      { name: "run_command", description: "native", parameters: { type: "object", properties: {} } },
      { name: "view_file", description: "native", parameters: { type: "object", properties: {} } },
    ];

    const out = ag.transformRequest(
      "gemini-3.6-flash-high",
      baseBody({ tools: [{ functionDeclarations: [...custom, ...native] }] }),
      true,
      creds
    );

    const decls = out.request.tools[0].functionDeclarations;
    expect(decls.length).toBe(40);
    expect(decls[0].name).toBe("run_command");
    expect(decls[1].name).toBe("view_file");
  });

  it("falls back to a minimal schema when conversion crashes (fake-429 guard)", () => {
    cleanJSONSchemaForAntigravity.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const ag = new AntigravityExecutor();
    const out = ag.transformRequest(
      "gemini-3.6-flash-high",
      baseBody({
        tools: [
          {
            functionDeclarations: [
              {
                name: "broken",
                parameters: {
                  type: "object",
                  properties: { a: { type: "string" } },
                  required: ["a"],
                },
              },
            ],
          },
        ],
      }),
      true,
      creds
    );

    const params = out.request.tools[0].functionDeclarations[0].parameters;
    expect(params.type).toBe("object");
    expect(params.properties.a).toEqual({ type: "string", description: "" });
    expect(params.required).toEqual(["a"]);
  });
});

describe("antigravity 429 fix — system instruction embedding", () => {
  it("embeds a system prompt > 4000 chars into the first user message", () => {
    const sysText = "S".repeat(5000);
    const ag = new AntigravityExecutor();
    const out = ag.transformRequest(
      "gemini-3.6-flash-high",
      baseBody({ systemInstruction: { parts: [{ text: sysText }] } }),
      true,
      creds
    );

    expect(out.request.systemInstruction).toBeUndefined();
    const firstUser = out.request.contents.find((c) => c.role === "user");
    const text = firstUser.parts.find((p) => p.text !== undefined).text;
    expect(text).toContain("[System Instructions]");
    expect(text).toContain("[User Message]");
    expect(text).toContain("hi");
    expect(text).toContain(sysText);
  });

  it("prepends a synthetic user message when no user turn exists yet", () => {
    const ag = new AntigravityExecutor();
    const out = ag.transformRequest(
      "gemini-3.6-flash-high",
      {
        request: {
          contents: [{ role: "model", parts: [{ text: "previous" }] }],
          systemInstruction: { parts: [{ text: "S".repeat(5000) }] },
        },
      },
      true,
      creds
    );

    expect(out.request.systemInstruction).toBeUndefined();
    expect(out.request.contents[0].role).toBe("user");
    expect(out.request.contents[0].parts[0].text).toBe("S".repeat(5000));
  });

  it("keeps small system prompts untouched", () => {
    const ag = new AntigravityExecutor();
    const out = ag.transformRequest(
      "gemini-3.6-flash-high",
      baseBody({ systemInstruction: { parts: [{ text: "short prompt" }] } }),
      true,
      creds
    );

    expect(out.request.systemInstruction.parts[0].text).toBe("short prompt");
  });
});
