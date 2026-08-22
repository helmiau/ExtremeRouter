# Capability Registry — Research & Provenance

Companion to `open-sse/providers/capabilities.js`. Records what the runtime
believes about each model, where that belief came from, and which entries are
still unverified.

Verified against the tree at `13fbb6a`. Structural invariants are enforced by
`tests/unit/capability-registry-validation.test.js`; resolution behaviour by
`tests/unit/capability-identity-precedence.test.js`.

## Confidence vocabulary

Every resolved capability object carries three provenance fields.

| Field | Values | Meaning |
| --- | --- | --- |
| `sourceType` | see table below | which tier supplied the runtime-critical limits |
| `confidence` | `verified` / `inferred` / `unknown` | how much weight the result carries |
| `known` | boolean | derived: `confidence !== "unknown"` |

| `sourceType` | `confidence` | Origin |
| --- | --- | --- |
| `provider-model` | verified | `PROVIDER_CAPABILITIES[provider][model]` — exact provider + exact model |
| `model-exact` | verified | `MODEL_CAPABILITIES[model]` — canonical exact id |
| `provider-registry` | inferred | `registryLimits.js` — provider catalog, provider + model scoped |
| `family-pattern` | inferred | `PATTERN_CAPABILITIES` — verified family rule applied by glob |
| `default-floor` | unknown | `DEFAULT_CAPABILITIES` — no evidence, a conservative assumption |

`known: true` means **some evidence applied**, not that the data is confirmed.
It spans verified and inferred alike, so a consumer that needs confirmed data
must test `confidence === "verified"`. The boolean exists for consumers that
only need "is this a guess", and it is derived from `confidence` through a single
expression so the two cannot drift apart.

`sourceType` describes the origin of `contextWindow` / `maxOutput` specifically,
because a result can draw features from one tier and limits from another. A
model matching an exact entry whose ceiling is overridden by a provider catalog
reports `provider-registry` / `inferred` — the enforced number came from the
catalog, and claiming `verified` would overstate it. Features from the exact
entry survive; only the provenance label follows the limits.

`toClientCaps` forwards `confidence` when it is not `verified` and `known` when
it is `false`, following the file's omit-defaults convention. An absent field
therefore reads as verified/known, which keeps older cached payloads from
suddenly reporting everything as unknown.

Enforced by `tests/unit/capability-confidence-semantics.test.js` across all 1842
registry models: every result has a recognised `sourceType` and `confidence`,
and `known === (confidence !== "unknown")` holds without exception.

## Resolution precedence

Most specific first. Each tier returns immediately, so no later tier can widen
an earlier one.

```
1. PROVIDER_CAPABILITIES[provider][model]   exact provider + exact model
2. registry limits (registryLimits.js)      provider + model, contextWindow/maxOutput only
3. MODEL_CAPABILITIES[model]                canonical exact id
4. PATTERN_CAPABILITIES                     glob, ordered specific -> generic
5. DEFAULT_CAPABILITIES                     unverified floor, known: false
```

Tier 2 is an overlay rather than a tier of its own: registry entries describe
limits, never features, so they merge onto whichever of tiers 3-5 matched.
They do not override tier 1, which is the same specificity but describes more
fields.

`resolveProviderAlias` normalises the provider before lookup, so `gh` and
`github` reach the same entry. Model ids are matched both whole and with the
vendor prefix stripped, so `anthropic/claude-opus-4.7` and `claude-opus-4.7`
resolve identically.

## Registry-declared limits

Provider registry files carry `contextWindow` / `maxOutput` on individual
models. Those numbers describe the provider's own endpoint and were previously
declared but never read at runtime — Token Budget used family-pattern figures
while `/v1/models/info` displayed the registry field, so the two disagreed for
59 models.

`open-sse/providers/registryLimits.js` builds a `provider -> model -> limits`
table from `REGISTRY` at module load and `getCapabilitiesForModel` overlays it.

Representative corrections, all narrowing the output ceiling:

| Provider / model | Was (pattern) | Now (registry) | Why the registry is more specific |
| --- | --- | --- | --- |
| `github/claude-opus-4.7` | out 128000 | out 64000 | Copilot caps Claude output below Anthropic's own API |
| `github/claude-sonnet-4.6` | out 128000 | out 64000 | same |
| `github/gpt-4o-mini` | out 16384 | out 4096 | Copilot serves a smaller completion cap |
| `qwen-cloud/glm-5.2` | out 128000 | out 16384 | Alibaba's hosted GLM caps output far below Z.ai's |
| `qwen-cloud/deepseek-v4-pro` | ctx 1000000, out 384000 | ctx 163840, out 32768 | hosted variant, not DeepSeek's own endpoint |
| `github/oswe-vscode-prime` | floor 200000/64000 | ctx 264000, out 64000 | matched no pattern at all before |

Two entries widened rather than narrowed, because the registry figure is the
provider's own and the pattern was a family generalisation:
`github/gpt-5.5` (ctx 400000 -> 1050000) and `agnes-api/agnes-2.5-*`
(ctx 200000 -> 1000000 / 524288).

Confidence: **inferred**. These come from provider catalogs synced into the
registry, not from per-model vendor documentation. They are more specific than
the family patterns they replace, which is why they win, but a model-specific
vendor source would outrank them.

## Corrections to self-contradictory entries

Two entries asserted something impossible. Both were found by the new
validation test, not by inspection.

### `orcarouter` `qwen/qwen3.5-27b`

```
was:  contextWindow 32768, maxOutput 65536
now:  contextWindow 32768, maxOutput 32768
```

The output value exceeded the window, so Token Budget received a ceiling the
model could never reach. The 65536 figure matches the `qwen3.8-27b` sibling
(65536/65536) and appears to have been copied when the entry was added in
`325527c`. Clamped to the window pending a model-specific output figure.

Confidence: **inferred**. The window is from the live OrcaRouter model card;
the output figure is a safe clamp, not a documented value.

### `*grok-4.6*` pattern

```
was:  thinkingLevels ["low","medium","high","xhigh"], thinkingMaxEffort true
now:  thinkingLevels ["low","medium","high","xhigh"]
```

`thinkingMaxEffort` gates the `max` option in `ThinkingLevelPicker` and
`ComboCard`, so the pair advertised an effort level absent from the model's own
list. `thinkingLevels` is authoritative for this family; the flag is the
fallback for models that declare no list. The commit that added the entry
(`0746d24`) describes only the four levels, so the flag was the error.

Confidence: **verified** against the entry's own level list — the two fields
cannot both be right, and the list is the more specific statement.

### Resolved-pair clamp

`forge/kimi-k3` combined a registry window of 1000000 with the `*kimi-k3*`
pattern's 1048576 output. Neither declaration is wrong on its own; the merge
produced output above the window. `withLimits` in `capabilities.js` clamps
`maxOutput` to `contextWindow` after overlaying, so every resolved result is
self-consistent regardless of which tiers combined.

## Coverage

1842 registry model entries, 1541 of kind `llm`.

| Tier | Entries resolved |
| --- | --- |
| provider exact (`provider-model`, verified) | 81 |
| model exact (`model-exact`, verified) | 59 |
| pattern (`family-pattern`, inferred) | 1300 |
| floor (`default-floor`, unknown) | 402 total, 140 of them `llm` |

Counts are by matching tier. The reported `sourceType` differs for the models
where a provider catalog overlays the limits — those report
`provider-registry` / `inferred` regardless of which tier supplied their
features.

The 140 unverified LLM models are concentrated in web-scraped and
reverse-engineered providers where no model documentation exists:
`adapta-web`, `copilot-web`, `poe-web`, `pollinations`, `venice-web`,
`muse-spark-web`, `doubao-web`, `t3-web`, `v0-vercel-web`, `veoaifree-web`,
plus opaque aliases such as `cu/default`, `tr/auto`, `qd/qmodel_latest` and
`devin/devin-*`.

These keep the floor's numeric pair deliberately. A null ceiling would mean
"unconstrained" to the Token Budget resolver, which is the unsafe direction; a
conservative 200000/64000 assumption still bounds the request. The
`confidence: "unknown"` / `known: false` pair is what prevents the assumption
from being mistaken for research. A test snapshots the count at 140 and fails if
it grows, so a model can lose evidence only deliberately.

## Wildcards retained

110 patterns remain. They are the mechanism by which ~1300 models get any
capability data at all, so removing them wholesale would move those models to
the unverified floor — worse, not better.

Ordering is specific-to-generic and enforced: the validation test rejects any
pattern whose representative id is already claimed by an earlier entry, so a
new broad pattern inserted above a narrow one fails CI.

Notable scoping decisions already in the file:

| Pattern | Scope reason |
| --- | --- |
| `*claude-*` | requires the dash so `my-claude-finetune` does not match |
| `o1*` / `o3*` / `o4*` | bare ids carry no separator, so `*o1-*` alone missed them |
| `*o1-*` / `*o1_*` | tightened from bare `*o1*`, which matched unrelated ids |
| `tokenrouter:*qwen*` | provider-scoped; that backend rejects effort above medium |
| `*ox-alpha*` before `*x-preview*` | otherwise `stealth/ox-alpha` falls through |

Family membership does not imply shared capability, and the tests assert it:
`glm-4.6v` has vision while `glm-4.6` does not; `grok-4.6`, `grok-4.5` and
`grok-4` each advertise a different level set; `gpt-5.6-sol` differs between
the `codex` and `forge` providers.

## Provider-level output ceilings

Separate from model capability: `open-sse/config/providerOutputLimits.js` holds
hard caps a provider's backend enforces regardless of the model —
`antigravity` 16384, `codex` 128000. Both were previously local constants in
their executors, clamping after the canonical resolution. They now feed
`resolveOutputBudget` as `providerMaxOutput`, and the executor clamps remain as
defence in depth for bodies that bypass `translateRequest()`.

## Token Budget integration

The registry is the data source; `resolveOutputBudget` is the enforcement. That
direction is not reversed anywhere — no capability number was chosen to make a
budget calculation come out a particular way, and Token Budget arithmetic is
unchanged by this pass.

```
capability.maxOutput      -> hardMax candidate (min with provider/router/context)
capability.contextWindow  -> availableContext = contextWindow - input - reserved
```

`tests/unit/capability-identity-precedence.test.js` asserts the wiring: two
models differing only in `maxOutput` produce different effective ceilings; two
differing only in `contextWindow` produce different feasibility verdicts under
the same 300k prompt.

## Frozen baseline

The registry is a frozen baseline as of this document. The contract future work
must preserve:

- `known === (confidence !== "unknown")`, always.
- `sourceType` determines `confidence` through the single `CONFIDENCE_BY_SOURCE`
  mapping, never per entry. Adding a source means deciding its trust level once.
- `verified` is reserved for sources that name the exact model. Family rules and
  provider catalogs are `inferred` no matter how precise their numbers look.
- The default floor is always `unknown`, never promoted by any later tier.
- Precedence stays exact provider+model > provider catalog (limits only) >
  exact model id > family pattern > floor.
- Every resolved limit pair satisfies `maxOutput <= contextWindow`.

Changing any of these is a breaking change to consumers, not a refactor. The
three capability test files fail on violation.

## Known gaps

- The 59 registry limits are provider-catalog sourced, not per-model vendor
  documentation. Better evidence would outrank them, and they are labelled
  `inferred` to say so.
- 140 LLM models have no capability evidence at all. They are enumerated by
  tier in the coverage table and carry `confidence: "unknown"` at runtime.
- `providerMaxOutput` covers two providers. Others may have real backend caps
  that are simply unknown, and unknown means unconstrained at that tier.
- `confidence` describes the limits, not each feature independently. A model
  whose `vision` flag comes from a family rule while its ceiling comes from a
  catalog reports one label for the whole object. Per-field provenance was not
  added because no consumer needs that resolution.
- No `verifiedAt` timestamp. Source notes live in comments beside the entries
  that have them and this document is the aggregate; a per-entry date would grow
  ~1500 entries with nothing reading it.
