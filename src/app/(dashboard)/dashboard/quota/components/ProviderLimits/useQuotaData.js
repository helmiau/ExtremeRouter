"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  parseQuotaData,
  calculatePercentage,
  buildLoadingState,
  filterQuotaStateByConnections,
  getConnectionsEmptyMessage,
  getConnectionsPaginationSummary,
  getSafePagination,
  getSafeTotals,
  getPaginationPageValue,
  getProviderOptions,
  reconcileConnectionsPage,
  getQuotaCache,
  setQuotaCache,
  QUOTA_CACHE_KEY,
  REFRESH_INTERVAL_MS,
  CLAUDE_REFRESH_INTERVAL_MS,
  DEPLETED_QUOTA_THRESHOLD,
  AUTO_REFRESH_STORAGE_KEY,
  CONNECTIONS_PAGE_SIZE,
  ACCOUNT_PAGE_SIZE_OPTIONS,
  sortVisibleConnections,
  getPageSizeLabel,
} from "./utils";
import { USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers";

export default function useQuotaData() {
  const [connections, setConnections] = useState([]);
  const [quotaData, setQuotaData] = useState({});
  const [loading, setLoading] = useState({});
  const [errors, setErrors] = useState({});
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [autoPingMaps, setAutoPingMaps] = useState({ claude: {}, codex: {} });
  const [lastUpdated, setLastUpdated] = useState(null);
  const [hasHydratedAutoRefresh, setHasHydratedAutoRefresh] = useState(false);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [countdown, setCountdown] = useState(60);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [deletingId, setDeletingId] = useState(null);
  const [togglingId, setTogglingId] = useState(null);
  const [resettingLimitId, setResettingLimitId] = useState(null);
  const [resetConfirmState, setResetConfirmState] = useState(null);
  const [resetCreditsState, setResetCreditsState] = useState(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState(null);
  const [proxyPools, setProxyPools] = useState([]);
  const [providerFilter, setProviderFilter] = useState("all");
  const [providerOptions, setProviderOptions] = useState([]);
  const [accountFilter, setAccountFilter] = useState("all");
  const [quotaSortMode, setQuotaSortMode] = useState("default");
  const [expiringFirst, setExpiringFirst] = useState(false);
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const [bulkToggling, setBulkToggling] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(CONNECTIONS_PAGE_SIZE);
  const [customPageSizeInput, setCustomPageSizeInput] = useState(
    String(CONNECTIONS_PAGE_SIZE),
  );
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: CONNECTIONS_PAGE_SIZE,
    total: 0,
    totalPages: 1,
  });
  const [totals, setTotals] = useState({
    eligibleConnections: 0,
    providerFilteredConnections: 0,
  });

  const intervalRef = useRef(null);
  const countdownRef = useRef(null);
  const tickCountRef = useRef(0);

  const fetchConnections = useCallback(
    async (targetPage = page) => {
      try {
        const params = new URLSearchParams({
          page: String(targetPage),
          pageSize: String(pageSize),
          accountStatus: accountFilter,
          sort: "priority",
        });

        if (providerFilter !== "all") {
          params.set("provider", providerFilter);
        }

        const response = await fetch(
          `/api/providers/client?${params.toString()}`,
        );
        if (!response.ok) throw new Error("Failed to fetch connections");

        const data = await response.json();
        const connectionList = data.connections || [];
        const nextPagination = getSafePagination(data.pagination, pageSize);
        const nextTotals = getSafeTotals(data.totals, connectionList.length);

        setConnections(connectionList);
        setProviderOptions(getProviderOptions(data.providerOptions));
        setPagination(nextPagination);
        setTotals(nextTotals);
        setPage(getPaginationPageValue(data.pagination, targetPage));
        return connectionList;
      } catch (error) {
        console.error("Error fetching connections:", error);
        setConnections([]);
        setProviderOptions([]);
        setPagination({ page: 1, pageSize, total: 0, totalPages: 1 });
        setTotals({ eligibleConnections: 0, providerFilteredConnections: 0 });
        return [];
      }
    },
    [accountFilter, expiringFirst, page, pageSize, providerFilter],
  );

  // Fetch quota for a specific connection
  const fetchQuota = useCallback(async (connectionId, provider) => {
    setLoading((prev) => ({ ...prev, [connectionId]: true }));
    setErrors((prev) => ({ ...prev, [connectionId]: null }));

    try {
      console.log(
        `[ProviderLimits] Fetching quota for ${provider} (${connectionId})`,
      );
      const response = await fetch(`/api/usage/${connectionId}`);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData.error || response.statusText;

        // Handle different error types gracefully
        if (response.status === 404) {
          // Connection not found - skip silently
          console.warn(
            `[ProviderLimits] Connection not found for ${provider}, skipping`,
          );
          return;
        }

        if (response.status === 401) {
          // Auth error - show message instead of throwing
          console.warn(
            `[ProviderLimits] Auth error for ${provider}:`,
            errorMsg,
          );
          const quotaEntry = {
            quotas: [],
            message: errorMsg,
          };
          setQuotaData((prev) => ({
            ...prev,
            [connectionId]: quotaEntry,
          }));
          setQuotaCache(connectionId, quotaEntry);
          return;
        }

        throw new Error(`HTTP ${response.status}: ${errorMsg}`);
      }

      const data = await response.json();
      console.log(`[ProviderLimits] Got quota for ${provider}:`, data);

      // Some usage handlers legitimately return `null` (e.g. TokenRouter when
      // the user hasn't configured a management key). Guard against null so the
      // UI doesn't crash reading `data.plan` — show an empty result instead.
      const safeData = data ?? {};

      // Parse quota data using provider-specific parser
      const parsedQuotas = parseQuotaData(provider, safeData);

      const quotaEntry = {
        quotas: parsedQuotas,
        plan: safeData.plan || null,
        message: safeData.message || null,
        raw: data,
      };

      setQuotaData((prev) => ({
        ...prev,
        [connectionId]: quotaEntry,
      }));
      setQuotaCache(connectionId, quotaEntry);
    } catch (error) {
      console.error(
        `[ProviderLimits] Error fetching quota for ${provider} (${connectionId}):`,
        error,
      );
      setErrors((prev) => ({
        ...prev,
        [connectionId]: error.message || "Failed to fetch quota",
      }));
    } finally {
      setLoading((prev) => ({ ...prev, [connectionId]: false }));
    }
  }, []);

  // Refresh quota for a specific provider
  const refreshProvider = useCallback(
    async (connectionId, provider) => {
      await fetchQuota(connectionId, provider);
      setLastUpdated(new Date());
    },
    [fetchQuota],
  );

  const handleResetCodexLimit = useCallback(
    async (connectionId, provider) => {
      if (provider !== "codex" || resettingLimitId) return;

      setResettingLimitId(connectionId);
      setErrors((prev) => ({ ...prev, [connectionId]: null }));

      try {
        const response = await fetch(`/api/usage/${connectionId}/codex-reset-credits`, { method: "POST" });
        const result = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(result.message || result.error || result.code || "Failed to reset Codex limit");
        }

        await fetchQuota(connectionId, provider);
        setLastUpdated(new Date());
      } catch (error) {
        setErrors((prev) => ({ ...prev, [connectionId]: error.message || "Failed to reset Codex limit" }));
      } finally {
        setResettingLimitId(null);
      }
    },
    [fetchQuota, resettingLimitId],
  );

  const handleViewCodexResetCredits = useCallback(async (connection) => {
    setResetCreditsState({ connection, loading: true, error: null, data: null });
    try {
      const response = await fetch(`/api/usage/${connection.id}/codex-reset-credits`, { cache: "no-store" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || result.message || "Failed to load Codex reset credits");
      }
      const credits = Array.isArray(result.credits) ? [...result.credits] : [];
      credits.sort((a, b) => {
        const aTime = a.expiresAt ? new Date(a.expiresAt).getTime() : Number.POSITIVE_INFINITY;
        const bTime = b.expiresAt ? new Date(b.expiresAt).getTime() : Number.POSITIVE_INFINITY;
        return aTime - bTime;
      });
      setResetCreditsState({ connection, loading: false, error: null, data: { ...result, credits } });
    } catch (error) {
      setResetCreditsState({ connection, loading: false, error: error.message || "Failed to load Codex reset credits", data: null });
    }
  }, []);

  const handleDeleteConnection = useCallback(
    async (id) => {
      if (!confirm("Delete this connection?")) return;
      setDeletingId(id);
      try {
        const res = await fetch(`/api/providers/${id}`, { method: "DELETE" });
        if (res.ok) {
          setQuotaData((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          setLoading((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          setErrors((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });

          if (typeof window !== "undefined") {
            try {
              const cache = getQuotaCache();
              if (cache[id]) {
                delete cache[id];
                window.localStorage.setItem(
                  QUOTA_CACHE_KEY,
                  JSON.stringify(cache),
                );
              }
            } catch (e) {
              console.error("Error deleting cache entry:", e);
            }
          }

          await reconcileConnectionsPage(fetchConnections, page);
        }
      } catch (error) {
        console.error("Error deleting connection:", error);
      } finally {
        setDeletingId(null);
      }
    },
    [fetchConnections, page],
  );

  const handleToggleConnectionActive = useCallback(
    async (id, isActive) => {
      setTogglingId(id);
      try {
        const res = await fetch(`/api/providers/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive }),
        });
        if (res.ok) {
          setQuotaData((prev) => {
            const next = { ...prev };
            return next;
          });
          await reconcileConnectionsPage(fetchConnections, page);
        }
      } catch (error) {
        console.error("Error updating connection status:", error);
      } finally {
        setTogglingId(null);
      }
    },
    [fetchConnections, page],
  );

  const handleUpdateConnection = useCallback(
    async (formData) => {
      if (!selectedConnection?.id) return;
      const connectionId = selectedConnection.id;
      const provider = selectedConnection.provider;
      try {
        const res = await fetch(`/api/providers/${connectionId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formData),
        });
        if (res.ok) {
          await fetchConnections();
          setShowEditModal(false);
          setSelectedConnection(null);
          if (USAGE_SUPPORTED_PROVIDERS.includes(provider)) {
            await fetchQuota(connectionId, provider);
          }
        }
      } catch (error) {
        console.error("Error saving connection:", error);
      }
    },
    [selectedConnection, fetchConnections, fetchQuota],
  );

  useEffect(() => {
    let cancelled = false;
    fetch("/api/proxy-pools?isActive=true", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data?.proxyPools) {
          setProxyPools(data.proxyPools);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshAll = useCallback(async (force = false) => {
    if (refreshingAll) return;

    setRefreshingAll(true);
    setCountdown(60);

    // Throttle Claude: poll its quota every Nth auto-tick (manual force bypasses)
    const tick = (tickCountRef.current += 1);
    const claudeEvery = Math.round(CLAUDE_REFRESH_INTERVAL_MS / REFRESH_INTERVAL_MS);
    const shouldFetch = (conn) =>
      force || conn.provider !== "claude" || tick % claudeEvery === 0;

    try {
      const visibleConnections = await fetchConnections(page);

      setLoading(buildLoadingState(visibleConnections));
      setErrors((prev) =>
        filterQuotaStateByConnections(prev, visibleConnections),
      );
      setQuotaData((prev) =>
        filterQuotaStateByConnections(prev, visibleConnections),
      );

      await Promise.all(
        visibleConnections
          .filter(shouldFetch)
          .map((conn) => fetchQuota(conn.id, conn.provider)),
      );

      setLastUpdated(new Date());
    } catch (error) {
      console.error("Error refreshing all providers:", error);
    } finally {
      setRefreshingAll(false);
    }
  }, [refreshingAll, fetchConnections, fetchQuota, page]);

  useEffect(() => {
    const initializeData = async () => {
      setConnectionsLoading(true);
      const visibleConnections = await fetchConnections(page);
      setConnectionsLoading(false);

      // Always fetch fresh quota on mount, no cache display
      setLoading(buildLoadingState(visibleConnections));
      setErrors((prev) =>
        filterQuotaStateByConnections(prev, visibleConnections),
      );
      setQuotaData((prev) =>
        filterQuotaStateByConnections(prev, visibleConnections),
      );

      await Promise.all(
        visibleConnections.map((conn) => fetchQuota(conn.id, conn.provider)),
      );
      setLastUpdated(new Date());
    };

    initializeData();
  }, [fetchConnections, fetchQuota, page]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(AUTO_REFRESH_STORAGE_KEY);
    setAutoRefresh(stored === null ? true : stored === "true");
    setHasHydratedAutoRefresh(true);
  }, []);

  // Persist auto-refresh preference
  useEffect(() => {
    if (typeof window === "undefined" || !hasHydratedAutoRefresh) return;
    window.localStorage.setItem(AUTO_REFRESH_STORAGE_KEY, String(autoRefresh));
  }, [autoRefresh, hasHydratedAutoRefresh]);

  // Load auto-ping per-connection maps
  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : {}))
      .then((s) => setAutoPingMaps({
        claude: s?.claudeAutoPing?.connections || {},
        codex: s?.codexAutoPing?.connections || {},
      }))
      .catch(() => {});
  }, []);

  const toggleAutoPing = useCallback(async (connectionId, provider, on) => {
    const settingsKey = AUTO_PING_SETTINGS_KEYS[provider];
    if (!settingsKey) return;

    const previous = autoPingMaps;
    const nextProviderMap = { ...(autoPingMaps[provider] || {}), [connectionId]: on };
    const nextMaps = { ...autoPingMaps, [provider]: nextProviderMap };
    setAutoPingMaps(nextMaps);
    try {
      const r = await fetch("/api/settings", { cache: "no-store" });
      const s = r.ok ? await r.json() : {};
      const cfg = { ...(s[settingsKey] || {}), connections: nextProviderMap };
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [settingsKey]: cfg }),
      });
    } catch {
      setAutoPingMaps(previous);
    }
  }, [autoPingMaps]);

  // Auto-refresh interval
  useEffect(() => {
    if (!hasHydratedAutoRefresh || !autoRefresh) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
      }
      return;
    }

    // Main refresh interval
    intervalRef.current = setInterval(() => {
      refreshAll();
    }, REFRESH_INTERVAL_MS);

    // Countdown interval
    countdownRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) return 60;
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [autoRefresh, refreshAll, hasHydratedAutoRefresh]);

  // Pause auto-refresh when tab is hidden (Page Visibility API)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        if (countdownRef.current) {
          clearInterval(countdownRef.current);
          countdownRef.current = null;
        }
      } else if (autoRefresh && hasHydratedAutoRefresh) {
        // Resume auto-refresh when tab becomes visible
        intervalRef.current = setInterval(() => refreshAll(), REFRESH_INTERVAL_MS);
        countdownRef.current = setInterval(() => {
          setCountdown((prev) => (prev <= 1 ? 60 : prev - 1));
        }, 1000);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [autoRefresh, refreshAll, hasHydratedAutoRefresh]);

  const sortedConnections = useMemo(
    () =>
      sortVisibleConnections(
        connections,
        quotaData,
        expiringFirst,
        providerFilter,
        quotaSortMode,
      ),
    [connections, quotaData, expiringFirst, providerFilter, quotaSortMode],
  );

  // Connection is depleted when any quota entry hit the threshold
  const isConnectionDepleted = (conn) => {
    const quotas = quotaData[conn.id]?.quotas;
    if (!quotas?.length) return false;
    return quotas.some((q) => {
      if (!q.total || q.total <= 0) return false;
      return calculatePercentage(q.used, q.total) <= DEPLETED_QUOTA_THRESHOLD;
    });
  };

  const bulkSetActive = useCallback(
    async (targetIds, isActive) => {
      if (!targetIds.length || bulkToggling) return;
      setBulkToggling(true);
      try {
        await Promise.all(
          targetIds.map((id) =>
            fetch(`/api/providers/${id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ isActive }),
            }),
          ),
        );
        await reconcileConnectionsPage(fetchConnections, page);
      } catch (error) {
        console.error("Error bulk toggling connections:", error);
      } finally {
        setBulkToggling(false);
      }
    },
    [bulkToggling, fetchConnections, page],
  );

  const handleDisableDepleted = () => {
    const ids = sortedConnections
      .filter((c) => (c.isActive ?? true) && isConnectionDepleted(c))
      .map((c) => c.id);
    bulkSetActive(ids, false);
  };

  const handleEnableAvailable = () => {
    const ids = sortedConnections
      .filter((c) => !(c.isActive ?? true) && !isConnectionDepleted(c))
      .map((c) => c.id);
    bulkSetActive(ids, true);
  };

  const selectedProviderLabel =
    providerFilter === "all" ? "All providers" : providerFilter;
  const hasEligibleConnections = totals.eligibleConnections > 0;
  const hasVisibleConnections = sortedConnections.length > 0;
  const emptyState = getConnectionsEmptyMessage(
    totals,
    providerFilter,
    accountFilter,
  );
  const connectionsPageSummary = getConnectionsPaginationSummary(pagination);
  const isCustomPageSize = !ACCOUNT_PAGE_SIZE_OPTIONS.includes(pageSize);
  const pageSizeLabel = getPageSizeLabel(pageSize, isCustomPageSize);

  return {
    // data
    connections,
    quotaData,
    loading,
    errors,
    autoRefresh,
    autoPingMaps,
    lastUpdated,
    hasHydratedAutoRefresh,
    refreshingAll,
    countdown,
    connectionsLoading,
    deletingId,
    togglingId,
    resettingLimitId,
    resetConfirmState,
    resetCreditsState,
    showEditModal,
    selectedConnection,
    proxyPools,
    providerFilter,
    providerOptions,
    accountFilter,
    quotaSortMode,
    expiringFirst,
    providerMenuOpen,
    bulkToggling,
    page,
    pageSize,
    customPageSizeInput,
    pagination,
    totals,
    // setters
    setAutoRefresh,
    setResetConfirmState,
    setResetCreditsState,
    setShowEditModal,
    setSelectedConnection,
    setProviderFilter,
    setProviderMenuOpen,
    setAccountFilter,
    setQuotaSortMode,
    setExpiringFirst,
    setPage,
    setPageSize,
    setCustomPageSizeInput,
    // actions
    refreshProvider,
    handleResetCodexLimit,
    handleViewCodexResetCredits,
    handleDeleteConnection,
    handleToggleConnectionActive,
    handleUpdateConnection,
    refreshAll,
    toggleAutoPing,
    handleDisableDepleted,
    handleEnableAvailable,
    // derived
    sortedConnections,
    isConnectionDepleted,
    selectedProviderLabel,
    hasEligibleConnections,
    hasVisibleConnections,
    emptyState,
    connectionsPageSummary,
    isCustomPageSize,
    pageSizeLabel,
  };
}
