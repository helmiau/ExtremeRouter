"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Card, Badge, Button, PageHeader, AddCustomEmbeddingModal } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { AI_PROVIDERS, getProvidersByKind } from "@/shared/constants/providers";
import { getProviderIconPath } from "@/shared/utils/providerIcon";

// Hub for media providers: Text to Image, STT, TTS. Lists built-in providers and
// self-hosted custom nodes (whisper.cpp, Kokoro-FastAPI...). Combo listing is
// intentionally omitted — image/tts combo creation is disabled (COMBO_KINDS empty).
const SECTIONS = [
  { kind: "image", title: "Text to Image", icon: "brush", nodeType: null, addLabel: "" },
  { kind: "video", title: "Text to Video", icon: "movie", nodeType: null, addLabel: "" },
  { kind: "stt", title: "Speech To Text", icon: "mic", nodeType: "custom-stt", addLabel: "STT" },
  { kind: "tts", title: "Text To Speech", icon: "record_voice_over", nodeType: "custom-tts", addLabel: "TTS" },
];

const CUSTOM_ICON_BY_TYPE = {
  "custom-stt": { color: "#DC2626", textIcon: "ST" },
  "custom-tts": { color: "#10B981", textIcon: "TT" },
};

function getEffectiveStatus(conn) {
  const isCooldown = Object.entries(conn).some(
    ([k, v]) => k.startsWith("modelLock_") && v && new Date(v).getTime() > Date.now()
  );
  return conn.testStatus === "unavailable" && !isCooldown ? "active" : conn.testStatus;
}

function ProviderCard({ provider, kind, connections, isCustom }) {
  const isNoAuth = !!AI_PROVIDERS[provider.id]?.noAuth;
  const providerConns = (connections || []).filter((c) => c.provider === provider.id);
  const connected = providerConns.filter((c) => { const s = getEffectiveStatus(c); return s === "active" || s === "success"; }).length;
  const error = providerConns.filter((c) => { const s = getEffectiveStatus(c); return s === "error" || s === "expired" || s === "unavailable"; }).length;
  const total = providerConns.length;

  const renderStatus = () => {
    if (isNoAuth) return <Badge variant="success" size="sm">Ready</Badge>;
    if (total === 0) return <span className="text-xs text-text-muted">No connections</span>;
    return (
      <>
        {connected > 0 && <Badge variant="success" size="sm" dot>{connected} Connected</Badge>}
        {error > 0 && <Badge variant="error" size="sm" dot>{error} Error</Badge>}
        {connected === 0 && error === 0 && <Badge variant="default" size="sm">{total} Added</Badge>}
      </>
    );
  };

  return (
    <Link href={`/dashboard/media-providers/${kind}/${provider.id}`} className="group">
      <Card padding="xs" className="h-full hover:bg-black/[0.01] dark:hover:bg-white/[0.01] transition-colors cursor-pointer">
        <div className="flex min-w-0 items-center gap-3">
          <div
            className="size-8 rounded-lg flex items-center justify-center shrink-0"
            style={{ backgroundColor: `${provider.color?.length > 7 ? provider.color : (provider.color ?? "#888") + "15"}` }}
          >
            <ProviderIcon
              src={getProviderIconPath(provider.id)}
              alt={provider.name}
              size={30}
              className="object-contain rounded-lg max-w-[30px] max-h-[30px]"
              fallbackText={provider.textIcon || provider.id.slice(0, 2).toUpperCase()}
              fallbackColor={provider.color}
            />
          </div>
          <div>
            <h3 className="font-semibold text-sm">{provider.name}</h3>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              {isCustom && <Badge variant="default" size="sm">Custom</Badge>}
              {renderStatus()}
            </div>
          </div>
        </div>
      </Card>
    </Link>
  );
}

function Section({ title, icon, kind, connections, providers, custom, addLabel, onAddCustom }) {
  const all = [...providers, ...custom];
  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="material-symbols-outlined text-primary">{icon}</span>
          <h2 className="text-base font-semibold">{title}</h2>
          <span className="text-xs text-text-muted">({providers.length} providers · {custom.length} custom)</span>
        </div>
        {onAddCustom && (
          <Button size="sm" icon="add" onClick={onAddCustom}>Add Custom {addLabel}</Button>
        )}
      </div>
      {all.length === 0 ? (
        <div className="text-center py-8 border border-dashed border-border rounded-xl text-text-muted text-sm">
          No providers.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {all.map((p) => (
            <ProviderCard key={p.id} provider={p} kind={kind} connections={connections} isCustom={p.isCustom} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function MediaProvidersPage() {
  const [connections, setConnections] = useState([]);
  const [customNodes, setCustomNodes] = useState([]);
  const [addType, setAddType] = useState(null);

  useEffect(() => {
    fetch("/api/providers", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setConnections(d.connections || []))
      .catch(() => {});
    fetch("/api/provider-nodes", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setCustomNodes((d.nodes || []).filter((n) => ["custom-stt", "custom-tts"].includes(n.type))))
      .catch(() => {});
  }, []);

  const handleCreated = (node) => {
    setCustomNodes((prev) => [...prev, node]);
    setAddType(null);
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Media Providers"
        description="Text to Image, speech-to-text, and text-to-speech providers"
        icon="perm_media"
      />
      {SECTIONS.map((sec) => {
        const providers = getProvidersByKind(sec.kind).map((p) => ({ ...p }));
        const custom = customNodes
          .filter((n) => n.type === sec.nodeType)
          .map((n) => ({
            id: n.id,
            name: n.name || `Custom ${sec.addLabel}`,
            isCustom: true,
            ...(CUSTOM_ICON_BY_TYPE[sec.nodeType] || { color: "#6366F1", textIcon: "CE" }),
          }));
        return (
          <div key={sec.kind}>
            <Section
              title={sec.title}
              icon={sec.icon}
              kind={sec.kind}
              providers={providers}
              custom={custom}
              connections={connections}
              addLabel={sec.addLabel}
              onAddCustom={sec.nodeType ? () => setAddType(sec.nodeType) : null}
            />
            {sec !== SECTIONS[SECTIONS.length - 1] && <div className="my-6 border-t border-border" />}
          </div>
        );
      })}

      <AddCustomEmbeddingModal
        isOpen={!!addType}
        nodeType={addType || "custom-stt"}
        onClose={() => setAddType(null)}
        onCreated={handleCreated}
      />
    </div>
  );
}