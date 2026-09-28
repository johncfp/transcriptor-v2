import { memo, useEffect, useMemo, useState } from "react";
import {
  removalCounts,
  removals,
  reviewTurns,
  speakerName,
  toggleRemoved,
  type EpisodeEdits,
  type RemovalReason,
  type ReviewTurn,
} from "../../../shared/cleanup";
import { formatTimestamp, type Transcript } from "../../../shared/transcript";
import { useJobs } from "../useJobs";
import { Section } from "./Section";

type Episode = { transcript: Transcript; edits: EpisodeEdits };

const REASON_LABEL: Record<RemovalReason, string> = {
  filler: "filler word",
  repetition: "repetition",
  fragment: "cut-off word",
  manual: "removed by hand",
};

/** Confidence bands for highlighting (same defaults as Transcriptor 1). */
const confidenceClass = (c: number | undefined) =>
  c === undefined ? "" : c < 0.5 ? " conf-low" : c < 0.96 ? " conf-medium" : "";

export function ReviewScreen({ jobId, onBack }: { jobId: string; onBack: () => void }) {
  const job = useJobs()?.find((j) => j.id === jobId);
  const [episode, setEpisode] = useState<Episode | null | undefined>(undefined);
  const [showRemoved, setShowRemoved] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    void window.api.getEpisode(jobId).then(setEpisode);
  }, [jobId]);

  const update = (edits: EpisodeEdits) => {
    setEpisode((ep) => (ep ? { ...ep, edits } : ep));
    void window.api.saveEdits(jobId, edits);
  };

  const turns = useMemo(
    () => (episode ? reviewTurns(episode.transcript, episode.edits, showRemoved) : []),
    [episode, showRemoved],
  );
  const counts = useMemo(
    () => (episode ? removalCounts(removals(episode.transcript, episode.edits)) : null),
    [episode],
  );

  if (episode === undefined) return null;
  if (episode === null) {
    return (
      <>
        <BackButton onBack={onBack} />
        <p className="muted">This transcript isn't available.</p>
      </>
    );
  }

  const { transcript, edits } = episode;
  const needsReview = job?.status === "needs-review";

  return (
    <div className="review">
      <div className="page-head">
        <div>
          <BackButton onBack={onBack} />
          <h1>{job?.fileName ?? "Transcript"}</h1>
          <p className="muted head-meta">
            {transcript.durationSec !== undefined && `${formatTimestamp(transcript.durationSec)} · `}
            {transcript.words.length.toLocaleString()} words
          </p>
        </div>
        {needsReview ? (
          <button className="button primary" onClick={() => void window.api.markReviewed(jobId)}>
            Mark as reviewed
          </button>
        ) : (
          <span className="pill ready">Reviewed</span>
        )}
      </div>

      <Section title="Speakers" intro="Names are used in the transcript and show notes. Give two speakers the same name to merge them.">
        {edits.speakerNames.map((_, i) => (
          <SpeakerRow
            key={i}
            index={i}
            edits={edits}
            wordCount={transcript.words.filter((w) => w.speaker === i).length}
            onChange={(name) => {
              const speakerNames = [...edits.speakerNames];
              speakerNames[i] = name;
              update({ ...edits, speakerNames });
            }}
          />
        ))}
      </Section>

      <Section title="Cleanup">
        {counts && (
          <p className="cleanup-counts">
            Removed {counts.filler.toLocaleString()} filler word{counts.filler === 1 ? "" : "s"}
            {edits.cleanup.repetitions && `, ${counts.repetition} repetition${counts.repetition === 1 ? "" : "s"}, ${counts.fragment} cut-off word${counts.fragment === 1 ? "" : "s"}`}
            {counts.manual > 0 && `, ${counts.manual} by hand`}.
          </p>
        )}
        {transcript.falseStartsRemoved && (
          <p className="hint">
            False starts were removed by ElevenLabs during transcription, so they can't be shown or put back here.
          </p>
        )}
        <label className="row toggle-row">
          <div className="row-label">
            <span>Remove repetitions and cut-off words</span>
            <span className="hint">For this episode. The default is in Settings.</span>
          </div>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={edits.cleanup.repetitions}
            onChange={(e) => update({ ...edits, cleanup: { ...edits.cleanup, repetitions: e.target.checked } })}
          />
        </label>
        <label className="row toggle-row">
          <div className="row-label">
            <span>Show removed words</span>
            <span className="hint">Crossed out, so you can check them. Click one to put it back.</span>
          </div>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={showRemoved}
            onChange={(e) => setShowRemoved(e.target.checked)}
          />
        </label>
      </Section>

      <p className="legend muted">
        Click a word to fix its spelling or remove it. <span className="conf-low">Red</span> words were hard to hear;{" "}
        <span className="conf-medium">orange</span> ones are worth a glance.
      </p>

      <div className="transcript">
        {turns.map((turn) => (
          <Turn key={turn.words[0]!.index} turn={turn} selected={selected} onSelect={setSelected} />
        ))}
      </div>

      {selected !== null && (
        <WordEditor
          key={selected}
          index={selected}
          episode={episode}
          onChange={update}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button className="button ghost back" onClick={onBack}>
      ← Episodes
    </button>
  );
}

function SpeakerRow(props: { index: number; edits: EpisodeEdits; wordCount: number; onChange: (name: string | null) => void }) {
  const { index, edits } = props;
  const set = edits.speakerNames[index] ?? null;
  const suggestion = edits.suggestedNames[index];
  const [draft, setDraft] = useState(set ?? suggestion?.name ?? "");
  useEffect(() => setDraft(set ?? suggestion?.name ?? ""), [set, suggestion]);

  const commit = () => {
    const name = draft.trim();
    if (name === (set ?? suggestion?.name ?? "")) return;
    props.onChange(name || null);
  };

  return (
    <div className="row">
      <div className="row-label">
        <span>
          Speaker {index + 1}
          <span className="badge">{props.wordCount.toLocaleString()} words</span>
        </span>
        {set === null && suggestion && (
          <span className="hint">
            Suggested {suggestion.role}: {suggestion.because}.
          </span>
        )}
        {set === null && !suggestion && <span className="hint">No name found. Add one if you know it.</span>}
      </div>
      <div className="row-control speaker-control">
        <input
          className="input"
          value={draft}
          placeholder={`Speaker ${index + 1}`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
          aria-label={`Name for speaker ${index + 1}`}
        />
        {set === null && suggestion && (
          <button className="button" onClick={() => props.onChange(suggestion.name)}>
            Confirm
          </button>
        )}
      </div>
    </div>
  );
}

const Turn = memo(function Turn(props: {
  turn: ReviewTurn;
  selected: number | null;
  onSelect: (index: number) => void;
}) {
  const { turn } = props;
  return (
    <div className="turn">
      <div className="turn-head">
        <span className="speaker">{turn.speaker}</span>
        <span className="muted">{formatTimestamp(turn.start)}</span>
      </div>
      <p>
        {turn.words.map((w, i) => (
          <span key={w.index}>
            {i > 0 && " "}
            <span
              className={
                "word" +
                (w.removed ? " removed" : confidenceClass(w.confidence)) +
                (w.edited ? " edited" : "") +
                (props.selected === w.index ? " selected" : "")
              }
              title={w.removed ? `Removed: ${REASON_LABEL[w.removed]}` : undefined}
              onClick={() => props.onSelect(w.index)}
            >
              {w.text}
            </span>
          </span>
        ))}
      </p>
    </div>
  );
});

function WordEditor(props: { index: number; episode: Episode; onChange: (e: EpisodeEdits) => void; onClose: () => void }) {
  const { index, episode, onChange } = props;
  const { transcript, edits } = episode;
  const raw = transcript.words[index]!;
  const current = edits.text[index] ?? raw.text;
  const [draft, setDraft] = useState(current);
  const reason = removals(transcript, edits).get(index);

  const saveText = () => {
    const text = { ...edits.text };
    const value = draft.trim();
    if (!value || value === raw.text) delete text[index];
    else text[index] = value;
    onChange({ ...edits, text });
  };

  return (
    <div className="word-editor" role="dialog" aria-label="Edit word">
      <div className="word-editor-info">
        <strong>{speakerName(edits, raw.speaker)}</strong> at {formatTimestamp(raw.start)}
        {raw.confidence !== undefined && ` · ${Math.round(raw.confidence * 100)}% confident`}
        {reason && ` · removed (${REASON_LABEL[reason]})`}
        {current !== raw.text && ` · originally "${raw.text}"`}
      </div>
      <form
        className="key-form"
        onSubmit={(e) => {
          e.preventDefault();
          saveText();
        }}
      >
        <input
          className="input"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && props.onClose()}
          aria-label="Word"
        />
        <button className="button primary" type="submit" disabled={draft.trim() === current}>
          Save
        </button>
        <button className="button" type="button" onClick={() => onChange(toggleRemoved(transcript, edits, index))}>
          {reason ? "Put back" : "Remove word"}
        </button>
        <button className="button ghost" type="button" onClick={props.onClose}>
          Close
        </button>
      </form>
    </div>
  );
}
