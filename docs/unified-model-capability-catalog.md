# Unified Model Capability Catalog — Design Proposal

> Status: proposal (pre-implementation)
> Owner: core
> Related audit: "UI capability guessing" sweep (see §1)
> Codebase references: `open-sse/providers/capabilities.js`, `open-sse/services/comboConfig.js`,
> `src/app/api/v1/models/route.js`, `src/shared/utils/comboThinking.js`, `src/shared/utils/modelCaps.js`

---

## 1. Problem statement (from the audit)

A sweep of every UI + client-facing endpoint that decides model capabilities found that
most surfaces are already data-driven — **but the combo surfaces are not**, and they are
the ones Zcode/Codex read:

| Surface | Today | Verdict |
|---|---|---|
| `ParameterPanel` | `useModelCaps` → `caps.reasoning`, `thinkingLevelsForCaps`, `maxTokensBound` | ✅ data-driven |
| `ComboTemplatesTab` | provider resolution via `modelIndex` | ✅ data-driven |
| `CombosPageInner` | `/api/models` → `map[fullModel]=caps` | ✅ data-driven |
| `ComboCard` | member `CapacityBadges` + `classifyComboThinking` (member caps) | ⚠️ per-member only, no combo aggregate |
| `ModelSelectModal` | `getCaps(model.value)` | ✅ data-driven |
| `useModelCaps` | fallback `getCapabilitiesForModel` | ✅ data-driven |
| **`/v1/models` combo entries** | `capabilities: { thinking: true, agentic: false }` **derived from strategy only** — never from member caps | ❌ **misleading** |
| `inferKindFromUnknownModelId` | regex on model name (`/embed/`, `/tts\|audio\|voice/`, `/flux\|sdxl/`) | ⚠️ name-guessing fallback |

### Concrete failure modes today

1. **Combo with `thinking: auto`** (no strategy override) whose members are reasoning
   models → `/v1/models` advertises **no capabilities at all**. Zcode/Codex cannot detect
   that the combo thinks.
2. **Combo with `thinking: effort`** whose members are non-reasoning models → `/v1/models`
   advertises `thinking: true` **incorrectly**. Clients are actively misled.
3. **No vision/audio/context/max-output anywhere for combos.** A combo of two vision
   models looks identical to a combo of two text models to any client.
4. **UI cannot show combo-level capability** — `ComboCard` renders per-member badges only,
   so "is this combo vision-capable?" requires expanding every member.
5. `combo.context_length` is only advertised when a user set it explicitly; it is never
   derived from members.

This is exactly the class of bug the catalog eliminates: **one derivation function,
used by both the client-facing endpoints and the UI, so the displayed capability always
matches the runtime capability.**

---

## 2. Schema

### 2.1 Model entry (what `/v1/models` and `/api/models` emit)

```jsonc
{
  "id": "my-combo",
  "object": "model",
  "owned_by": "combo",          // "combo" for combos, provider alias for provider models
  "kind": "llm",                // existing; optional for LLM
  "capabilities": {
    "thinking": true,           // can this model/combo produce reasoning traces?
    "agentic": true,            // can it use tools / act autonomously?
    "vision":    { "input": true,  "output": false },
    "audio":     { "input": false, "output": false },
    "tools": true,
    "contextWindow": 1000000,   // tokens
    "maxOutput": 128000,        // tokens
    "source": "combo"           // "native" (provider truth) | "combo" (derived)
  }
}
```

### 2.2 Changes vs. the originally-proposed shape

| Item | Original proposal | This proposal | Why |
|---|---|---|---|
| `ray_format` | inside `capabilities` | **removed from capabilities** — transport metadata belongs on the registry/transport layer, not in a capability catalog | keeps one schema with one job; avoids the "one object, two concerns" smell the catalog is meant to remove |
| `thinking` | `true` if combo role uses non-auto thinking | `capabilities.thinking` = **member-derived "can think"** (union); the "does it actually think" signal stays in the **strategy** (`strategy.thinking.type`), which `/v1/models` already merges via `normalizeComboStrategyConfig` | separates capability from policy; a client that gates on "will I get reasoning?" reads strategy, a client that gates on "can I ask it to reason?" reads capability |
| unknown members | implicit | explicit **floor fallback** (see §3.4) | derivation must be total, not partial |
| `source` | suggested | `"native" \| "combo"` on every combo entry (and provider entries, implicitly native) | lets clients and UI show "derived capability" honestly |
| persistence | n/a | **never persisted** — derived on demand from members + strategy (pure function) | member caps change; snapshots go stale |

---

## 3. Derivation rules

One pure function, shared by server routes and (via the compact `/api/models` payload)
the UI:

```
deriveComboCapabilities(members: Capability[], roles: StrategyShape) -> Capability
```

### 3.1 Modal modalities — union

```js
vision.input  = members.some(m => m.vision?.input)
vision.output = members.some(m => m.vision?.output)
audio.input   = members.some(m => m.audio?.input)
audio.output  = members.some(m => m.audio?.output)
```

Rationale: the combo dispatches to one member per request; anything a member can do,
the combo can do on that request.

### 3.2 Booleans

```js
thinking = members.some(m => m.thinking)          // can think (see §2.2)
agentic  = members.some(m => m.agentic)           // can act autonomously
tools    = members.some(m => m.tools)
```

### 3.3 Limits — minimum

```js
contextWindow = min(members.map(m => m.contextWindow))   // omit if any member is unlimited (null)
maxOutput     = min(members.map(m => m.maxOutput))       // omit if any member is unlimited (null)
```

Rationale: the combo cannot exceed the weakest member. **Rule:** if *any* member has an
unlimited (null/0) limit, omit the field (the combo has no hard ceiling).

### 3.4 Floor for unknown members (total derivation)

Members whose caps are unknown (passthrough, custom, no models.dev data — see the audit's
13 uncapped tokenrouter models) use the **safe floor**:

```js
FLOOR = {
  thinking: false, agentic: false,
  vision: { input: false, output: false },
  audio:  { input: false, output: false },
  tools: false,
  contextWindow: null,   // unknown → treat as unlimited → limit omitted
  maxOutput: null,       // unknown → treat as unlimited → limit omitted
}
```

Unknown members therefore **never enable** a modality they might have, and **never cap**
a limit the combo might support. No overclaiming, no underclaiming.

### 3.5 Strategy-aware fields

- `thinking`: member-derived **unless the strategy forces it**. A combo whose strategy
  requires non-auto thinking (`thinking.type !== "auto"`) but whose members can't think
  is a **config error**; derivation still reports the truth (`thinking: false`) and the
  validator (`/api/combos/validate-roles`) should flag the mismatch (new check).
- `contextWindow`/`maxOutput` are not strategy-dependent.

### 3.6 `source`

Every **combo** entry gets `capabilities.source = "combo"`. Provider models keep the
existing shape (`source` omitted or `"native"`). UI renders combo-derived badges with a
distinct hint (e.g. "derived") so users are never misled into thinking a combo *natively*
supports something — it supports it *through its members*.

---

## 4. Example JSON — per strategy

Common fixtures for all examples:

- `A` = `gpt-5.3` — reasoning, vision.input, tools, ctx 400k, maxOut 128k
- `B` = `claude-opus-4-7` — reasoning, vision.input+output, tools, ctx 1M, maxOut 128k
- `C` = `llama-4-scout` — vision.input, tools, no reasoning, ctx 10M, maxOut 32k

### 4.1 Fusion (parallel panel + judge)

```jsonc
{
  "id": "squad-review",
  "object": "model",
  "owned_by": "combo",
  "kind": "llm",
  "capabilities": {
    "thinking": true,                       // A and B reason
    "agentic": false,                       // judge is not autonomous
    "vision": { "input": true, "output": true },   // B emits images
    "audio":  { "input": false, "output": false },
    "tools": true,                          // A and B
    "contextWindow": 400000,                // min(400k, 1M)
    "maxOutput": 128000,                    // min(128k, 128k)
    "source": "combo"
  },
  "strategy": {
    "fallbackStrategy": "fusion",
    "thinking": { "type": "effort", "effort": "high" },
    "judgeModel": "cc/claude-opus-4-7"
  }
}
```

### 4.2 Swarm (Manager → Staff → Workers)

```jsonc
{
  "id": "deep-swarm",
  "object": "model",
  "owned_by": "combo",
  "kind": "llm",
  "capabilities": {
    "thinking": true,
    "agentic": true,                        // manager orchestrates workers
    "vision": { "input": true, "output": true },
    "audio":  { "input": false, "output": false },
    "tools": true,
    "contextWindow": 400000,                // min over members
    "maxOutput": 128000,
    "source": "combo"
  },
  "strategy": {
    "fallbackStrategy": "swarm",
    "managerModel": "cc/claude-opus-4-7",
    "staffModel": "openai/gpt-5.3",
    "workerCount": 3,
    "thinking": { "type": "extended", "budgetTokens": 16000 }
  }
}
```

### 4.3 Cascade / "chain" (escalate cheap → capable)

> Note: the codebase calls this strategy `cascade` (no `chain` strategy exists).

```jsonc
{
  "id": "cost-optimized-chain",
  "object": "model",
  "owned_by": "combo",
  "kind": "llm",
  "capabilities": {
    "thinking": false,                      // C (the entry stage) cannot reason
    "agentic": false,
    "vision": { "input": true, "output": true },   // A/B/C all take images; B emits
    "audio":  { "input": false, "output": false },
    "tools": true,
    "contextWindow": 400000,                // min(400k, 1M, 10M)
    "maxOutput": 32000,                     // min(128k, 128k, 32k) — weakest link
    "source": "combo"
  },
  "strategy": {
    "fallbackStrategy": "cascade",
    "cascade": { "maxStages": 3, "confidenceThreshold": 70 },   // int 0-100 (comboConfig normalizeCascadeConfig)
    "thinking": { "type": "auto" }
  }
}
```

Note how cascade shows the honest trade-off: cheap entry (`thinking: false` from C) while
the panel still has vision through every stage.

### 4.4 Fallback and Round Robin

```jsonc
{
  "id": "resilient-fallback",
  "object": "model",
  "owned_by": "combo",
  "kind": "llm",
  "capabilities": {
    "thinking": true,
    "agentic": false,
    "vision": { "input": true, "output": true },
    "audio":  { "input": false, "output": false },
    "tools": true,
    "contextWindow": 400000,
    "maxOutput": 32000,
    "source": "combo"
  },
  "strategy": { "fallbackStrategy": "fallback" }
}
```

### 4.5 Combo with an unknown (uncapped) member

```jsonc
// members = [A (full caps), X (passthrough, unknown caps)]
{
  "id": "hybrid",
  "object": "model",
  "owned_by": "combo",
  "kind": "llm",
  "capabilities": {
    "thinking": true,                       // A
    "agentic": false,
    "vision": { "input": true, "output": false },  // A; X contributes nothing (floor)
    "audio":  { "input": false, "output": false },
    "tools": true,                          // A
    "contextWindow": 400000,                // X unknown → unlimited → not a cap
    "maxOutput": 128000,
    "source": "combo"
  }
}
```

---

## 5. Integration plan

1. **Pure derivation** — `open-sse/providers/comboCapabilities.js`:
   `deriveComboCapabilities(members, strategy)` + `FLOOR` + `memberCapsForModel(fullModel)`
   (resolves each combo model via `getCapabilitiesForModel`, alias→id normalized).
   Unit tests for every rule in §3.
2. **Server wiring**
   - `/v1/models` combo branch: replace the strategy-only `{thinking, agentic}` with
     `deriveComboCapabilities(...)` → full shape + `source: "combo"`. Keep
     `strategy.thinking` visible to clients that gate on "will it think" (the merged
     config is already computed there).
   - `/api/models` (compact client payload): emit combo entries with the compact caps
     (same `toClientCaps` shape) so `useModelCaps`/`ComboCard`/`ModelSelectModal` see
     combo caps through the existing hook — no new fetch.
3. **UI** — `ComboCard`: aggregated `CapacityBadges` from the combo's own caps
   (`modelCaps[comboName]`), with a "derived" hint badge when `source === "combo"`.
4. **Validator** — `/api/combos/validate-roles`: warn when strategy requires non-auto
   thinking but derived `thinking` is false.
5. **Quality gate** — extend `model-consistency-gate.test.js`: every combo in `/v1/models`
   must carry `source: "combo"` and its derived caps must equal the pure-function output
   (no drift between route and function).

### Payload budget + shape mapping

Two emission shapes, one derivation:

- **Full shape** (§2.1, with `tools`/`contextWindow`/`maxOutput`) — emitted by
  `/v1/models` for clients like Zcode/Codex/Cline (Cline also reads `context_length`,
  which we set to the derived `contextWindow`).
- **Compact shape** — `/api/models` reuses `toClientCaps` (§5.2). Note `toClientCaps`
  today does **not** carry `contextWindow`/`tools`; if a client surface needs them it
  must be extended explicitly (currently only `maxOutput` is consumed client-side).

Combo caps add one entry per combo with ≤ 12 fields — negligible versus the 1352-model
catalog, and reuse of `toClientCaps` keeps it in the compact shape (see the −28% payload
work already landed).

---

## 6. Out of scope (future)

- `ray_format` normalization across transports (separate concern).
- Per-kind combo catalogs (`/v1/models/image`, `/v1/models/tts`, …) for media combos —
  the derivation rules generalize, but media caps need their own schema first.
- Client-side "capability-based routing" (pick a combo by capability) — becomes trivial
  once the catalog exists, but is a product feature, not this refactor.
