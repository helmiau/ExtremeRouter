# Capability Registry — Research & Provenance

Companion to `open-sse/providers/capabilities.js`. Records what the runtime
believes about each model, where that belief came from, and which entries are
still unverified.

Verified against the tree at `13fbb6a`. Structural invariants are enforced by
`tests/unit/capability-registry-validation.test.js`; resolution behaviour by
`tests/unit/capability-identity-precedence.test.js`.

## Confidence vocabulary

| Term | Meaning |
| --- | --- |
| verified | provider or vendor documentation names this model and this value |
| inferred | derived from a family sibling or a provider catalog listing, not a model-specific source |
| unverified | no model-specific evidence; the result carries `known: false` and rests on `DEFAULT_CAPABILITIES` |

`known` is part of the resolved capability object. It is `true` when the result
came from a provider entry, an exact model entry, a family pattern, or a
registry-declared limit; `false` only when nothing but the floor applied.
`toClientCaps` forwards `known: false` to the dashboard and omits the key when
verified, so a fallback can never be displayed as a model fact.

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
| provider exact | 81 |
| model exact | 59 |
| pattern | 1300 |
| floor (`known: false`) | 402 total, 140 of them `llm` |

The 140 unverified LLM models are concentrated in web-scraped and
reverse-engineered providers where no model documentation exists:
`adapta-web`, `copilot-web`, `poe-web`, `pollinations`, `venice-web`,
`muse-spark-web`, `doubao-web`, `t3-web`, `v0-vercel-web`, `veoaifree-web`,
plus opaque aliases such as `cu/default`, `tr/auto`, `qd/qmodel_latest` and
`devin/devin-*`.

These keep the floor's numeric pair deliberately. A null ceiling would mean
"unconstrained" to the Token Budget resolver, which is the unsafe direction; a
conservative 200000/64000 assumption still bounds the request. The `known: false`
flag is what prevents the assumption from being mistaken for research.

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

## Known gaps

- The 59 registry limits are provider-catalog sourced, not per-model vendor
  documentation. Better evidence would outrank them.
- 140 LLM models have no capability evidence at all. They are enumerated by
  tier in the coverage table and flagged at runtime via `known: false`.
- `providerMaxOutput` covers two providers. Others may have real backend caps
  that are simply unknown, and unknown means unconstrained at that tier.
- No provenance is recorded per entry inside `capabilities.js`. Source notes
  live in comments beside the entries that have them; this document is the
  aggregate view. A structured `verifiedAt` field was not added because nothing
  consumes it and it would grow every entry.
