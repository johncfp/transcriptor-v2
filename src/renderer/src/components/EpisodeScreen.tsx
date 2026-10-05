import { useEffect, useMemo, useState } from "react";
import { clampThresholds, DEFAULT_CONFIDENCE_THRESHOLDS } from "../../../shared/confidence";
import type { Settings } from "../../../shared/settings";
import { formatTimestamp } from "../../../shared/transcript";
import { useJobs } from "../useJobs";
import { TranscriptTab } from "./ReviewScreen";
import { ShowNotesPanel } from "./ShowNotesPanel";
import { ClipsPanel } from "./ClipsPanel";

type Tab = "transcript" | "notes" | "clips";

/** One episode: the transcript to review, its show notes, and its social clips. */
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

  // Stable between renders so the transcript's per-turn memo holds during playback.
  const bands = useMemo(() => (settings ? clampThresholds(settings.confidence) : DEFAULT_CONFIDENCE_THRESHOLDS), [settings]);

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
        <button role="tab" className="tab" aria-selected={tab === "clips"} onClick={() => setTab("clips")}>
          Clips
          {(job.social?.status === "queued" || job.social?.status === "running") && <span className="tab-dot" aria-label="picking clips" />}
        </button>
      </div>

      {tab === "transcript" ? (
        <TranscriptTab jobId={job.id} bands={bands} />
      ) : tab === "notes" ? (
        <ShowNotesPanel job={job} settings={settings} />
      ) : (
        <ClipsPanel job={job} settings={settings} />
      )}
    </div>
  );
}
