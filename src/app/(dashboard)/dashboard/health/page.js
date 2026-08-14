import PageHeader from "@/shared/components/PageHeader";
import HealthMonitor from "@/shared/components/HealthMonitor";
import BreakerMonitor from "@/shared/components/BreakerMonitor";
import ProviderHealthHeatmap from "@/shared/components/ProviderHealthHeatmap";

export const dynamic = "force-dynamic";

export default function HealthPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Provider Health"
        description="Real-time provider success rate, latency, error tracking, breaker state, and connection cooldowns"
        icon="monitor_heart"
      />
      <ProviderHealthHeatmap />
      <HealthMonitor />
      <BreakerMonitor />
    </div>
  );
}
