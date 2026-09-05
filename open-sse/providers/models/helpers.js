// Codex auto-generates a "-review" variant for each llm model (review quota family)
export const CODEX_REVIEW_SUFFIX = "-review";

export function withCodexReviewModels(models) {
  return models.flatMap((model) => {
    if ((model.kind || model.type || "llm") !== "llm" || model.id.endsWith(CODEX_REVIEW_SUFFIX)) {
      return [model];
    }
    return [
      model,
      {
        ...model,
        id: `${model.id}${CODEX_REVIEW_SUFFIX}`,
        name: `${model.name} Review`,
        upstreamModelId: model.upstreamModelId || model.id,
        quotaFamily: "review"
      }
    ];
  });
}

// True for any Muse Spark model id (e.g. muse-spark-1.2 / muse-spark-1.3-contributor-free /
// oc/muse-spark-1.2-contributor-free). Used to route every Muse Spark model on the
// OpenCode Free provider to the Responses API (/zen/v1/responses) — chat/completions
// 500s for these (verified live). Strips a trailing parenthesized tier preset and a
// vendor prefix before matching, so both registry ids and passthrough discoveries match.
export function isMuseSparkModel(modelId) {
  if (!modelId || typeof modelId !== "string") return false;
  const clean = modelId.replace(/\([^()]+\)\s*$/, "").trim();
  const base = clean.includes("/") ? clean.split("/").pop() : clean;
  return /^muse[-_]?spark(?:$|[-_:.\s])/i.test(base);
}
