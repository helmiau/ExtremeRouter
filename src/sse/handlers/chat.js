import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { cacheClaudeHeaders } from "open-sse/utils/claudeHeaderCache.js";
import { readBodyWithLimit } from "../utils/bodyLimiter.js";
import { checkRateLimit, evictExpiredBuckets, DEFAULT_BURST } from "../utils/rateLimiter.js";
import { getSettings, getApiKeyByKey, getComboByName } from "@/lib/localDb";
import { assertModelAllowed } from "../utils/modelAccess.js";
import { getModelInfo } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { resolveOpenCodeIdentity } from "open-sse/utils/openCodeIdentity.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getPxpipeDir } from "@/lib/pxpipe/manager.js";
import { errorResponse, unavailableResponse, chatResultFromErrorResponse } from "open-sse/utils/error.js";
import { handleComboChat, handleFusionChat, handleSwarmChat, handleCascadeChat, handleSmartRoutingChat, detectRequiredCapabilities, applyCapabilityAdapter, DEFAULT_CAPABILITY_FALLBACK_MODEL } from "open-sse/services/combo.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { recordBreakerSuccess, recordBreakerFailure, isRetryableFailure, releaseBreakerProbe, breakerKey } from "open-sse/services/circuitBreaker.js";
import { recordHealthSample } from "open-sse/services/healthMonitor.js";
import { buildComboExecutionGraph, authorizeComboExecution, resolveComboStrategyConfig } from "../services/comboExecutionPolicy.js";
import { acquireComboAdmission, wrapResponseWithAdmission } from "../services/comboAdmission.js";
import { createComboBudget } from "open-sse/services/comboBudget.js";

/**
 * P0 (combos): single gated path for dispatching a combo by name. Both the
 * top-level request handler and the single-model fallback route through here so
 * EVERY combo fan-out is subject to:
 *   1. per-key model ACL (authorizeComboExecution),
 *   2. per-key logical-call rate limit charge for the expansion,
 *   3. combo budget (cost/output-char caps),
 *   4. combo admission (concurrency semaphore).
 *
 * Returns the final Response when `modelStr` is a combo, or `null` when it is
 * not (so callers fall through to normal single-model handling).
 */
async function dispatchComboByName(modelStr, { body, clientRawRequest, request, apiKey, settings, keyObj, rateLimitKey }) {
  if (modelStr.includes("/")) return null; // explicit provider/model ids are never combos
  const combo = await getComboByName(modelStr);
  if (!combo?.models?.length) return null;

  try {
    const legacyCfg = settings.comboStrategies?.[modelStr];
    const comboConfig = resolveComboStrategyConfig(combo, legacyCfg);

    // Capability adapter (default ON; per-combo capabilityAdapter.enabled and
    // the global comboCapabilityAdapterEnabled setting can opt out). Requests
    // needing hard input modalities (vision/pdf/audio/video) are routed to a
    // combo member that covers them — or, when none does and the configured
    // fallback is KNOWN to cover them, the fallback is prepended. Enrichment
    // happens BEFORE graph build so the fallback leaf flows through the SAME
    // ACL (authorizeComboExecution below), logical-call charge, budget, and
    // admission as regular members — no ACL bypass.
    const adapterEnabled = comboConfig.capabilityAdapter?.enabled ?? settings.comboCapabilityAdapterEnabled ?? true;
    let comboModels = combo.models;
    if (adapterEnabled) {
      const required = detectRequiredCapabilities(body);
      const fallback = comboConfig.capabilityAdapter?.fallbackModel || DEFAULT_CAPABILITY_FALLBACK_MODEL;
      const enriched = applyCapabilityAdapter(combo.models, required, fallback);
      if (enriched !== combo.models) {
        comboModels = enriched;
        log.info("CHAT", `Combo "${modelStr}" capability adapter: prepended ${enriched[0]} (no member covers [${[...required].join(", ")}])`);
      }
    }

    const graph = await buildComboExecutionGraph({ ...combo, models: comboModels }, legacyCfg);
    const authz = authorizeComboExecution(keyObj, graph);
    if (!authz.allowed) {
      log.warn("AUTH", `Combo "${modelStr}" denied expanded models: ${authz.denied.join(", ")}`);
      return errorResponse(HTTP_STATUS.FORBIDDEN, `Combo execution includes models not allowed for this API key: ${authz.denied.join(", ")}`);
    }

    // One token was charged before resolution. Charge the remaining expansion
    // cost atomically before any provider call — CAPPED at the burst capacity
    // so a large combo cannot reset the bucket to its own size and starve
    // subsequent requests (combo-heavy round-robin/fusion users were hitting
    // "Combo rate limit exceeded" on legitimate fan-outs).
    if (graph.logicalCalls > 1) {
      const charge = Math.min(graph.logicalCalls - 1, DEFAULT_BURST);
      const expansionLimit = checkRateLimit(rateLimitKey, undefined, undefined, charge);
      if (!expansionLimit.allowed) return errorResponse(HTTP_STATUS.TOO_MANY_REQUESTS, "Combo rate limit exceeded");
    }

    const budget = createComboBudget({ body, config: graph.config, leaves: graph.leaves, logicalCalls: graph.logicalCalls });
    if (!budget.ok) return errorResponse(HTTP_STATUS.BAD_REQUEST, `Combo budget rejected: ${budget.code}`);

    const lease = acquireComboAdmission(keyObj?.id || rateLimitKey);

    const runController = new AbortController();
    const abort = () => runController.abort(request.signal?.reason || new Error("client disconnected"));
    if (request.signal?.aborted) abort(); else request.signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await dispatchResolvedCombo({ body, graph, clientRawRequest, request, apiKey, settings, signal: runController.signal, budget, principalId: keyObj?.id || "local", keyObj });
      return wrapResponseWithAdmission(response, lease);
    } catch (error) {
      lease.release();
      throw error;
    } finally {
      request.signal?.removeEventListener("abort", abort);
    }
  } catch (error) {
    log.warn("COMBO", `Combo resolution failed: ${error?.message || error}`);
    return errorResponse(HTTP_STATUS.BAD_REQUEST, error?.message || "Invalid combo configuration");
  }
}

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let body;
  try {
    // C2 FIX: Limit body size to prevent OOM/DoS (10 MB max for chat)
    const bodyText = await readBodyWithLimit(request, 10 * 1024 * 1024);
    body = JSON.parse(bodyText);
  } catch (e) {
    if (e.message?.includes("too large")) {
      return errorResponse(HTTP_STATUS.BAD_REQUEST, e.message);
    }
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  cacheClaudeHeaders(clientRawRequest.headers);

  // Log request endpoint and model
  const url = new URL(request.url);
  const modelStr = body.model;

  // Count messages (support both messages[] and input[] formats)
  const msgCount = body.messages?.length || body.input?.length || 0;
  const toolCount = body.tools?.length || 0;
  const effort = body.reasoning_effort || body.reasoning?.effort || null;
  log.request("POST", `${url.pathname} | ${modelStr} | ${msgCount} msgs${toolCount ? ` | ${toolCount} tools` : ""}${effort ? ` | effort=${effort}` : ""}`);

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);

  // C3 FIX: Rate limiting — keyed on API key or client IP
  const rateLimitKey = apiKey || clientRawRequest?.headers?.["x-9r-real-ip"] || "anonymous";
  const rateLimit = checkRateLimit(rateLimitKey);
  evictExpiredBuckets(); // lazy eviction
  if (!rateLimit.allowed) {
    log.warn("RATE", `Rate limited: ${rateLimitKey.slice(0, 12)}... retry in ${Math.ceil(rateLimit.retryAfterMs / 1000)}s`);
    return new Response(
      JSON.stringify({
        error: {
          message: `Rate limit exceeded. Try again in ${Math.ceil(rateLimit.retryAfterMs / 1000)} seconds.`,
          type: "rate_limit_error",
          code: "rate_limited",
        },
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(Math.ceil(rateLimit.retryAfterMs / 1000)),
          "X-RateLimit-Remaining": String(rateLimit.remaining),
        },
      },
    );
  }

  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  let keyObj = null;
  if (apiKey) keyObj = await getApiKeyByKey(apiKey).catch((error) => {
    log.warn("AUTH", `ACL lookup error: ${error?.message || error}`);
    return null;
  });

  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const combo = !modelStr.includes("/") ? await getComboByName(modelStr) : null;
  if (combo?.models?.length) {
    // P0: every combo name now resolves through the single gated path
    // (dispatchComboByName: authorize + logical-call charge + budget + admission).
    // Kept via the shared helper so top-level and nested/legacy lookups cannot
    // fan out without authorization.
    return await dispatchComboByName(modelStr, { body, clientRawRequest, request, apiKey, settings, keyObj, rateLimitKey });
  }

  // ACL: enforce per-key model access via shared helper
  const denied = assertModelAllowed(keyObj, modelStr);
  if (denied) return denied;
  // Wave 1B compatibility boundary: HTTP handlers consume result.response —
  // the envelope is preserved all the way through handleSingleModelChat, but
  // the route boundary still requires a bare Response.
  const singleModelResult = await handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey);
  return singleModelResult.response;
}

/**
 * Dispatch a resolved combo execution graph to the appropriate strategy handler.
 *
 * Consolidates the previously-duplicated fallback/fusion/swarm dispatch logic
 * (CS-19) into one place. The graph has already been resolved and authorized
 * by buildComboExecutionGraph + authorizeComboExecution, so we only map
 * config → handler and build the handleSingleModel closure.
 *
 * @param {Object} opts
 * @param {Object} opts.body - request body
 * @param {Object} opts.graph - resolved execution graph from buildComboExecutionGraph
 * @param {Object} opts.clientRawRequest - raw request for logging
 * @param {Object} opts.request - original Next.js request
 * @param {string} opts.apiKey - API key
 * @param {Object} opts.settings - settings
 * @param {AbortSignal} opts.signal - run-level abort signal (CS-02)
 * @param {Object} opts.budget - combo budget from createComboBudget
 * @param {string} opts.principalId - principal ID for telemetry
 * @returns {Promise<Response>}
 */

/**
 * Resolve effective thinking config for a combo role.
 * Priority: role override > global combo > null (fallback to provider-level).
 */
function resolveThinkingForComboRole(comboThinking, role) {
  if (!comboThinking || comboThinking.type === "auto" || comboThinking.type === "off") return null;
  if (role && comboThinking.roles?.[role]) {
    const roleCfg = comboThinking.roles[role];
    if (roleCfg.type === "inherit" || roleCfg.type === undefined) {
      return { ...comboThinking, ...roleCfg, roles: undefined };
    }
    return roleCfg;
  }
  return comboThinking;
}

async function dispatchResolvedCombo({ body, graph, clientRawRequest, request, apiKey, settings, signal, budget, principalId, keyObj }) {
  const { comboName, config, members } = graph;
  const strategy = config.fallbackStrategy;
  const comboThinking = config?.thinking;

  // Build the handleSingleModel closure. Panel calls (fusion/swarm fan-out)
  // strip tools and use skipBreaker to isolate breaker state from internal calls.
  // The signal is threaded through so the run-level AbortController can cancel
  // in-flight provider calls when quorum grace expires, hard timeout fires, or
  // the client disconnects (CS-02).
  const handleSingleModel = async (b, m, callOpts = {}) => {
    // Normalize: support both boolean (legacy swarm/combo call style) and
    // object (new abortable-task call style) callOpts.
    const opts = typeof callOpts === "boolean" ? { isPanel: callOpts } : callOpts;
    const effectiveThinking = resolveThinkingForComboRole(comboThinking, opts.role);
    let cleanRawReq = clientRawRequest;
    if (opts.isPanel && clientRawRequest) {
      const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
      cleanRawReq = { ...clientRawRequest, body: cleanBody };
    }
    const result = await handleSingleModelChat(b, m, cleanRawReq, request, apiKey, {
      skipBreaker: opts.isPanel,
      signal: opts.signal,
      trafficClass: opts.trafficClass || (opts.isPanel ? "panel" : "user"),
      thinking: effectiveThinking,
      keyObj,
      // Combo observability: record which combo/strategy/role produced this
      // provider call so requestDetails is audit-able against template intent.
      comboContext: {
        name: comboName,
        strategy,
        role: opts.role || (opts.isPanel ? "panel" : null),
        trafficClass: opts.trafficClass || (opts.isPanel ? "panel" : "user"),
      },
    });
    // Wave 1B compatibility boundary: the combo engine still consumes a bare
    // Response today (Response.ok / status / clone at combo.js). Wave 1C
    // migrates it to ChatResult.success.
    return result.response;
  };

  if (strategy === "fusion") {
    log.info("CHAT", `Combo "${comboName}" with ${members.length} models (strategy: fusion)`);
    return handleFusionChat({
      body,
      models: members,
      handleSingleModel,
      log,
      comboName,
      judgeModel: config.judgeModel,
      tuning: config.fusionTuning,
      signal,
      runBudget: budget,
    });
  }

  if (strategy === "swarm") {
    log.info("CHAT", `Combo "${comboName}" with ${members.length} models (strategy: swarm)`);
    return handleSwarmChat({
      body,
      models: members,
      handleSingleModel,
      log,
      comboName,
      managerModel: config.managerModel,
      staffModel: config.staffModel,
      auditModel: config.auditModel,
      workerCount: config.workerCount,
      swarmTuning: config.swarmTuning,
      telemetry: config.enableTelemetry,
      signal,
      runBudget: budget,
      principalId,
      autoScale: config.autoScale,
    });
  }

  if (strategy === "smart-routing") {
    log.info("CHAT", `Combo "${comboName}" with ${members.length} models (strategy: smart-routing)`);
    return handleSmartRoutingChat({
      body,
      models: members,
      handleSingleModel,
      log,
      comboName,
      config: config.smartRouting,
      signal,
      runBudget: budget,
      breakerSettings: settings,
      telemetry: config.enableTelemetry,
    });
  }

  if (strategy === "cascade") {
    log.info("CHAT", `Combo "${comboName}" with ${members.length} models (strategy: cascade)`);
    return handleCascadeChat({
      body,
      models: members,
      handleSingleModel,
      log,
      comboName,
      tuning: config.cascade,
      signal,
      runBudget: budget,
    });
  }

  // fallback / round-robin
  log.info("CHAT", `Combo "${comboName}" with ${members.length} models (strategy: ${strategy})`);
  return handleComboChat({
    body,
    models: members,
    handleSingleModel,
    log,
    comboName,
    comboStrategy: strategy,
    comboStickyLimit: settings.comboStickyRoundRobinLimit,
    breakerSettings: settings,
    signal,
    runBudget: budget,
  });
}

/**
 * Handle single model chat request
 */
/**
 * Execute one provider model attempt with account fallback, preserving the
 * full ChatResult envelope from handleChatCore.
 *
 * Wave 1B: every return path carries the complete ChatResult
 * ({ success, response, status?, error?, fromCache?, … }) — callers that still
 * need a bare Response consume `result.response` at their own boundary.
 *
 * @returns {Promise<import("open-sse/utils/error.js").ChatResult>}
 */
export async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, opts = {}) {
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name (e.g. a nested combo whose
  // member is itself a combo name). P0: route through the same gated path as the
  // top-level handler so the fan-out is authorized, rate-limited, budgeted, and
  // admitted — never the old unguarded dispatch.
  if (!modelInfo.provider) {
    const settings = await getSettings();
    const gated = await dispatchComboByName(modelStr, {
      body,
      clientRawRequest,
      request,
      apiKey,
      settings,
      keyObj: opts.keyObj || null,          // panel workers: null (already authorized at top level)
      rateLimitKey: opts.principalId || opts.rateLimitKey || "local",
    });
    if (gated) {
      // Wave 1B compatibility boundary: dispatchComboByName returns a bare
      // Response from a nested combo graph — which can be a 2xx success or an
      // error. Derive the envelope from Response.ok, the same criterion the
      // combo layer uses today.
      return gated.ok
        ? { success: true, response: gated }
        : chatResultFromErrorResponse(gated);
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return { success: false, status: HTTP_STATUS.BAD_REQUEST, error: "Invalid model format", response: errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format") };
  }

  const { provider, model } = modelInfo;

  // Log model routing (alias → actual model)
  if (modelStr !== `${provider}/${model}`) {
    log.info("ROUTING", `${modelStr} → ${provider}/${model}`);
  } else {
    log.info("ROUTING", `Provider: ${provider}, Model: ${model}`);
  }

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  // Fetch settings once before the retry loop. The early-exit branches below
  // (allRateLimited / no-credentials / exhausted-accounts) call recordHealthSample
  // which needs chatSettings, so it must exist before the loop body executes —
  // otherwise it's a TDZ ReferenceError on the first iteration. Fetching once per
  // request is also cheaper than re-reading the DB on every fallback attempt.
  const chatSettings = await getSettings();

  // OpenCode identity: resolved ONCE per logical request (first account
  // attempt wins) so account fallback, executor retries, alternate transports
  // and the stream all share the same sessionId + requestId. Identity travels
  // as request data via handleChatCore → executor.execute — never stored on
  // the singleton executor. Non-OpenCode providers are untouched.
  const opencodeIdentity = provider === "opencode"
    ? resolveOpenCodeIdentity({
        headers: clientRawRequest?.headers || {},
        body,
        connectionId: "noauth",
      })
    : null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        // C3 fix: record failure sample so health monitor sees this.
        // No model attempt ran on this path (every account is rate-limited), so
        // model latency is 0 — consistent with the other early-exit samples below.
        recordHealthSample(provider, { success: false, latencyMs: 0, status }, chatSettings);
        // P0 probe-leak fix: getProviderCredentials may have claimed a half-open
        // probe slot (free no-auth providers claim the provider-level key in
        // auth.js:94). This path returns BEFORE handleChatCore, so release the
        // slot explicitly or the breaker wedges at half-open capacity forever.
        releaseBreakerProbe(provider);
        return { success: false, status, error: `[${provider}/${model}] ${errorMsg}`, response: unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman) };
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        // C3 fix: record failure sample.
        recordHealthSample(provider, { success: false, latencyMs: 0, status: 404 }, chatSettings);
        // P0 probe-leak fix: release any half-open slot claimed during credential
        // resolution (free no-auth provider path) before this early return.
        releaseBreakerProbe(provider);
        return { success: false, status: HTTP_STATUS.NOT_FOUND, error: `No active credentials for provider: ${provider}`, response: errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`) };
      }
      log.warn("CHAT", "No more accounts available", { provider });
      // C3 fix: record failure sample.
      recordHealthSample(provider, { success: false, latencyMs: 0, status: lastStatus || 503 }, chatSettings);
      // P0 probe-leak fix: same as above — guarantee the claimed slot is released.
      releaseBreakerProbe(provider);
      return { success: false, status: lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, error: lastError || "All accounts unavailable", response: errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable") };
    }

    // Log account selection
    log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const providerThinking = opts.thinking || (chatSettings.providerThinking || {})[provider] || null;
    const pxpipeDir = getPxpipeDir();
    const attemptStart = Date.now();
    // Proxy-aware breaker key: isolate breaker state per (provider, proxy) so
    // one dead proxy doesn't trip the breaker for other proxies/direct traffic.
    const breakerKeyVal = breakerKey(provider, refreshedCredentials?.providerSpecificData || {});
    const result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeDir: pxpipeDir,
      pxpipeMinChars: chatSettings.pxpipeMinChars || 25000,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs || 5000,
      semanticCacheEnabled: !!chatSettings.semanticCacheEnabled,
      semanticCacheThreshold: typeof chatSettings.semanticCacheThreshold === "number" ? chatSettings.semanticCacheThreshold : 0.85,
      providerThinking,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      // CS-02: thread the run-level abort signal so handleChatCore can cancel
      // in-flight provider calls when quorum grace expires, hard timeout fires,
      // or the client disconnects.
      externalSignal: opts.signal,
      // OpenCode identity resolved once per logical request (see above) —
      // carried as data through the executor, never stored on singletons.
      opencodeIdentity,
      // Combo observability: which combo/strategy/role/trafficClass produced
      // this provider call (undefined for plain single-model requests).
      comboContext: opts.comboContext,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      }
    }).catch(err => {
      // Probe-slot leak fix: if handleChatCore throws (abort, network error),
      // release the claimed half-open probe slot so the breaker doesn't get stuck.
      // Skip for panel calls (skipBreaker) — no probe was claimed.
      if (!opts.skipBreaker) releaseBreakerProbe(provider, breakerKeyVal);
      // C3 fix: record failure sample for thrown exceptions (abort, network error).
      if (!opts.skipBreaker) {
        recordHealthSample(provider, { success: false, latencyMs: Date.now() - attemptStart, status: 0 }, chatSettings);
      }
      throw err;
    });

    if (result.success) {
      const latencyMs = Date.now() - attemptStart;
      // M6 FIX: panel calls (fusion/swarm fan-out) share the per-provider
      // breaker with non-combo traffic. Recording failures here would let a
      // flaky panel model trip the breaker and block single-model requests
      // to the same provider. skipBreaker isolates panel outcomes so only the
      // final user-facing call (judge/synthesis/direct) affects breaker state.
      if (!opts.skipBreaker) recordBreakerSuccess(provider, chatSettings, breakerKeyVal);
      recordHealthSample(provider, { success: true, latencyMs }, chatSettings);
      return result;
    }

    // Freebuff free-tier CLI gate: upstream 403s chat with
    // free_mode_cli_required for ALL free-tier accounts (server-side policy).
    // It's not an account-health problem — model-locking the connection and
    // appending "reset after …" would mislabel a permanent gate as a transient
    // rate limit, and fallback accounts would hit the same wall. Surface the
    // executor's clear message and stop here.
    if (provider === "freebuff" && result.status === 403 && /restricted to the official CLI|free_mode_cli_required/i.test(result.error || "")) {
      return result;
    }

    // Mark account unavailable (auto-calculates cooldown with exponential backoff, or precise resetsAtMs)
    // H3 FIX: Pass the vault keyName from credentials so markVaultKeyRateLimited
    // targets the exact key that errored, not LAST_ISSUED (which races under concurrency).
    const vaultKey = credentials.connectionId === "vault" ? credentials.connectionName?.replace("Vault · ", "") : null;
    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, result.resetsAtMs, vaultKey);

    // Record health + circuit breaker for retryable failures only.
    const latencyMs = Date.now() - attemptStart;
    // Client aborts (499) are cancellations, not provider-health events — a
    // user hitting Stop (or a combo closing a straggler panel leaf) must not
    // drag down the provider's success rate in the health dashboard.
    if (result.status !== 499) {
      recordHealthSample(provider, { success: false, latencyMs, status: result.status }, chatSettings);
    }
    if (isRetryableFailure(result.status) && !opts.skipBreaker) {
      recordBreakerFailure(provider, result.status, chatSettings, breakerKeyVal);
    } else if (!opts.skipBreaker) {
      // Probe-slot leak fix: non-retryable errors (400/401/403) in half-open
      // state neither record failure nor release the probe slot — the breaker
      // would get stuck at capacity until cooldown. Release explicitly so the
      // next request can claim a probe slot.
      releaseBreakerProbe(provider, breakerKeyVal);
    }

    if (shouldFallback) {
      log.warn("AUTH", `Account ${credentials.connectionName} unavailable (${result.status}), trying fallback`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result;
  }
}
