"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import Button from "@/shared/components/Button";

// One-click capture of the logged-in Felo session from the user's running
// Brave (started via brave-extremerouter.cmd with --remote-debugging-port).
// Calls POST /api/providers/felo-capture, then hands the ready-to-paste
// credential string to onCaptured so the modal can fill its API key field.
//
// Logged-in Felo sessions authenticate via `Authorization: Bearer 6h_...`
// (the felo-user-token cookie value) — no Turnstile cf_token needed.
export default function FeloCaptureButton({ onCaptured }) {
  const [capturing, setCapturing] = useState(false);
  const [status, setStatus] = useState(null); // { ok, message, profile }

  const handleCapture = async () => {
    setCapturing(true);
    setStatus(null);
    try {
      const res = await fetch("/api/providers/felo-capture", { method: "POST" });
      const data = await res.json();
      if (res.ok && data.credential) {
        setStatus({
          ok: true,
          message: data.profile ? `Captured — session valid` : "Captured — session cookie found",
          profile: data.profile,
        });
        onCaptured?.(data.credential, data.profile);
      } else {
        setStatus({ ok: false, message: data.message || data.error || "Capture failed" });
      }
    } catch {
      setStatus({ ok: false, message: "Capture failed — is the app server running?" });
    } finally {
      setCapturing(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button
          onClick={handleCapture}
          variant="outline"
          size="sm"
          icon="language"
          loading={capturing}
          disabled={capturing}
        >
          {capturing ? "Capturing..." : "Capture from Felo"}
        </Button>
        <span className="text-xs text-text-muted">reads your session from the running Brave tab</span>
      </div>
      {status && (
        <div className={status.ok ? "text-xs text-green-400" : "text-xs text-yellow-400 break-words"}>
          {status.ok && status.profile && (
            <div className="flex items-center gap-2 mb-1">
              {status.profile.image && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={status.profile.image} alt="" className="h-5 w-5 rounded-full" />
              )}
              <span className="font-medium">{status.profile.name}</span>
              {status.profile.email && <span className="text-text-muted">({status.profile.email})</span>}
            </div>
          )}
          {status.message}
        </div>
      )}
    </div>
  );
}

FeloCaptureButton.propTypes = {
  onCaptured: PropTypes.func,
};
