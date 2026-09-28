import { useEffect, useState } from "react";
import type { Settings, SettingsPatch } from "../../../shared/settings";
import { Section } from "./Section";

const cleanError = (err: unknown) =>
  String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/**
 * Settings for watching a Google Drive folder (M5).
 *
 * NOT RENDERED YET: the feature is built but switched off. To turn it on, see
 * the Drive block in src/main/index.ts, then add
 * `<DriveWatchSection settings={settings} update={update} />` to SettingsScreen.
 */
export function DriveWatchSection({ settings, update }: { settings: Settings; update: (p: SettingsPatch) => void }) {
  const [status, setStatus] = useState<{ configured: boolean; signedIn: boolean } | null>(null);
  const [folder, setFolder] = useState(settings.watch.folderId);
  const [error, setError] = useState("");

  const refresh = () => void window.api.driveStatus().then(setStatus);
  useEffect(refresh, []);

  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(cleanError(err));
    }
    refresh();
  };

  return (
    <Section
      title="Watch a Google Drive folder"
      intro="New audio files added to the folder are downloaded and queued. With “Ask me before processing” on, you get a notification to approve each one first. Files already in the folder when watching starts are left alone."
    >
      {status && !status.configured && <p className="hint warn">Google Drive isn't set up in this build yet.</p>}
      <div className="row">
        <div className="row-label">
          <span>Google account</span>
          <span className="hint">Read-only access, to see and download files in the folder.</span>
        </div>
        {status?.signedIn ? (
          <button className="button" onClick={() => void run(() => window.api.driveSignOut())}>
            Sign out
          </button>
        ) : (
          <button className="button" disabled={!status?.configured} onClick={() => void run(() => window.api.driveSignIn())}>
            Sign in with Google…
          </button>
        )}
      </div>
      <div className="row">
        <div className="row-label">
          <span>Folder</span>
          <span className="hint">Paste the folder's link from Google Drive.</span>
        </div>
        <input
          className="input"
          value={folder}
          placeholder="https://drive.google.com/drive/folders/…"
          onChange={(e) => setFolder(e.target.value)}
          onBlur={() => folder.trim() && folder !== settings.watch.folderId && void run(async () => setFolder(await window.api.driveSetFolder(folder)))}
        />
      </div>
      <label className="row toggle-row">
        <div className="row-label">
          <span>Watch this folder</span>
          <span className="hint">Checks every 5 minutes while Transcriptor 2 is running.</span>
        </div>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          disabled={!status?.signedIn || !settings.watch.folderId}
          checked={settings.watch.enabled}
          onChange={(e) => update({ watch: { enabled: e.target.checked } })}
        />
      </label>
      {error && <p className="hint error">{error}</p>}
    </Section>
  );
}
