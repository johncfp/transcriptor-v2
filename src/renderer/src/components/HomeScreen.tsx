import { useEffect, useState } from "react";
import type { KeyStatus } from "../../../shared/api";
import { PROVIDERS } from "../../../shared/providers";

/** Episode queue. Adding audio arrives in M1; for now it shows setup status. */
export function HomeScreen({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [keys, setKeys] = useState<KeyStatus[] | null>(null);

  useEffect(() => {
    void window.api.listKeys().then(setKeys);
  }, []);

  const hasRole = (role: "transcription" | "writing") =>
    keys?.some((k) => k.saved && PROVIDERS.find((p) => p.id === k.providerId)?.role === role);

  return (
    <>
      <h1>Episodes</h1>
      <div className="empty">
        <p className="empty-title">No episodes yet</p>
        <p className="muted">Adding audio files comes in the next build.</p>
      </div>
      {keys && (!hasRole("transcription") || !hasRole("writing")) && (
        <div className="callout">
          <p>
            Before your first episode, add a{" "}
            {!hasRole("transcription") && <strong>transcription</strong>}
            {!hasRole("transcription") && !hasRole("writing") && " and a "}
            {!hasRole("writing") && <strong>writing</strong>} API key.
          </p>
          <button className="button" onClick={onOpenSettings}>
            Open Settings
          </button>
        </div>
      )}
    </>
  );
}
