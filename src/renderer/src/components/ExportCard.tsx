import { useEffect, useState } from "react";
import type { ExportFormat } from "../../../shared/exportDocs";
import type { Job } from "../../../shared/jobs";
import type { Settings } from "../../../shared/settings";
import { Section } from "./Section";

const cleanError = (err: unknown) =>
  String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** Export this episode's documents as Word, PDF and/or text files. */
export function ExportCard({ job, settings, hasNotes }: { job: Job; settings: Settings; hasNotes: boolean }) {
  const { docx, pdf, txt } = settings.output.formats;
  const [formats, setFormats] = useState({ docx, pdf, txt });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setError(job.exportError ?? ""), [job.exportError]);

  const chosen = (Object.keys(formats) as ExportFormat[]).filter((f) => formats[f]);
  const subtitles = (["srt", "vtt"] as const).filter((f) => settings.output.subtitles[f]).map((f) => `.${f}`);
  const exported = job.exported;

  return (
    <Section title="Export">
      <div className="checks">
        <label className="check">
          <input type="checkbox" checked={formats.docx} onChange={(e) => setFormats({ ...formats, docx: e.target.checked })} />
          Word (.docx)
        </label>
        <label className="check">
          <input type="checkbox" checked={formats.pdf} onChange={(e) => setFormats({ ...formats, pdf: e.target.checked })} />
          PDF (.pdf)
        </label>
        <label className="check">
          <input type="checkbox" checked={formats.txt} onChange={(e) => setFormats({ ...formats, txt: e.target.checked })} />
          Plain text (.txt)
        </label>
        <label className="check disabled">
          <input type="checkbox" checked={false} disabled />
          Google Doc (not set up yet)
        </label>
      </div>
      <p className="hint">
        {hasNotes ? "Transcript, show notes and reference file." : "The transcript now; show notes and the reference file once they're written."}{" "}
        {subtitles.length > 0 && `Subtitles too (${subtitles.join(", ")}), as set in Settings › Output. `}
        Saved to {job.exportRoot || settings.output.folder || "Documents › Transcriptor 2"}, in a folder for this episode.
      </p>
      <div className="notes-actions">
        <button
          className="button primary"
          disabled={!chosen.length || busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await window.api.exportEpisode(job.id, chosen);
            } catch (err) {
              setError(cleanError(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Exporting…" : exported ? "Export again" : "Export"}
        </button>
        {exported && (
          <button className="button" onClick={() => void window.api.openFolder(exported.folder)}>
            Open folder
          </button>
        )}
      </div>
      {error && <p className="hint error">{error}</p>}
      {exported && !error && (
        <p className="hint">
          Exported {exported.files.length} file{exported.files.length === 1 ? "" : "s"} on {new Date(exported.at).toLocaleString()}.
        </p>
      )}
      {exported?.notes?.map((n) => (
        <p key={n} className="hint warn">
          {n}
        </p>
      ))}
    </Section>
  );
}
