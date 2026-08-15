"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/shared/components";

// ZaiProfile — badge info for the connected Z.ai web session, following the
// same pattern as FreeBuffProfile/FeloProfile. Fetches
// /api/providers/[id]/zai-profile on mount (identity from the token JWT +
// a live session check). Surfaced states:
//   * guest session  → warning badge (chat.z.ai only allows GLM-4.7 for guests)
//   * signed-in      → success badge
//   * invalid/expired session → hint to re-capture the token
export default function ZaiProfile({ connectionId }) {
  const [profile, setProfile] = useState(null);
  const [notice, setNotice] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!connectionId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/providers/${connectionId}/zai-profile`, { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) setProfile(data);
        } else if (res.status === 400 || res.status === 401) {
          // Missing / invalid / expired session — surface a hint so the user
          // knows to re-capture the token.
          const err = await res.json().catch(() => ({}));
          if (!cancelled) setNotice(err?.message || "Z.ai profile unavailable");
        }
      } catch {
        // non-fatal
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [connectionId]);

  if (loading) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-border-subtle bg-surface-2/50 px-3 py-2">
        <div className="size-8 animate-pulse rounded-full bg-sidebar" />
        <div className="flex flex-col gap-1">
          <div className="h-3 w-32 animate-pulse rounded bg-sidebar" />
          <div className="h-2 w-48 animate-pulse rounded bg-sidebar" />
        </div>
      </div>
    );
  }

  if (!profile) {
    if (notice) {
      return (
        <div className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-2/50 px-3 py-2 text-xs text-text-muted">
          <span className="material-symbols-outlined text-[14px] text-warning">badge</span>
          <span className="min-w-0">{notice}</span>
        </div>
      );
    }
    return null;
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border-subtle bg-surface-2/50 px-3 py-2">
      {profile.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={profile.image}
          alt={profile.name}
          className="size-9 rounded-full object-cover ring-2 ring-border-subtle"
        />
      ) : (
        <div className="flex size-9 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
          {profile.name?.charAt(0)?.toUpperCase() || "Z"}
        </div>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-text-main">{profile.name}</p>
          {profile.email && (
            <span className="truncate text-xs text-text-muted">{profile.email}</span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5">
          {profile.isGuest ? (
            <Badge variant="warning" size="sm" icon="person">
              Guest — GLM-4.7 only
            </Badge>
          ) : (
            <Badge variant="success" size="sm" icon="check_circle">
              Signed in
            </Badge>
          )}
          <span className="text-[11px] text-text-muted">Z.ai web session</span>
        </div>
      </div>
    </div>
  );
}
