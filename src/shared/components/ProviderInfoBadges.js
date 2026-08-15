"use client";

import Badge from "./Badge";
import { PROVIDER_INFO_BADGES } from "@/shared/constants/providerInfoBadges";

// ProviderInfoBadges — small caveat chips for providers with notable usage
// requirements (anti-bot sensitivity, browser/CAPTCHA, guest limits, full
// cookie headers). Data-driven from PROVIDER_INFO_BADGES; renders nothing for
// providers without entries, so it is safe to mount unconditionally.
export default function ProviderInfoBadges({ providerId, className }) {
  const badges = providerId ? PROVIDER_INFO_BADGES[providerId] : null;
  if (!badges || badges.length === 0) return null;

  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className || ""}`}>
      {badges.map((badge, i) => (
        <span key={i} title={badge.title} className="inline-flex">
          <Badge variant={badge.variant} size="sm" icon={badge.icon} className="cursor-help">
            {badge.label}
          </Badge>
        </span>
      ))}
    </div>
  );
}
