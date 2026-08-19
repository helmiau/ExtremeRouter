"use client";

import { useMemo } from "react";
import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import DonutChart from "@/shared/components/charts/DonutChart";
import EmptyState from "@/shared/components/EmptyState";
import { isUsageErrorStatus } from "@/shared/constants/usageStatus";
import { fmt } from "./format";

export default function OverviewErrorDonut({ stats }) {
  const { okCount, errCount, total, ratePct } = useMemo(() => {
    const counts = stats?.statusCounts || {};
    let total = 0;
    let err = 0;
    for (const [key, val] of Object.entries(counts)) {
      const n = Number(val) || 0;
      total += n;
      if (isUsageErrorStatus(key)) err += n;
    }
    // The server-computed errorCount is authoritative (same shared status
    // contract) — prefer it so the donut can never disagree with the KPI.
    if (typeof stats?.errorCount === "number" && stats.errorCount >= 0) err = stats.errorCount;
    return {
      okCount: Math.max(0, total - err),
      errCount: err,
      total,
      ratePct: total > 0 ? (err / total) * 100 : 0,
    };
  }, [stats]);

  // Prefer the server-computed errorRate (0-1) when present, it's authoritative.
  const serverRate = stats?.errorRate;
  const centerValue =
    serverRate != null ? `${(serverRate * 100).toFixed(1)}%` : `${ratePct.toFixed(1)}%`;

  const segments = [
    { value: okCount, color: "success", label: "Success" },
    { value: errCount, color: "danger", label: "Error" },
  ];

  return (
    <Card title="Success Rate" icon="check_circle" className="flex h-full min-w-0 flex-col">
      {total === 0 ? (
        <div className="flex flex-1 items-center justify-center py-6">
          <EmptyState
            icon="sentiment_neutral"
            title="No requests yet"
            description="Request outcomes will appear here once traffic flows through."
            className="border-0 p-0"
          />
        </div>
      ) : (
        <div className="flex flex-col items-center gap-5">
          <DonutChart
            segments={segments}
            size={150}
            thickness={16}
            centerValue={centerValue}
            centerLabel="error rate"
          />
          <div className="grid w-full grid-cols-2 gap-2">
            <div className="flex items-center gap-2 rounded-brand border border-border-subtle bg-surface-2 px-3 py-2">
              <span className="size-2.5 rounded-full bg-success" />
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-wide text-text-muted">Success</div>
                <div className="truncate text-sm font-semibold text-text-main">{fmt(okCount)}</div>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-brand border border-border-subtle bg-surface-2 px-3 py-2">
              <span className="size-2.5 rounded-full bg-danger" />
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-wide text-text-muted">Errors</div>
                <div className="truncate text-sm font-semibold text-text-main">{fmt(errCount)}</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

OverviewErrorDonut.propTypes = {
  stats: PropTypes.object,
};
