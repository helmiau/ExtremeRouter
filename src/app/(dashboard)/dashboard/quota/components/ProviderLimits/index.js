"use client";

import PageHeader from "@/shared/components/PageHeader";
import Card from "@/shared/components/Card";
import { ConfirmModal, EditConnectionModal } from "@/shared/components";
import {
  shouldResetPage,
  getConnectionLabel,
  ACCOUNT_PAGE_SIZE_MAX,
} from "./utils";
import useQuotaData from "./useQuotaData";
import HeaderControls from "./HeaderControls";
import ProviderCard from "./ProviderCard";
import PaginationControls from "./PaginationControls";
import ResetCreditsModal from "./ResetCreditsModal";
import EmptyState from "./EmptyState";

export default function ProviderLimits() {
  const {
    // data
    quotaData,
    loading,
    errors,
    autoRefresh,
    autoPingMaps,
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
    hasEligibleConnections,
    hasVisibleConnections,
    emptyState,
    connectionsPageSummary,
  } = useQuotaData();

  const handleSelectProvider = (provider) => {
    if (shouldResetPage(providerFilter, provider)) {
      setPage(1);
    }
    setProviderFilter(provider);
    setProviderMenuOpen(false);
  };

  const handleAccountFilterChange = (nextValue) => {
    if (shouldResetPage(accountFilter, nextValue)) {
      setPage(1);
    }
    setAccountFilter(nextValue);
  };

  const handlePageSizeSelect = (nextValue) => {
    if (nextValue === "custom") return;
    const nextPageSize = Number.parseInt(nextValue, 10);
    if (Number.isFinite(nextPageSize)) {
      setPage(1);
      setPageSize(nextPageSize);
      setCustomPageSizeInput(String(nextPageSize));
    }
  };

  const commitCustomPageSize = () => {
    const parsedValue = Number.parseInt(customPageSizeInput, 10);
    if (!Number.isFinite(parsedValue)) {
      setCustomPageSizeInput(String(pageSize));
      return;
    }
    const nextPageSize = Math.min(ACCOUNT_PAGE_SIZE_MAX, Math.max(1, parsedValue));
    setPage(1);
    setPageSize(nextPageSize);
    setCustomPageSizeInput(String(nextPageSize));
  };

  if (!connectionsLoading && !hasEligibleConnections) {
    return (
      <EmptyState
        icon="cloud_off"
        title="No Providers Connected"
        description="Connect to providers with OAuth to track your API quota limits and usage."
      />
    );
  }

  if (!connectionsLoading && !hasVisibleConnections) {
    return (
      <EmptyState
        icon={emptyState.icon}
        title={emptyState.title}
        description={emptyState.description}
      />
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Quota"
        description="Capacity, resets, and account availability"
        icon="data_usage"
      />
      {/* Header Controls */}
      <HeaderControls
        providerFilter={providerFilter}
        providerOptions={providerOptions}
        providerMenuOpen={providerMenuOpen}
        onToggleProviderMenu={() => setProviderMenuOpen((prev) => !prev)}
        onSelectProvider={handleSelectProvider}
        accountFilter={accountFilter}
        onAccountFilterChange={handleAccountFilterChange}
        quotaSortMode={quotaSortMode}
        onQuotaSortModeChange={setQuotaSortMode}
        expiringFirst={expiringFirst}
        onToggleExpiringFirst={() => setExpiringFirst((prev) => !prev)}
        autoRefresh={autoRefresh}
        onToggleAutoRefresh={() => setAutoRefresh((prev) => !prev)}
        countdown={countdown}
        bulkToggling={bulkToggling}
        onDisableDepleted={handleDisableDepleted}
        onEnableAvailable={handleEnableAvailable}
        refreshingAll={refreshingAll}
        onRefreshAll={refreshAll}
      />

      {/* Provider cards: 2 columns, compact */}
      {expiringFirst && (
        <div className="rounded-xl border border-amber-500/20 bg-warning/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          Expiring-first currently reorders accounts inside the current page.
          Cross-page ordering still follows backend pagination.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {sortedConnections.map((conn) => (
          <ProviderCard
            key={conn.id}
            conn={conn}
            quota={quotaData[conn.id]}
            isLoading={loading[conn.id]}
            error={errors[conn.id]}
            autoPingMaps={autoPingMaps}
            quotaSortMode={quotaSortMode}
            resettingLimitId={resettingLimitId}
            deletingId={deletingId}
            togglingId={togglingId}
            onRefresh={refreshProvider}
            onEdit={(connection) => {
              setSelectedConnection(connection);
              setShowEditModal(true);
            }}
            onDelete={handleDeleteConnection}
            onToggleActive={handleToggleConnectionActive}
            onRequestReset={(connection, resetCreditCount) =>
              setResetConfirmState({ connection, resetCreditCount })
            }
            onViewResetCredits={handleViewCodexResetCredits}
            onToggleAutoPing={toggleAutoPing}
          />
        ))}
      </div>

      <PaginationControls
        pagination={pagination}
        pageSize={pageSize}
        customPageSizeInput={customPageSizeInput}
        connectionsLoading={connectionsLoading}
        refreshingAll={refreshingAll}
        connectionsPageSummary={connectionsPageSummary}
        setPage={setPage}
        onPageSizeSelect={handlePageSizeSelect}
        onCustomPageSizeInputChange={setCustomPageSizeInput}
        onCommitCustomPageSize={commitCustomPageSize}
      />

      <ConfirmModal
        isOpen={Boolean(resetConfirmState)}
        onClose={() => {
          if (!resettingLimitId) setResetConfirmState(null);
        }}
        onConfirm={async () => {
          const connection = resetConfirmState?.connection;
          if (!connection) return;
          await handleResetCodexLimit(connection.id, connection.provider);
          setResetConfirmState(null);
        }}
        title="Reset Codex limit?"
        message={`Use 1 Codex reset credit for ${getConnectionLabel(resetConfirmState?.connection || {}) || "this account"}. This cannot be undone. Remaining credits: ${resetConfirmState?.resetCreditCount ?? 0}.`}
        confirmText="Reset limit"
        cancelText="Cancel"
        variant="danger"
        loading={Boolean(resettingLimitId)}
      />

      <ResetCreditsModal
        state={resetCreditsState}
        onClose={() => setResetCreditsState(null)}
      />

      <EditConnectionModal
        isOpen={showEditModal}
        connection={selectedConnection}
        proxyPools={proxyPools}
        onSave={handleUpdateConnection}
        onClose={() => {
          setShowEditModal(false);
          setSelectedConnection(null);
        }}
      />
    </div>
  );
}
