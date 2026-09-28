import { useEffect, useState } from "react";
import type { Settings } from "../../../shared/settings";
import { formatTimestamp } from "../../../shared/transcript";
import { useJobs } from "../useJobs";
import { TranscriptTab } from "./ReviewScreen";
import { ShowNotesPanel } from "./ShowNotesPanel";

type Tab = "transcript" | "notes";

/** One episode: the transcript to review, and its show notes. */
export function EpisodeScreen({ jobId, onBack }: { jobId: string; onBack: () => void }) {
  const job = useJobs()?.find((j) => j.id === jobId);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tab, setTab] = useState<Tab | null>(null);

  useEffect(() => {
    void window.api.getSettings().then(setSettings);
  }, []);

  // Open on whichever step is next: review first, then the notes.
  useEffect(() => {
    if (job && tab === null) setTab(job.status === "needs-review" ? "transcript" : "notes");
  }, [job, tab]);

  if (!job || !settings || !tab) return null;

  return (
    <div className="review">
      <div className="page-head">
        <div>
          <button className="button ghost back" onClick={onBack}>
            ← Episodes
          </button>
          <h1>{job.fileName}</h1>
          <p className="muted head-meta">
            {job.durationSec !== undefined && `${formatTimestamp(job.durationSec)} · `}
            {job.wordCount?.toLocaleString()} words
          </p>
        </div>
        {job.status === "needs-review" ? (
          <button
            className="button primary"
            onClick={() => {
              void window.api.markReviewed(job.id);
              setTab("notes");
            }}
          >
            Mark as reviewed
          </button>
        ) : (
          <span className="pill ready">Reviewed</span>
        )}
      </div>

      <div className="tabs" role="tablist">
        <button role="tab" className="tab" aria-selected={tab === "transcript"} onClick={() => setTab("transcript")}>
          Transcript
        </button>
        <button role="tab" className="tab" aria-selected={tab === "notes"} onClick={() => setTab("notes")}>
          Show notes
          {job.status === "writing" && <span className="tab-dot" aria-label="writing" />}
        </button>
      </div>

      {tab === "transcript" ? <TranscriptTab jobId={job.id} /> : <ShowNotesPanel job={job} settings={settings} />}
    </div>
  );
}
