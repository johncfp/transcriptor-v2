import { useEffect, useState, type DragEvent } from "react";
import type { KeyStatus } from "../../../shared/api";
import { AUDIO_EXTENSIONS, formatBytes, hasTranscript, type AddFilesResult, type Job } from "../../../shared/jobs";
import { formatTimestamp } from "../../../shared/transcript";
import { useJobs } from "../useJobs";

const STATUS_LABEL: Record<Job["status"], string> = {
  "awaiting-approval": "Waiting for approval",
  queued: "Queued",
  transcribing: "Transcribing",
  "needs-review": "Needs review",
  ready: "Ready for show notes",
  writing: "Writing show notes",
  written: "Show notes ready",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function EpisodesScreen(props: { onOpen: (id: string) => void; onOpenSettings: () => void }) {
  const jobs = useJobs();
  const [keys, setKeys] = useState<KeyStatus[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<AddFilesResult["rejected"]>([]);
  const [query, setQuery] = useState("");

  // Re-check on every queue change too: a key may have been added since this screen opened.
  useEffect(() => {
    void window.api.listKeys().then(setKeys);
  }, [jobs]);

  const handleResult = (result: AddFilesResult) => setRejected(result.rejected);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean);
    if (paths.length) void window.api.addFiles(paths).then(handleResult);
  };

  const missingTranscriptionKey = keys !== null && !keys.some((k) => k.providerId === "elevenlabs" && k.saved);

  return (
    <div
      className="episodes"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <div className="page-head">
        <h1>Episodes</h1>
        <div className="head-actions">
          <input
            className="input search"
            type="search"
            placeholder="Search episodes"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search episodes"
          />
          <button className="button primary" onClick={() => void window.api.pickAudio().then(handleResult)}>
            Add audio…
          </button>
        </div>
      </div>

      {missingTranscriptionKey && (
        <div className="callout">
          <p>
            Add an <strong>ElevenLabs</strong> API key before your first episode.
          </p>
          <button className="button" onClick={props.onOpenSettings}>
            Open Settings
          </button>
        </div>
      )}

      {rejected.length > 0 && (
        <div className="notice error" role="alert">
          {rejected.map((r) => (
            <div key={r.fileName}>
              <strong>{r.fileName}</strong>: {r.reason}
            </div>
          ))}
        </div>
      )}

      <div className={`dropzone${dragging ? " active" : ""}`}>
        <p className="empty-title">Drop audio files here</p>
        <p className="muted">{AUDIO_EXTENSIONS.map((e) => e.toUpperCase()).join(", ")}</p>
      </div>

      {jobs && jobs.length > 0 && (
        <ul className="job-list">
          {[...jobs]
            .reverse()
            .filter((job) => matches(job, query))
            .map((job) => (
              <JobRow key={job.id} job={job} onOpen={() => props.onOpen(job.id)} />
            ))}
        </ul>
      )}
      {jobs && query.trim() && !jobs.some((job) => matches(job, query)) && (
        <p className="muted">No episodes match “{query.trim()}”.</p>
      )}
    </div>
  );
}

/** Every word of the query appears in the file name, episode number, title, guest or status. */
function matches(job: Job, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = [job.fileName, job.episodeNumber && `episode ${job.episodeNumber}`, job.title, job.guest, STATUS_LABEL[job.status]]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return words.every((w) => haystack.includes(w));
}

function JobRow({ job, onOpen }: { job: Job; onOpen: () => void }) {
  const { id } = job;
  const meta = hasTranscript(job)
      ? [
          job.title && job.fileName,
          job.durationSec !== undefined && formatTimestamp(job.durationSec),
          job.speakerCount !== undefined && `${job.speakerCount} speaker${job.speakerCount === 1 ? "" : "s"}`,
          job.wordCount !== undefined && `${job.wordCount.toLocaleString()} words`,
        ]
          .filter(Boolean)
          .join(" · ")
      : formatBytes(job.fileSize);

  return (
    <li className="job">
      <div className="job-main">
        <div className="job-title">
          <span className="job-name" title={job.filePath}>
            {job.title ? `${job.episodeNumber ? `Episode ${job.episodeNumber}: ` : ""}${job.title}` : job.fileName}
          </span>
          <span className={`pill ${job.status}`}>{STATUS_LABEL[job.status]}</span>
        </div>
        <div className="hint">{(job.status === "transcribing" || job.status === "writing") && job.stage ? job.stage : meta}</div>
        {job.status === "transcribing" && <Progress value={job.progress ?? null} />}
        {job.status === "writing" && job.stage !== "Waiting" && <Progress value={null} />}
        {job.status === "failed" && job.error && <div className="hint error">{job.error}</div>}
      </div>
      <div className="job-actions">
        {job.status === "awaiting-approval" && (
          <button className="button primary" onClick={() => void window.api.approveJob(id)}>
            Start
          </button>
        )}
        {job.status === "needs-review" && (
          <button className="button primary" onClick={onOpen}>
            Review
          </button>
        )}
        {(job.status === "ready" || job.status === "written") && (
          <button className={job.status === "written" ? "button primary" : "button"} onClick={onOpen}>
            Open
          </button>
        )}
        {job.status === "failed" && job.failedStep === "writing" && (
          <button className="button" onClick={onOpen}>
            Open
          </button>
        )}
        {(job.status === "failed" || job.status === "cancelled") && (
          <button className="button" onClick={() => void window.api.retryJob(id)}>
            Retry
          </button>
        )}
        {(job.status === "transcribing" || job.status === "writing" || job.status === "queued" || job.status === "awaiting-approval") && (
          <button className="button ghost" onClick={() => void window.api.cancelJob(id)}>
            Cancel
          </button>
        )}
        {job.status !== "writing" && (hasTranscript(job) || job.status === "failed" || job.status === "cancelled") && (
          <button
            className="button ghost"
            onClick={() => {
              const extra = hasTranscript(job) ? " and its transcript and show notes" : "";
              if (confirm(`Remove ${job.fileName}${extra} from Transcriptor 2? The audio file itself is kept.`)) {
                void window.api.removeJob(id);
              }
            }}
          >
            Remove
          </button>
        )}
      </div>
    </li>
  );
}

function Progress({ value }: { value: number | null }) {
  return (
    <div
      className={`progress${value === null ? " indeterminate" : ""}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null ? undefined : Math.round(value * 100)}
    >
      <div className="progress-bar" style={value === null ? undefined : { width: `${value * 100}%` }} />
    </div>
  );
}
