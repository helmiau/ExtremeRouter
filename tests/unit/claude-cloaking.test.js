/**
 * Unit tests for open-sse/utils/claudeCloaking.js
 *
 * Tests cover:
 *  - cloakClaudeTools() - tool renaming and forced tool_choice suffixing
 *  - applyCloaking()    - billing identity (centralized CLAUDE_CLI_VERSION) + fake user id
 */

import { describe, it, expect } from "vitest";
import { cloakClaudeTools, applyCloaking } from "../../open-sse/utils/claudeCloaking.js";
import { CLAUDE_TOOL_SUFFIX } from "../../open-sse/config/appConstants.js";
import { CLAUDE_CLI_VERSION } from "../../open-sse/providers/shared.js";

describe("cloakClaudeTools", () => {
  const baseBody = {
    tools: [{ name: "todo_write", description: "write todos", input_schema: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: [{ type: "text", text: "add a todo" }] }]
  };

  it("suffixes client tool names and maps them back", () => {
    const { body, toolNameMap } = cloakClaudeTools(baseBody);
    const suffixed = `todo_write${CLAUDE_TOOL_SUFFIX}`;
    expect(body.tools.find(t => t.name === suffixed)).toBeDefined();
    expect(toolNameMap.get(suffixed)).toBe("todo_write");
  });

  it("suffixes a forced tool_choice to match the renamed tool", () => {
    const { body } = cloakClaudeTools({
      ...baseBody,
      tool_choice: { type: "tool", name: "todo_write" }
    });
    // Without this, Claude rejects: "Tool 'todo_write' not found in provided tools".
    expect(body.tool_choice).toEqual({ type: "tool", name: `todo_write${CLAUDE_TOOL_SUFFIX}` });
  });

  it("suffixes only the chosen tool when several are present", () => {
    const { body } = cloakClaudeTools({
      tools: [
        { name: "search", input_schema: { type: "object", properties: {} } },
        { name: "todo_write", input_schema: { type: "object", properties: {} } }
      ],
      tool_choice: { type: "tool", name: "todo_write" }
    });
    expect(body.tool_choice).toEqual({ type: "tool", name: `todo_write${CLAUDE_TOOL_SUFFIX}` });
  });

  it("leaves non-forced tool_choice untouched", () => {
    const auto = cloakClaudeTools({ ...baseBody, tool_choice: { type: "auto" } });
    expect(auto.body.tool_choice).toEqual({ type: "auto" });

    const none = cloakClaudeTools({ ...baseBody });
    expect(none.body.tool_choice).toBeUndefined();
  });

  it("does not suffix a forced choice that targets a non-client (decoy/built-in) tool", () => {
    // "Bash" is an injected decoy sent unsuffixed; forcing it must stay as-is.
    const { body } = cloakClaudeTools({ ...baseBody, tool_choice: { type: "tool", name: "Bash" } });
    expect(body.tool_choice).toEqual({ type: "tool", name: "Bash" });
  });

  it("renames tool_use names in message history", () => {
    const { body } = cloakClaudeTools({
      ...baseBody,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "todo_write", input: {} }] }
      ]
    });
    const block = body.messages[0].content[0];
    expect(block.name).toBe(`todo_write${CLAUDE_TOOL_SUFFIX}`);
  });

  it("returns the body unchanged when there are no tools", () => {
    const input = { messages: [{ role: "user", content: "hi" }], tool_choice: { type: "tool", name: "x" } };
    const { body, toolNameMap } = cloakClaudeTools(input);
    expect(body).toBe(input);
    expect(toolNameMap).toBeNull();
  });
});

describe("applyCloaking — billing identity", () => {
  // OAuth-only path: the billing header must carry the CENTRALIZED CLAUDE_CLI_VERSION
  // (open-sse/providers/shared.js) so the request UA and billing cc_version can never
  // drift apart — Anthropic gates new models (Fable 5.1) to CC >= 2.1.251.
  it("injects cc_version from the centralized CLAUDE_CLI_VERSION as system[0] (OAuth only)", () => {
    const out = applyCloaking(
      { messages: [{ role: "user", content: "hi" }] },
      "sk-ant-oat01-test-token",
      "sess-1",
    );

    const billing = out.system[0]?.text || "";
    expect(billing).toMatch(
      new RegExp(`^x-anthropic-billing-header: cc_version=${CLAUDE_CLI_VERSION}\\.\\w{3}; cc_entrypoint=sdk-cli; cch=\\w{5};$`)
    );
    // Fake user id injected alongside, aligned with the session.
    expect(out.metadata.user_id).toContain("session_id");
  });

  it("skips cloaking entirely for non-OAuth (apiKey) credentials", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const out = applyCloaking(body, "sk-any-key", "sess-1");
    expect(out).toBe(body);
  });
});
