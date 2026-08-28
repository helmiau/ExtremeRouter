import { detectFormat, getTargetFormat, resolveTransport, resolveAlternateTransport } from "../services/provider.js";
import { translateRequest } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { normalizeClaudePassthrough, anchorClaudeCache } from "../translator/formats/claude.js";
import { COLORS } from "../utils/stream.js";
import { createStreamController } from "../utils/streamHandler.js";
import { refreshWithRetry } from "../services/tokenRefresh.js";
import { createRequestLogger } from "../utils/requestLogger.js";
import { getModelTargetFormat, getModelStrip, getModelUpstreamId, getModelType, PROVIDER_ID_TO_ALIAS } from "../config/providerModels.js";
import { parseSuffix } from "../translator/concerns/thinkingUnified.js";
import { isCacheable, cacheLookup, cacheStore } from "../services/semanticCache.js";
import { PROVIDERS } from "../config/providers.js";
import { buildChatResult, createErrorResult, parseUpstreamError, formatProviderError } from "../utils/error.js";
import { createCanonicalAttempt } from "../utils/canonicalAttempt.js";
import { classifyCanonicalAttempt } from "../utils/canonicalClassification.js";
import { decideAttemptPolicy } from "../utils/canonicalPolicy.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { handleBypassRequest } from "../utils/bypassHandler.js";
import { trackPendingRequest, appendRequestLog, saveRequestDetail } from "@/lib/usageDb.js";
import { getExecutor } from "../executors/index.js";
import { buildRequestDetail, extractRequestConfig, extractUsageFromResponse, saveUsageStats } from "./chatCore/requestDetail.js";
import { handleForcedSSEToJson } from "./chatCore/sseToJsonHandler.js";
import { handleNonStreamingResponse } from "./chatCore/nonStreamingHandler.js";
import { handleStreamingResponse, buildOnStreamComplete } from "./chatCore/streamingHandler.js";
import { detectClientTool, isNativePassthrough } from "../utils/clientDetector.js";
import { dedupeTools } from "../utils/toolDeduper.js";

const cookieRefreshInProgress = new Set();
import { injectCaveman } from "../rtk/caveman.js";
import { compressWithPxpipe, formatPxpipeLog, formatPxpipeSizeLog, isPxpipePhantomSavings } from "../rtk/pxpipe.js";
import { injectPonytail } from "../rtk/ponytail.js";
import { compressMessages, formatRtkLog } from "../rtk/index.js";
import { compressWithHeadroom, formatHeadroomLog, formatHeadroomSizeLog, formatEffectivePayloadSavings, isHeadroomPhantomSavings, buildHeadroomBytesSample } from "../rtk/headroom.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { stripUnsupportedModalities } from "../translator/concerns/modality.js";
import { prefetchRemoteImages } from "../translator/concerns/prefetch.js";

/**
 * Build a finalized canonical attempt for a provider-failure path that has no
 * normal response body (401/403/429/5xx/502/499). The status is known and a
 * real provider attempt occurred, so source="provider" is honest — we only set
 * evidence we actually have (transport + abort) and leave output evidence false.
 * This lets the G2-C health layer read one policy contract on failures too.
 */
function buildTransportAttempt(status, { abortSeen = false } = {}) {
  const transportOk = Number(status) >= 200 && Number(status) < 300;
  const attempt = {
    source: "provider",
    transportOk,
    streamStarted: null,
    hasText: false,
    hasReasoning: false,
    hasToolCall: false,
    hasStructuredOutput: false,
    hasUsage: false,
    completionState: abortSeen ? "cancelled" : "failure",
    completionType: abortSeen ? null : "http_error",
    terminalState: null,
    terminalType: null,
    finishReason: null,
    eofSeen: null,
    errorSeen: !abortSeen,
    abortSeen: !!abortSeen,
    usableOutput: false,
    logicalSuccess: false,
    outcome: abortSeen ? "cancelled" : "failure",
  };
  const classification = classifyCanonicalAttempt({
    ...attempt,
    responseStatus: status,
  });
  return {
    ...attempt,
    ...classification,
    policy: decideAttemptPolicy({ ...attempt, ...classification }),
  };
}

/**
 * Core chat handler - shared between SSE and Worker
 * @param {object} options.body - Request body
 * @param {object} options.modelInfo - { provider, model }
 * @param {object} options.credentials - Provider credentials
 * @param {string} options.sourceFormatOverride - Override detected source format (e.g. "openai-responses")
 * @returns {Promise<ChatResult>} a single normalized result envelope — every
 *   return path carries an explicit `success` boolean so callers branch on one
 *   contract (see buildChatResult / createErrorResult in utils/error.js).
 */
export async function handleChatCore({ body, modelInfo, credentials, log, onCredentialsRefreshed, onRequestSuccess, onDisconnect, clientRawRequest, connectionId, userAgent, apiKey, ccFilterNaming, rtkEnabled, headroomEnabled, headroomUrl, headroomCompressUserMessages, cavemanEnabled, cavemanLevel, ponytailEnabled, ponytailLevel, sourceFormatOverride, providerThinking, semanticCacheEnabled, semanticCacheThreshold, pxpipeEnabled, pxpipeDir, pxpipeMinChars, pxpipeTimeoutMs, externalSignal, opencodeIdentity, comboContext }) {
  const { provider, model } = modelInfo;
  const requestStartTime = Date.now();

  const sourceFormat = sourceFormatOverride || detectFormat(body);

  // Check for bypass patterns (warmup, skip, cc naming)
  const bypassResponse = handleBypassRequest(body, model, userAgent, ccFilterNaming);
  if (bypassResponse) {
    // G2-C.1: bypass wraps through the canonical factory (source=bypass →
    // synthetic policy → no provider health mutation). No invented stream evidence.
    return { ...bypassResponse, canonicalAttempt: createCanonicalAttempt(null, { source: "bypass" }) };
  }

  // Semantic Cache — check for cached response before executing request.
  // Only applies to non-streaming, tool-free, sufficiently-long requests.
  if (semanticCacheEnabled && isCacheable(body, false, provider, model)) {
    const threshold = typeof semanticCacheThreshold === "number" ? semanticCacheThreshold : 0.85;
    // SECURITY: Partition cache by API key to prevent cross-user leakage
    const cacheIdentity = apiKey || connectionId || "local";
    const cached = cacheLookup(provider, model, body, threshold, cacheIdentity);
    if (cached) {
      log?.info?.("CACHE", `semantic cache ${cached.exact ? "HIT" : "near-hit"} (${(cached.similarity * 100).toFixed(0)}% similarity) — returning cached response`);

      try {
        const forUsage = cached.response.clone ? cached.response.clone() : cached.response;
        const usageBody = await forUsage.json();
        const u = extractUsageFromResponse(usageBody);
        if (u && (u.prompt_tokens > 0 || u.completion_tokens > 0)) {
          const cacheTokensSaved = (u.prompt_tokens || 0) + (u.completion_tokens || 0);
          saveUsageStats({
            provider, model, tokens: u,
            connectionId, apiKey,
            endpoint: clientRawRequest?.endpoint || null,
            latency: { ttft: 0, total: Date.now() - requestStartTime },
            savedTokens: cacheTokensSaved,
            savedTokensByMechanism: { cache: cacheTokensSaved },
            fromCache: true,
            label: "CACHE",
          });
        }
      } catch { /* non-fatal: return the cached response without savings */ }

      const cachedResponse = cached.response.clone ? cached.response.clone() : cached.response;
      // G2-C.1: cache canonical attempt built through the single factory —
      // policy computed once, no duplicated decideAttemptPolicy, no invented
      // stream/content evidence (source=cache carries the synthetic provenance).
      const canonicalAttempt = createCanonicalAttempt(null, { status: cachedResponse.status || 200, source: "cache" });
      return buildChatResult({ success: true, response: cachedResponse, url: "(cache)", headers: {}, transformedBody: body, fromCache: true, cacheSimilarity: cached.similarity, canonicalAttempt });
    }
  }

  const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  const modelTargetFormat = getModelTargetFormat(alias, model);
  const runtimeTransport = resolveTransport(provider, sourceFormat);
  const targetFormat = modelTargetFormat || runtimeTransport?.format || getTargetFormat(provider);
  if (runtimeTransport && credentials) credentials.runtimeTransport = runtimeTransport;
  const stripList = getModelStrip(alias, model);
  const { cleanModel: cleanModelForUpstream } = parseSuffix(model);
  const upstreamModel = getModelUpstreamId(alias, cleanModelForUpstream);

  // Thinking override. Two shapes funnel here:
  //   • provider-level   { mode: "on"|"off"|"low"|"high"|… }  (settings page dropdown)
  //   • combo-level      { type: "off"|"auto"|"effort"|"extended", effort?, budgetTokens? }
  //                       (ComboCard thinking picker — see combo config screen)
  const t = providerThinking;
  if (t?.type) {
    if (t.type === "off" && !body.thinking) {
      body = { ...body, thinking: { type: "disabled" } };
    } else if (t.type === "extended" && !body.thinking) {
      const budget = Number(t.budgetTokens) || 10000;
      body = { ...body, thinking: { type: "enabled", budget_tokens: budget } };
    } else if (t.type === "effort" && !body.reasoning_effort) {
      body = { ...body, reasoning_effort: t.effort || "high" };
    }
  } else if (t?.mode && t.mode !== "auto") {
    const mode = t.mode;
    if (mode === "on" && !body.thinking) {
      console.log("Injecting provider-level thinking config override: on");
      body = { ...body, thinking: { type: "enabled", budget_tokens: 10000 } };
    } else if (mode === "off" && !body.thinking) {
      body = { ...body, thinking: { type: "disabled" } };
    } else if (!body.reasoning_effort) {
      body = { ...body, reasoning_effort: mode };
    }
  }

  const clientRequestedStreaming = body.stream === true || sourceFormat === FORMATS.ANTIGRAVITY || sourceFormat === FORMATS.GEMINI || sourceFormat === FORMATS.GEMINI_CLI;
  const providerRequiresStreaming = PROVIDERS[provider]?.forceStream === true;
  let stream = providerRequiresStreaming ? true : (body.stream !== false);

  // Image generation models require non-streaming (Google v1internal:generateContent)
  const modelType = getModelType(alias, model);
  const isImageGenModel = modelType === "imageGen" || /image|imagen|image-generation/i.test(model);
  if (isImageGenModel && (provider === "antigravity" || provider === "gemini-cli")) {
    stream = false;
  }

  // DeepSeek-TUI: interactive TUI panel sends stream:true and needs SSE.
  // Non-interactive mode (-p flag) sends without stream and can't parse SSE.
  // Only force non-streaming when client didn't explicitly request it.
  const detectedTool = detectClientTool(clientRawRequest?.headers || {}, body);
  if (detectedTool === "deepseek-tui" && body.stream !== true) stream = false;

  // Check client Accept header preference for non-streaming requests
  // This fixes AI SDK compatibility where clients send Accept: application/json
  const acceptHeader = clientRawRequest?.headers?.accept || "";
  const clientPrefersJson = acceptHeader.includes("application/json");
  const clientPrefersSSE = acceptHeader.includes("text/event-stream");
  if (clientPrefersJson && !clientPrefersSSE && body.stream !== true && !providerRequiresStreaming) {
    stream = false;
  }

  // Sync the resolved stream flag back into the request body. Providers with
  // forceStream (cline, openai, codex, codebuddy-cn) are resolved to stream=true
  // above, but body.stream may still carry the client's `false` — upstream then
  // sees a non-streaming request and can reject it (Cline returns
  // "empty response content" for stream:false). Overwrite so the body matches
  // what the executor actually sends. stream_options injected by the executor
  // only appears when stream=true, so no conflict here.
  if (body && typeof body === "object") {
    body.stream = stream;
  }

  const reqLogger = await createRequestLogger(sourceFormat, targetFormat, model);
  if (clientRawRequest) reqLogger.logClientRawRequest(clientRawRequest.endpoint, clientRawRequest.body, clientRawRequest.headers);
  reqLogger.logRawRequest(body);
  log?.debug?.("FORMAT", `${sourceFormat} → ${targetFormat} | stream=${stream}`);

  // Native passthrough: CLI tool and provider are the same ecosystem
  // Skip all translation/normalization — only model and Bearer are swapped
  const clientTool = detectClientTool(clientRawRequest?.headers || {}, body);
  const passthrough = isNativePassthrough(clientTool, provider);

  // Expose raw client headers to translators/executors for session-id resolution
  if (credentials) credentials.rawHeaders = clientRawRequest?.headers || {};

  // Auto-strip media blocks the model can't read (vision/audio/pdf) before translation.
  if (!passthrough) {
    const caps = getCapabilitiesForModel(provider, model);
    if (stripUnsupportedModalities(body, sourceFormat, caps)) {
      log?.debug?.("MODALITY", `stripped unsupported media for ${provider}/${model}`);
    }
    // Convert remote image URLs to base64 for targets that can't fetch URLs.
    try {
      // C4 FIX: Pass a real abort signal with timeout (not undefined) to prevent
      // indefinite hangs on slow/unresponsive image hosts. SSRF guard is applied
      // inside fetchImageAsBase64 via resolvePinnedIps which validates resolved IPs.
      const imgCtrl = new AbortController();
      const imgTimer = setTimeout(() => imgCtrl.abort(), 10_000); // 10s max per prefetch
      const n = await prefetchRemoteImages(body, sourceFormat, targetFormat, { signal: imgCtrl.signal, timeoutMs: 10_000 });
      clearTimeout(imgTimer);
      if (n > 0) log?.debug?.("MODALITY", `prefetched ${n} remote image(s) for ${targetFormat}`);
    } catch (e) { log?.warn?.("MODALITY", `image prefetch failed: ${e.message}`); }
  }

  let translatedBody;
  let toolNameMap;
  if (passthrough) {
    log?.debug?.("PASSTHROUGH", `${clientTool} → ${provider} | native lossless`);
    translatedBody = { ...body, model: upstreamModel };
    // Normalize newer Cowork/CC beta shapes (adaptive thinking, mid-conversation system) the API rejects
    if (clientTool === "claude") normalizeClaudePassthrough(translatedBody, upstreamModel);
  } else {
    // C2 FIX: Pass the original `model` (WITH thinking suffix like "(high)") to
    // translateRequest so applyThinking's parseSuffix can extract the override.
    // The body.model is overwritten with the stripped upstreamModel on line 156
    // AFTER translation, so the suffix never leaks to the upstream provider.
    translatedBody = translateRequest(sourceFormat, targetFormat, model, body, stream, credentials, provider, reqLogger, stripList, connectionId, clientTool);
    if (!translatedBody) {
      trackPendingRequest(model, provider, connectionId, false, true);
      return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Failed to translate request for ${sourceFormat} → ${targetFormat}`);
    }
    toolNameMap = translatedBody._toolNameMap;
    delete translatedBody._toolNameMap;
    translatedBody.model = upstreamModel;
  }

  // Dedupe duplicate built-in tools when equivalent MCP tools are present (Claude clients only).
  if (clientTool === "claude" && Array.isArray(translatedBody.tools)) {
    const { tools: deduped, stripped } = dedupeTools(translatedBody.tools);
    if (stripped.length > 0) {
      translatedBody.tools = deduped;
      log?.debug?.("TOOLDEDUP", `stripped ${stripped.length}: ${stripped.slice(0, 3).join(", ")}${stripped.length > 3 ? "..." : ""}`);
    }
  }

  // Token savers: applied at the final body just before dispatch
  // Covers both passthrough (source shape) and translated (target shape) flows
  const finalFormat = passthrough ? sourceFormat : targetFormat;

  // TTS models don't support tool messages/function calling
  if (getModelType(alias, model) === "tts" && translatedBody.messages) {
    translatedBody.messages = translatedBody.messages.filter(msg => msg.role !== "tool");
    delete translatedBody.tools;
  }

  // RTK: compress tool_result content
  const rtkStats = compressMessages(translatedBody, rtkEnabled);
  const rtkLine = formatRtkLog(rtkStats);
  if (rtkLine) console.log(rtkLine);

  // Headroom: optional external proxy compression; fail open if proxy is absent.
  const headroomDiagnostics = {};
  const headroomStats = await compressWithHeadroom(translatedBody, { enabled: headroomEnabled, url: headroomUrl, model: upstreamModel, format: finalFormat, compressUserMessages: headroomCompressUserMessages, diagnostics: headroomDiagnostics });
  const headroomLine = formatHeadroomLog(headroomStats);
  const headroomSizeLine = formatHeadroomSizeLog(headroomDiagnostics);
  const headroomEffectiveLine = formatEffectivePayloadSavings(headroomDiagnostics);
  if (headroomLine) {
    log?.info?.("HEADROOM", `${headroomLine}${headroomSizeLine ? ` | ${headroomSizeLine}` : ""}${headroomEffectiveLine ? ` | ${headroomEffectiveLine}` : ""}`);
    if (isHeadroomPhantomSavings(headroomStats, headroomDiagnostics)) {
      log?.warn?.("HEADROOM", `reported token delta, but outbound JSON shrank <5%; provider may bill near-original payload | ${headroomSizeLine}`);
    }
  } else if (headroomEnabled) log?.warn?.("HEADROOM", `skipped: ${headroomDiagnostics.reason || "compression unavailable"}${headroomDiagnostics.endpoint ? ` (${headroomDiagnostics.endpoint})` : ""}`);

  // Caveman: inject terse-style system prompt
  if (cavemanEnabled && cavemanLevel) {
    injectCaveman(translatedBody, finalFormat, cavemanLevel);
    log?.debug?.("CAVEMAN", `${cavemanLevel} | ${finalFormat}`);
  }

  // Ponytail: inject lazy-senior-dev system prompt
  if (ponytailEnabled && ponytailLevel) {
    injectPonytail(translatedBody, finalFormat, ponytailLevel);
    log?.debug?.("PONYTAIL", `${ponytailLevel} | ${finalFormat}`);
  }

  // Pxpipe: multimodal prompt compression — render dense Claude bodies as PNGs.
  // Runs after Caveman/Ponytail so it compresses the final body including injected prompts.
  // Only applies to Claude format; fail-open on any error.
  const pxpipeDiagnostics = {};
  const pxpipeStats = await compressWithPxpipe(translatedBody, {
    enabled: pxpipeEnabled && finalFormat === "claude",
    pxpipeDir,
    minChars: pxpipeMinChars,
    timeoutMs: pxpipeTimeoutMs,
    diagnostics: pxpipeDiagnostics,
  });
  const pxpipeLine = formatPxpipeLog(pxpipeStats);
  const pxpipeSizeLine = formatPxpipeSizeLog(pxpipeDiagnostics);
  if (pxpipeLine) {
    log?.info?.("PXPIPE", `${pxpipeLine}${pxpipeSizeLine ? ` | ${pxpipeSizeLine}` : ""}`);
    if (isPxpipePhantomSavings(pxpipeStats, pxpipeDiagnostics)) {
      log?.warn?.("PXPIPE", `reported token delta, but body barely shrank | ${pxpipeSizeLine}`);
    }
  } else if (pxpipeEnabled && finalFormat === "claude") {
    log?.warn?.("PXPIPE", `skipped: ${pxpipeDiagnostics.reason || "unavailable"}`);
  }

  // Compute total tokens saved by RTK + Headroom + Pxpipe for this request.
  // Caveman/Ponytail savings are estimated later in the response handlers
  // (once completion_tokens are known) from a per-model moving-average baseline.
  const rtkBytesSaved = rtkStats ? (rtkStats.bytesBefore || 0) - (rtkStats.bytesAfter || 0) : 0;
  const rtkTokensSaved = Math.round(rtkBytesSaved / 4);
  const headroomTokensSaved = headroomStats?.tokens_saved || 0;
  const pxpipeTokensSaved = pxpipeStats?.tokensSaved || 0;
  const savedTokens = rtkTokensSaved + headroomTokensSaved + pxpipeTokensSaved;

  // Per-mechanism breakdown for the prompt-side savers (cache handled separately
  // on the HIT path). Caveman/Ponytail are appended by the response handlers.
  const savedTokensByMechanism = {};
  if (rtkTokensSaved > 0) savedTokensByMechanism.rtk = rtkTokensSaved;
  if (headroomTokensSaved > 0) savedTokensByMechanism.headroom = headroomTokensSaved;
  if (pxpipeTokensSaved > 0) savedTokensByMechanism.pxpipe = pxpipeTokensSaved;

  // Byte-level effective payload savings (Headroom). Independent of token
  // deltas — measures actual outbound JSON shrink, with tool schema/history
  // broken out. Flows through saveUsageStats like the token breakdown.
  const savedBytesByMechanism = {};
  const headroomBytesSample = buildHeadroomBytesSample(headroomDiagnostics);
  if (headroomBytesSample) savedBytesByMechanism.headroom = headroomBytesSample;

  // Pin cache breakpoints to the final body — every saver above can reshape
  // system/tools/messages, and a stale anchor costs a full prefix rewrite.
  if (passthrough && clientTool === "claude") anchorClaudeCache(translatedBody);

  const executor = getExecutor(provider);
  trackPendingRequest(model, provider, connectionId, true);
  appendRequestLog({ model, provider, connectionId, status: "PENDING" }).catch(() => { });

  const msgCount = translatedBody.messages?.length || translatedBody.input?.length || translatedBody.contents?.length || translatedBody.request?.contents?.length || 0;
  log?.debug?.("REQUEST", `${provider.toUpperCase()} | ${model} | ${msgCount} msgs`);

  const streamController = createStreamController({
    onDisconnect: (reason) => {
      trackPendingRequest(model, provider, connectionId, false);
      if (onDisconnect) onDisconnect(reason);
    },
    onError: () => trackPendingRequest(model, provider, connectionId, false),
    log, provider, model
  });

  // CS-02: wire the run-level abort signal so external cancellation (quorum
  // grace expiry, hard timeout, client disconnect) aborts the provider call.
  if (externalSignal) {
    if (externalSignal.aborted) {
      streamController.abort();
    } else {
      externalSignal.addEventListener("abort", () => streamController.abort(), { once: true });
    }
  }

  const proxyOptions = {
    connectionProxyEnabled: credentials?.providerSpecificData?.connectionProxyEnabled === true,
    connectionProxyUrl: credentials?.providerSpecificData?.connectionProxyUrl || "",
    connectionNoProxy: credentials?.providerSpecificData?.connectionNoProxy || "",
    vercelRelayUrl: credentials?.providerSpecificData?.vercelRelayUrl || "",
  };

  if (proxyOptions.vercelRelayUrl) {
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    const poolId = credentials?.providerSpecificData?.connectionProxyPoolId || "none";
    log?.info?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | pool=${poolId} | vercel-relay=${proxyOptions.vercelRelayUrl}`);
  } else if (proxyOptions.connectionProxyEnabled && proxyOptions.connectionProxyUrl) {
    let maskedProxyUrl = proxyOptions.connectionProxyUrl;
    try {
      const parsed = new URL(proxyOptions.connectionProxyUrl);
      const host = parsed.hostname || "";
      const port = parsed.port ? `:${parsed.port}` : "";
      const protocol = parsed.protocol || "http:";
      maskedProxyUrl = `${protocol}//${host}${port}`;
    } catch {
      // Keep raw if URL parsing fails
    }

    const poolId = credentials?.providerSpecificData?.connectionProxyPoolId || "none";
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    log?.info?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | pool=${poolId} | url=${maskedProxyUrl}`);
  }

  if (proxyOptions.connectionProxyEnabled && proxyOptions.connectionNoProxy) {
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    log?.debug?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | no_proxy=${proxyOptions.connectionNoProxy}`);
  }

  // Execute request
  let providerResponse, providerUrl, providerHeaders, finalBody, executorRetryCount = 0;
  let triedAlternateTransport = false;

  // Cross-transport fallback helper: if the primary endpoint (matched by
  // sourceFormat) fails with a qualifying error (timeout/5xx/network), try the
  // alternate endpoint (e.g. OpenAI → Claude or vice versa). The body is
  // re-translated to the alternate format before retry. Exactly-once.
  const tryAlternateTransport = async (failReason) => {
    if (triedAlternateTransport) return false;
    // H1 FIX: Bail if the client already disconnected — don't waste time on
    // an alternate attempt whose signal will immediately abort.
    if (streamController.signal?.aborted) return false;
    const altTransport = resolveAlternateTransport(provider, runtimeTransport?.format || targetFormat);
    if (!altTransport) return false;

    triedAlternateTransport = true;
    log?.warn?.("TRANSPORT", `${provider.toUpperCase()} | primary ${runtimeTransport?.format || targetFormat} failed (${failReason}), retrying via alternate ${altTransport.format}`);

    // Re-translate body to the alternate format. Use the ORIGINAL body (pre-
    // translation) so the translator starts from the client sourceFormat.
    const altTargetFormat = altTransport.format;
    let altTranslatedBody = translatedBody;
    if (altTargetFormat !== targetFormat && altTargetFormat !== sourceFormat) {
      altTranslatedBody = translateRequest(sourceFormat, altTargetFormat, model, body, stream, credentials, provider, reqLogger, stripList, connectionId, clientTool);
      if (!altTranslatedBody) return false;
      delete altTranslatedBody._toolNameMap;
      altTranslatedBody.model = upstreamModel;
    }

    // Save original transport so we can restore it if the alternate fails
    // (prevents the 401-retry path from using the alternate transport with a
    // primary-format body).
    const originalTransport = credentials.runtimeTransport;

    // Set the alternate transport on credentials so the executor uses the
    // alternate URL + auth headers automatically.
    credentials.runtimeTransport = altTransport;

    // H1 FIX: Create a fresh AbortController for the alternate attempt. The
    // primary attempt's signal may have been aborted by the stall watchdog or
    // client disconnect, which would cause the alternate fetch to fail
    // instantly with AbortError for the wrong reason.
    const altController = new AbortController();
    // Forward client aborts to the alternate controller, but don't inherit
    // any prior abort state from the primary's stall/disconnect handling.
    if (streamController.signal) {
      streamController.signal.addEventListener("abort", () => altController.abort(), { once: true });
    }

    try {
      const altResult = await executor.execute({ model, body: altTranslatedBody, stream, credentials, signal: altController.signal, log, proxyOptions, opencodeIdentity });
      if (altResult.response?.ok) {
        providerResponse = altResult.response;
        providerUrl = altResult.url;
        providerHeaders = altResult.headers;
        finalBody = altResult.transformedBody;
        executorRetryCount += altResult.retryCount || 0;
        return true;
      } else {
        // M1 FIX: Log the alternate's failure status so operators can debug
        // "both endpoints down" scenarios instead of seeing only the primary error.
        log?.warn?.("TRANSPORT", `${provider.toUpperCase()} | alternate ${altTransport.format} also failed (HTTP ${altResult.response.status})`);
        // Restore original transport so downstream retry paths use the correct endpoint.
        credentials.runtimeTransport = originalTransport;
      }
    } catch (altErr) {
      // M1 FIX: Log the alternate's exception instead of swallowing it silently.
      log?.warn?.("TRANSPORT", `${provider.toUpperCase()} | alternate ${altTransport.format} threw: ${altErr?.message || altErr}`);
      // Restore original transport so downstream retry paths use the correct endpoint.
      credentials.runtimeTransport = originalTransport;
    }
    return false;
  };

  try {
    const result = await executor.execute({ model, body: translatedBody, stream, credentials, signal: streamController.signal, log, proxyOptions, opencodeIdentity });
    providerResponse = result.response;
    providerUrl = result.url;
    providerHeaders = result.headers;
    finalBody = result.transformedBody;
    executorRetryCount = result.retryCount || 0;

    if (result.refreshedCookie && credentials?.connectionId) {
      const connId = credentials.connectionId;
      if (!cookieRefreshInProgress.has(connId)) {
        cookieRefreshInProgress.add(connId);
        try {
          const { updateProviderConnection } = await import("@/lib/localDb");
          await updateProviderConnection(connId, { apiKey: result.refreshedCookie });
          log?.debug?.("COOKIE-REFRESH", `${provider} | auto-refreshed session cookie for ${connId.slice(0, 8)}`);
        } catch { /* non-fatal — next request will try again */ }
        finally { cookieRefreshInProgress.delete(connId); }
      }
    }

    reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody);

    // Semantic Cache — store successful non-streaming response for future lookups.
    if (semanticCacheEnabled && !stream && providerResponse?.ok && isCacheable(body, false, provider, model)) {
      try {
        const cloned = providerResponse.clone ? providerResponse.clone() : providerResponse;
        const cacheIdentity = apiKey || connectionId || "local";
        cacheStore(provider, model, body, cloned, undefined, cacheIdentity);
      } catch { /* fail-open: cache write failure should never break a request */ }
    }
  } catch (error) {
    trackPendingRequest(model, provider, connectionId, false, true);

    if (error.name === "AbortError") {
      streamController.handleError(error);
      return createErrorResult(499, "Request aborted", undefined, { canonicalAttempt: buildTransportAttempt(499, { abortSeen: true }), retryCount: executorRetryCount });
    }

    // Cross-transport fallback: network error or timeout → try alternate endpoint.
    const recovered = await tryAlternateTransport(`network error: ${error.message || error}`);
    if (recovered) {
      reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody);
    } else {
      appendRequestLog({ model, provider, connectionId, status: `FAILED ${error.name === "AbortError" ? 499 : HTTP_STATUS.BAD_GATEWAY}` }).catch(() => { });
      saveRequestDetail(buildRequestDetail({
        provider, model, connectionId,
        latency: { ttft: 0, total: Date.now() - requestStartTime },
        tokens: { prompt_tokens: 0, completion_tokens: 0 },
        request: extractRequestConfig(body, stream),
        providerRequest: translatedBody || null,
        response: { error: error.message || String(error), status: error.name === "AbortError" ? 499 : 502, thinking: null },
        status: "error",
        combo: comboContext
      })).catch(() => { });

      const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY);
      console.log(`${COLORS.red}[ERROR] ${errMsg}${COLORS.reset}`);
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg, undefined, { canonicalAttempt: buildTransportAttempt(502), retryCount: executorRetryCount });
    }
  }

  // Handle 401/403 - try token refresh (skip for noAuth providers)
  if (!executor.noAuth && (providerResponse.status === HTTP_STATUS.UNAUTHORIZED || providerResponse.status === HTTP_STATUS.FORBIDDEN)) {
    try {
      const newCredentials = await refreshWithRetry(() => executor.refreshCredentials(credentials, log), 3, log);
      if (newCredentials?.accessToken || newCredentials?.copilotToken) {
        log?.info?.("TOKEN", `${provider.toUpperCase()} | refreshed`);
        Object.assign(credentials, newCredentials);
        if (onCredentialsRefreshed) {
          try { await onCredentialsRefreshed(newCredentials); } catch (e) { log?.warn?.("TOKEN", `onCredentialsRefreshed failed: ${e.message}`); }
        }
        try {
          const retryResult = await executor.execute({ model, body: translatedBody, stream, credentials, signal: streamController.signal, log, proxyOptions, opencodeIdentity });
          if (retryResult.response.ok) { providerResponse = retryResult.response; providerUrl = retryResult.url; }
        } catch { log?.warn?.("TOKEN", `${provider.toUpperCase()} | retry after refresh failed`); }
      } else {
        log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh failed`);
      }
    } catch (e) {
      log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh threw: ${e.message}`);
    }
  }

  // Provider returned error
  if (!providerResponse.ok) {
    const { statusCode, message, resetsAtMs } = await parseUpstreamError(providerResponse, executor);

    // Cross-transport fallback: 5xx and timeout-status errors qualify. 4xx
    // client errors (400/401/403/404) do NOT — they indicate the request is
    // wrong, not the endpoint.
    if (statusCode >= 500 || statusCode === 0) {
      const recovered = await tryAlternateTransport(`HTTP ${statusCode}: ${message}`);
      if (recovered) {
        reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody);
        // Skip the error block below — providerResponse is now the alternate's
        // successful response. Fall through to the success path.
      } else {
        trackPendingRequest(model, provider, connectionId, false, true);
        appendRequestLog({ model, provider, connectionId, status: `FAILED ${statusCode}` }).catch(() => { });
        saveRequestDetail(buildRequestDetail({
          provider, model, connectionId,
          latency: { ttft: 0, total: Date.now() - requestStartTime },
          tokens: { prompt_tokens: 0, completion_tokens: 0 },
          request: extractRequestConfig(body, stream),
          providerRequest: finalBody || translatedBody || null,
          response: { error: message, status: statusCode, thinking: null },
          status: "error",
          combo: comboContext
        })).catch(() => { });

        const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
        console.log(`${COLORS.red}[ERROR] ${errMsg}${COLORS.reset}`);
        reqLogger.logError(new Error(message), finalBody || translatedBody);
        return createErrorResult(statusCode, errMsg, resetsAtMs, { canonicalAttempt: buildTransportAttempt(statusCode), retryCount: executorRetryCount });
      }
    } else {
      // 4xx — no transport fallback, return error immediately.
      trackPendingRequest(model, provider, connectionId, false, true);
      appendRequestLog({ model, provider, connectionId, status: `FAILED ${statusCode}` }).catch(() => { });
      saveRequestDetail(buildRequestDetail({
        provider, model, connectionId,
        latency: { ttft: 0, total: Date.now() - requestStartTime },
        tokens: { prompt_tokens: 0, completion_tokens: 0 },
        request: extractRequestConfig(body, stream),
        providerRequest: finalBody || translatedBody || null,
        response: { error: message, status: statusCode, thinking: null },
        status: "error",
        combo: comboContext
      })).catch(() => { });

      const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
      console.log(`${COLORS.red}[ERROR] ${errMsg}${COLORS.reset}`);
      reqLogger.logError(new Error(message), finalBody || translatedBody);
      return createErrorResult(statusCode, errMsg, resetsAtMs, { canonicalAttempt: buildTransportAttempt(statusCode), retryCount: executorRetryCount });
    }
  }

  const sharedCtx = {
    provider, model, body, stream, translatedBody, finalBody, requestStartTime,
    connectionId, apiKey, clientRawRequest, onRequestSuccess, savedTokens,
    savedTokensByMechanism, savedBytesByMechanism,
    cavemanActive: !!cavemanEnabled, ponytailActive: !!ponytailEnabled,
    retryCount: executorRetryCount,
    combo: comboContext,
  };
  const appendLog = (extra) => appendRequestLog({ model, provider, connectionId, ...extra }).catch(() => { });
  const trackDone = () => trackPendingRequest(model, provider, connectionId, false);

  // Forced SSE→JSON: adapter returns its own ChatResult envelope.
  if (!clientRequestedStreaming && providerRequiresStreaming) {
    const result = await handleForcedSSEToJson({ ...sharedCtx, providerResponse, sourceFormat, trackDone, appendLog });
    if (result) {
      // G2-D.2: executor transport retries ride the envelope (shared retry
      // accounting with the semantic retry gate). Adapters keep their shape.
      if (result?.retryCount == null) result.retryCount = executorRetryCount;
      streamController.handleComplete();
      return result;
    }
  }

  // True non-streaming response
  if (!stream) {
    const result = await handleNonStreamingResponse({ ...sharedCtx, providerResponse, sourceFormat, targetFormat, reqLogger, toolNameMap, trackDone, appendLog });
    // G2-D.2: executor transport retries ride the envelope (shared retry
    // accounting with the semantic retry gate). Adapters keep their own shape.
    if (result?.retryCount == null) result.retryCount = executorRetryCount;
    streamController.handleComplete();
    return result;
  }

  // Streaming response
  const { onStreamComplete, streamDetailId } = buildOnStreamComplete({ ...sharedCtx });
  return handleStreamingResponse({ ...sharedCtx, providerResponse, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, streamController, onStreamComplete, streamDetailId });
}

export function isTokenExpiringSoon(expiresAt, bufferMs = 5 * 60 * 1000) {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() - Date.now() < bufferMs;
}
