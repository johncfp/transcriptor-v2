import { useEffect, useState } from "react";
import { EpisodesScreen } from "./components/EpisodesScreen";
import { SettingsScreen } from "./components/SettingsScreen";
import { TranscriptScreen } from "./components/TranscriptScreen";

type Screen = { name: "episodes" } | { name: "transcript"; jobId: string } | { name: "settings" };

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: "episodes" });
  const [version, setVersion] = useState("");

  useEffect(() => {
    void window.api.appVersion().then(setVersion);
    // A clicked notification opens that episode.
    return window.api.onShowJob((jobId) => setScreen({ name: "transcript", jobId }));
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
