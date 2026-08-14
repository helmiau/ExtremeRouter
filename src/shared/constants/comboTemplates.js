// Combo Template Library — prebuilt combo configurations that users can one-click apply.
//
// MODEL-BASED (not provider-based): `models` lists model NAMES only. The UI
// resolves each model to any CONNECTED provider that carries it. The optional
// `preferredProviders` map is only a hint — if that provider isn't connected
// (or doesn't have the model), the resolver falls back to another connected
// provider that does (e.g. template prefers "claude-opus-4-7" on cc, but the
// user only has kiro connected → uses kiro).
//
// Optional `strategyConfig` (if present) is applied alongside the strategy so
// templates can ship rich defaults (thinking, autoScale, role models). Role
// models are also resolved model-first.
//
// To add a template: append to this array. No DB change needed.

export const COMBO_TEMPLATES = [
  {
    id: "always-on",
    name: "Always-On (5-Layer Fallback)",
    description:
      "Zero-downtime coding with 5 layers of fallback. Mix of subscription, cheap, and free tiers — if any model fails, the next picks up automatically.",
    icon: "shield",
    category: "reliability",
    strategy: "fallback",
    models: [
      "claude-opus-4-7",   // subscription primary
      "gpt-5.4",            // second subscription
      "glm-5.1",            // cheap, resets daily
      "MiniMax-M2.7",       // cheapest
      "claude-sonnet-4.5",  // free unlimited
    ],
    preferredProviders: {
      "claude-opus-4-7": "cc",
      "gpt-5.4": "cx",
      "glm-5.1": "glm",
      "MiniMax-M2.7": "minimax",
      "claude-sonnet-4.5": "kr",
    },
  },
  {
    id: "max-reasoning-swarm",
    name: "Max Reasoning Swarm",
    description:
      "Deep multi-agent analysis for complex coding tasks. Manager decomposes the problem, workers solve subtasks in parallel, audit reviews the result. Manager thinks at max effort.",
    icon: "psychology",
    category: "reasoning",
    strategy: "swarm",
    models: [
      "claude-opus-4-7",   // manager — max effort
      "gpt-5.4",            // worker
      "glm-5.1",            // worker
      "claude-sonnet-4.5",  // audit
    ],
    preferredProviders: {
      "claude-opus-4-7": "cc",
      "gpt-5.4": "cx",
      "glm-5.1": "glm",
      "claude-sonnet-4.5": "kr",
    },
    strategyConfig: {
      fallbackStrategy: "swarm",
      managerModel: "claude-opus-4-7",
      auditModel: "claude-sonnet-4.5",
      thinking: {
        type: "effort",
        effort: "high",
        roles: {
          manager: { type: "effort", effort: "max" },
          worker:  { type: "effort", effort: "medium" },
          audit:   { type: "effort", effort: "high" },
        },
      },
      autoScale: { enabled: true, minWorkers: 2, maxWorkers: 4 },
    },
  },
  {
    id: "flash-fusion",
    name: "Flash Fusion",
    description:
      "Two fast models answer in parallel, a judge picks the best result. Low latency with a quality check — great for everyday coding questions.",
    icon: "bolt",
    category: "balanced",
    strategy: "fusion",
    models: [
      "gpt-5.4",           // fast panel
      "MiniMax-M2.7",      // cheap panel
    ],
    preferredProviders: {
      "gpt-5.4": "cx",
      "MiniMax-M2.7": "minimax",
    },
    strategyConfig: {
      fallbackStrategy: "fusion",
      thinking: { type: "effort", effort: "medium" },
    },
  },
  {
    id: "penny-pincher",
    name: "Penny-Pincher",
    description:
      "Ultra-low-cost daily driver built from cheap and free tiers. Thinking disabled to keep tokens minimal. Use for simple tasks where cost matters most.",
    icon: "savings",
    category: "budget",
    strategy: "fallback",
    models: [
      "MiniMax-M2.7",   // cheapest
      "glm-5.1",        // cheap, resets daily
      "gpt-5.4",        // free tier
    ],
    preferredProviders: {
      "MiniMax-M2.7": "minimax",
      "glm-5.1": "glm",
      "gpt-5.4": "gh", // free tier via GitHub Copilot (kiro does not carry gpt-5.4)
    },
    strategyConfig: {
      fallbackStrategy: "fallback",
      thinking: { type: "off" },
    },
  },
  {
    id: "bug-hunter",
    name: "Bug Hunter",
    description:
      "Three models independently diagnose the same bug, a strong judge picks the most likely root cause. High-precision debugging with thinking on.",
    icon: "bug_report",
    category: "debugging",
    strategy: "fusion",
    models: [
      "gpt-5.4",           // independent diagnosis
      "glm-5.1",           // independent diagnosis
      "MiniMax-M2.7",      // independent diagnosis
    ],
    preferredProviders: {
      "gpt-5.4": "cx",
      "glm-5.1": "glm",
      "MiniMax-M2.7": "minimax",
    },
    strategyConfig: {
      fallbackStrategy: "fusion",
      thinking: { type: "effort", effort: "high" },
    },
  },
];
