import { useEffect, useState } from "react";
import type { UpdateStatus } from "../../shared/api";
import { EpisodesScreen } from "./components/EpisodesScreen";
import { SettingsScreen } from "./components/SettingsScreen";
import { TranscriptScreen } from "./components/TranscriptScreen";

type Screen = { name: "episodes" } | { name: "transcript"; jobId: string } | { name: "settings" };

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: "episodes" });
  const [version, setVersion] = useState("");
  const [update, setUpdate] = useState<UpdateStatus>({ state: "idle" });

  useEffect(() => {
    void window.api.appVersion().then(setVersion);
    void window.api.getUpdateStatus().then(setUpdate);
    const offUpdate = window.api.onUpdateStatus(setUpdate);
    // A clicked notification opens that episode.
    const offShow = window.api.onShowJob((jobId) => setScreen({ name: "transcript", jobId }));
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
          {version && <span className="brand-version">v{version}</span>}
        </div>
        <button
          className="nav-item"
          aria-current={onEpisodes ? "page" : undefined}
          onClick={() => setScreen({ name: "episodes" })}
        >
          Episodes
        </button>
        <button
          className="nav-item"
          aria-current={!onEpisodes ? "page" : undefined}
          onClick={() => setScreen({ name: "settings" })}
        >
          Settings
        </button>
        <UpdateNotice status={update} />
      </nav>
      <main className="content">
        {screen.name === "episodes" && (
          <EpisodesScreen
            onOpen={(jobId) => setScreen({ name: "transcript", jobId })}
            onOpenSettings={() => setScreen({ name: "settings" })}
          />
        )}
        {screen.name === "transcript" && (
          <TranscriptScreen key={screen.jobId} jobId={screen.jobId} onBack={() => setScreen({ name: "episodes" })} />
        )}
        {screen.name === "settings" && <SettingsScreen />}
      </main>
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
