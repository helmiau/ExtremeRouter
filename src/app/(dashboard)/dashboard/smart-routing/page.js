import PageHeader from "@/shared/components/PageHeader";
import SmartRoutingTelemetryMonitor from "@/shared/components/SmartRoutingTelemetryMonitor";
import SmartRoutingHistory from "@/shared/components/SmartRoutingHistory";

export const dynamic = "force-dynamic";

export default function SmartRoutingPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Smart Routing"
        description="Live routing decisions per request — reason, selected pool & excluded cookies"
        icon="alt_route"
      />
      <SmartRoutingTelemetryMonitor />

      <div className="mt-2 border-t border-border-subtle pt-6">
        <div className="mb-4 flex items-center gap-2">
          <span className="material-symbols-outlined text-[18px] text-text-muted">database</span>
          <h2 className="text-base font-semibold text-text-main">History</h2>
          <span className="text-xs text-text-muted">Persisted across restarts — filter & paginate</span>
        </div>
        <SmartRoutingHistory />
      </div>
    </div>
  );
}
