import { useEffect, useState } from "react";
import type { FolderWatchStatus } from "../../../shared/api";
import type { Settings, SettingsPatch } from "../../../shared/settings";
import { Section } from "./Section";

/**
 * Watching a folder that Google Drive for Desktop keeps in sync. Only the
 * saved settings drive the watcher, so the status line says when a change
 * still needs Save.
 */
export function FolderWatchSection({ settings, update }: { settings: Settings; update: (p: SettingsPatch) => void }) {
  const { folderWatch } = settings;
  const [drive, setDrive] = useState<string | null | undefined>(undefined);
  const [status, setStatus] = useState<FolderWatchStatus | null>(null);

  useEffect(() => {
    void window.api.driveForDesktop().then(setDrive);
    const poll = () => void window.api.folderWatchStatus().then(setStatus);
    poll();
    const timer = setInterval(poll, 3000);
    return () => clearInterval(timer);
  }, []);

  const running = status !== null && status.root === folderWatch.folder && folderWatch.enabled;

  return (
    <Section
      title="Watch a Drive folder"
      intro="New episode audio added to this folder, or to any folder inside it, is picked up and transcribed. It works with Google Drive for Desktop, which keeps the folder in sync on this computer, so there's no Google sign-in."
    >
      <div className="row">
        <div className="row-label">
          <span>Google Drive for Desktop</span>
          <span className={`hint${drive === null ? " warn" : ""}`}>
            {drive === undefined
              ? "Looking…"
              : drive
                ? `Found: ${drive}`
                : "Not found on this computer. Install it from Google and sign in, or choose any folder that's kept in sync."}
          </span>
        </div>
      </div>
      <div className="row">
        <div className="row-label">
          <span>Folder to watch</span>
          <span className="hint">A shared folder works too, so a team can drop episodes into one place.</span>
        </div>
        <div className="folder">
          <code className="folder-path" title={folderWatch.folder}>
            {folderWatch.folder || "None chosen"}
          </code>
          <button
            className="button"
            onClick={async () => {
              const picked = await window.api.pickWatchFolder();
              if (picked) update({ folderWatch: { ...folderWatch, folder: picked } });
            }}
          >
            Choose…
          </button>
        </div>
      </div>
      <label className="row toggle-row">
        <div className="row-label">
          <span>Watch this folder</span>
          <span className="hint">
            {!folderWatch.folder
              ? "Choose a folder first."
              : !folderWatch.enabled
                ? "Off."
                : running
                  ? status.error
                    ? status.error
                    : `Watching. ${status.pickedUp} ${status.pickedUp === 1 ? "file" : "files"} picked up since the app started` +
                      (status.waiting ? `, ${status.waiting} waiting to finish syncing` : "") +
                      (status.lastScan ? `. Last checked ${new Date(status.lastScan).toLocaleTimeString()}.` : ".")
                  : "Press Save to start watching."}
          </span>
        </div>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={folderWatch.enabled}
          disabled={!folderWatch.folder}
          onChange={(e) => update({ folderWatch: { ...folderWatch, enabled: e.target.checked } })}
        />
      </label>
      <ul className="watch-notes">
        <li>Files already in the folder when watching starts are left alone.</li>
        <li>
          A new file is picked up once it has finished syncing. With “Ask me before processing” on (General tab), you
          approve each one first.
        </li>
        <li>
          Once it's transcribed, the file moves into <b>Done</b> inside the watched folder, keeping its subfolder.
        </li>
        <li>
          The transcript, show notes and reference file are saved in <b>Transcriptor Exports</b> inside the watched
          folder, so Drive syncs them for everyone.
        </li>
        <li>
          If teammates watch the same folder, only one computer takes each file; they coordinate through a hidden
          .transcriptor folder. Files are only picked up while the app is running (it keeps running in the tray).
        </li>
      </ul>
    </Section>
  );
}
