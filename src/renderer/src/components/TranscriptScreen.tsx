import { useEffect, useMemo, useState } from "react";
import { formatTimestamp, toTurns, type Transcript } from "../../../shared/transcript";
import { useJobs } from "../useJobs";

/** Read-only transcript. Editing and cleanup come with the review step (M2). */
export function TranscriptScreen({ jobId, onBack }: { jobId: string; onBack: () => void }) {
  const job = useJobs()?.find((j) => j.id === jobId);
  const [transcript, setTranscript] = useState<Transcript | null | undefined>(undefined);

  useEffect(() => {
    void window.api.getTranscript(jobId).then(setTranscript);
  }, [jobId]);

  const turns = useMemo(() => (transcript ? toTurns(transcript.words) : []), [transcript]);

  return (
    <>
      <div className="page-head">
        <div>
          <button className="button ghost back" onClick={onBack}>
            ← Episodes
          </button>
          <h1>{job?.fileName ?? "Transcript"}</h1>
        </div>
      </div>
      {transcript === null && <p className="muted">This transcript isn't available.</p>}
      {transcript && (
        <>
          <p className="muted">
            {transcript.durationSec !== undefined && `${formatTimestamp(transcript.durationSec)} · `}
            {transcript.speakerCount} speaker{transcript.speakerCount === 1 ? "" : "s"} ·{" "}
            {transcript.words.length.toLocaleString()} words · raw transcript, before cleanup
          </p>
          <div className="transcript">
            {turns.map((turn, i) => (
              <div key={i} className="turn">
                <div className="turn-head">
                  <span className="speaker">Speaker {turn.speaker + 1}</span>
                  <span className="muted">{formatTimestamp(turn.start)}</span>
                </div>
                <p>{turn.words.map((w) => w.text).join(" ")}</p>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
