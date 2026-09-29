import { useEffect, useState } from "react";
import type { FolderWatchStatus, StuckFile } from "../../../shared/api";
import type { Settings, SettingsPatch } from "../../../shared/settings";
import { Section } from "./Section";

const cleanError = (err: unknown) =>
  String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

const SETTLE_CHOICES = [1, 5, 15];

/** "3 hours ago", "20 minutes ago". */
function ago(at: number): string {
  const minutes = Math.max(1, Math.round((Date.now() - at) / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * Watching a folder that Google Drive for Desktop keeps in sync. Only the
 * saved settings drive the watcher, so the status line says when a change
 * still needs Save.
 */
export function FolderWatchSection({ settings, update }: { settings: Settings; update: (p: SettingsPatch) => void }) {
  const { folderWatch } = settings;
  const [drive, setDrive] = useState<string | null | undefined>(undefined);
  const [status, setStatus] = useState<FolderWatchStatus | null>(null);
  const [stuck, setStuck] = useState<StuckFile[]>([]);
  const [taking, setTaking] = useState<string | null>(null);
  const [takeError, setTakeError] = useState("");

  useEffect(() => {
    void window.api.driveForDesktop().then(setDrive);
    const poll = () => {
      void window.api.folderWatchStatus().then(setStatus);
      void window.api.stuckFiles().then(setStuck);
    };
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
      <div className="row">
        <div className="row-label">
          <span>Wait for other computers</span>
          <span className="hint">
            How long to let other computers' claims on a new file sync before taking it. Raise it if Drive syncs slowly
            for your team.
          </span>
        </div>
        <div className="row-control">
          <select
            className="input select"
            aria-label="Wait for other computers"
            value={folderWatch.settleMinutes}
            onChange={(e) => update({ folderWatch: { ...folderWatch, settleMinutes: Number(e.target.value) } })}
          >
            {SETTLE_CHOICES.map((m) => (
              <option key={m} value={m}>
                {m} minute{m === 1 ? "" : "s"}
              </option>
            ))}
          </select>
        </div>
      </div>
      {running && stuck.length > 0 && (
        <div className="stuck">
          <p className="hint warn">
            {stuck.length === 1 ? "This file was" : "These files were"} claimed by another computer but not finished.
            Take one over only if that computer is off or isn't running Transcriptor 2; otherwise both may transcribe
            it.
          </p>
          <ul className="stuck-list" aria-label="Unfinished files">
            {stuck.map((f) => (
              <li key={f.key}>
                <span>
                  <b>{f.file}</b>
                  <span className="hint">
                    {" "}
                    Claimed by {f.claimedBy} {ago(f.claimedAt)}
                  </span>
                </span>
                <button
                  className="button"
                  disabled={taking !== null}
                  onClick={async () => {
                    setTaking(f.key);
                    setTakeError("");
                    try {
                      await window.api.takeOverFile(f.key);
                      setStuck(await window.api.stuckFiles());
                    } catch (err) {
                      setTakeError(cleanError(err));
                    } finally {
                      setTaking(null);
                    }
                  }}
                >
                  {taking === f.key ? "Taking over…" : "Take over"}
                </button>
              </li>
            ))}
          </ul>
          {takeError && <p className="hint error">{takeError}</p>}
        </div>
      )}
      <p className="notice watch-warning" role="note">
        <b>Sharing a folder with teammates?</b> If possible, have just one computer watch it. Computers coordinate
        through Drive, and if Drive syncs very slowly two of them can still start the same episode; each checks again
        just before transcribing, which catches most of these, but not all. A file whose computer went away shows up
        above after 15 minutes, to take over by hand.
      </p>
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
