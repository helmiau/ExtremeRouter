"use client";

import Card from "@/shared/components/Card";

export default function EmptyState({ icon, title, description }) {
  return (
    <Card padding="lg">
      <div className="text-center py-12">
        <span className="material-symbols-outlined text-[64px] text-text-muted opacity-20">
          {icon}
        </span>
        <h3 className="mt-4 text-lg font-semibold text-text-primary">
          {title}
        </h3>
        <p className="mt-2 text-sm text-text-muted max-w-md mx-auto">
          {description}
        </p>
      </div>
    </Card>
  );
}
