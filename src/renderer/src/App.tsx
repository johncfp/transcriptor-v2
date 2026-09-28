import { useEffect, useRef, useState } from "react";
import type { UpdateStatus } from "../../shared/api";
import { EpisodesScreen } from "./components/EpisodesScreen";
import { EpisodeScreen } from "./components/EpisodeScreen";
import { SettingsScreen, type SettingsGuard } from "./components/SettingsScreen";
import { UnsavedDialog } from "./components/UnsavedDialog";

type Screen = { name: "episodes" } | { name: "transcript"; jobId: string } | { name: "settings" };

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: "episodes" });
  const [update, setUpdate] = useState<UpdateStatus>({ state: "idle" });
  /** Where the user was heading when Settings had unsaved changes. */
  const [pending, setPending] = useState<Screen | null>(null);
  const settingsGuard = useRef<SettingsGuard | null>(null);

  /** Change screens, but ask first when leaving Settings with unsaved changes. */
  const goRef = useRef((next: Screen) => setScreen(next));
  goRef.current = (next: Screen) => {
    if (screen.name === "settings" && next.name !== "settings" && settingsGuard.current?.dirty) setPending(next);
    else setScreen(next);
  };
  const go = (next: Screen) => goRef.current(next);

  useEffect(() => {
    void window.api.getUpdateStatus().then(setUpdate);
    const offUpdate = window.api.onUpdateStatus(setUpdate);
    // A clicked notification opens that episode (through the same unsaved-changes check).
    const offShow = window.api.onShowJob((jobId) => goRef.current({ name: "transcript", jobId }));
    return () => {
      offUpdate();
      offShow();
    };
  }, []);

  const onEpisodes = screen.name !== "settings";

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <span className="brand-name">Transcriptor 2</span>
          <span className="brand-steps">Upload | Transcribe | Export</span>
        </div>
        <button className="nav-item" aria-current={onEpisodes ? "page" : undefined} onClick={() => go({ name: "episodes" })}>
          Episodes
        </button>
        <button className="nav-item" aria-current={!onEpisodes ? "page" : undefined} onClick={() => go({ name: "settings" })}>
          Settings
        </button>
        <UpdateNotice status={update} />
      </nav>
      <main className={screen.name === "transcript" ? "content full" : "content"}>
        {screen.name === "episodes" && (
          <EpisodesScreen
            onOpen={(jobId) => go({ name: "transcript", jobId })}
            onOpenSettings={() => go({ name: "settings" })}
          />
        )}
        {screen.name === "transcript" && (
          <EpisodeScreen key={screen.jobId} jobId={screen.jobId} onBack={() => go({ name: "episodes" })} />
        )}
        {screen.name === "settings" && <SettingsScreen guard={settingsGuard} />}
      </main>
      {pending && (
        <UnsavedDialog
          onSave={async () => {
            await settingsGuard.current?.save();
            setScreen(pending);
            setPending(null);
          }}
          onDiscard={() => {
            settingsGuard.current?.discard();
            setScreen(pending);
            setPending(null);
          }}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}

function UpdateNotice({ status }: { status: UpdateStatus }) {
  if (status.state === "idle" || status.state === "downloading") return null;
  return (
    <div className="update">
      <span>Version {status.version} is available.</span>
      {status.state === "ready" ? (
        <>
          <span className="hint">It installs the next time you quit.</span>
          <button className="button primary" onClick={() => void window.api.installUpdate()}>
            Restart now
          </button>
        </>
      ) : (
        <button className="button" onClick={() => void window.api.openExternal(status.url)}>
          Download
        </button>
      )}
    </div>
  );
}
