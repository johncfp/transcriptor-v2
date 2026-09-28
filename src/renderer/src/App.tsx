import { useEffect, useState } from "react";
import { HomeScreen } from "./components/HomeScreen";
import { SettingsScreen } from "./components/SettingsScreen";

type Screen = "home" | "settings";

export function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [version, setVersion] = useState("");

  useEffect(() => {
    void window.api.appVersion().then(setVersion);
  }, []);

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <span className="brand-name">Transcriptor 2</span>
          {version && <span className="brand-version">v{version}</span>}
        </div>
        <button
          className="nav-item"
          aria-current={screen === "home" ? "page" : undefined}
          onClick={() => setScreen("home")}
        >
          Episodes
        </button>
        <button
          className="nav-item"
          aria-current={screen === "settings" ? "page" : undefined}
          onClick={() => setScreen("settings")}
        >
          Settings
        </button>
      </nav>
      <main className="content">
        {screen === "home" ? (
          <HomeScreen onOpenSettings={() => setScreen("settings")} />
        ) : (
          <SettingsScreen />
        )}
      </main>
    </div>
  );
}
