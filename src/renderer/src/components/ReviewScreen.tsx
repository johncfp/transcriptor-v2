import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { audioUrl } from "../../../shared/jobs";
import { formatTimestamp, type Transcript } from "../../../shared/transcript";
import { useJobs } from "../useJobs";
import { Player } from "./Player";
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

/** Last entry in `sorted` whose start is at or before `time`, by binary search. */
function lastStartedBefore(sorted: { index: number; start: number }[], time: number): number | null {
  let lo = 0;
  let hi = sorted.length - 1;
  let found: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]!.start <= time) {
      found = sorted[mid]!.index;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

export function ReviewScreen({ jobId, onBack }: { jobId: string; onBack: () => void }) {
  const job = useJobs()?.find((j) => j.id === jobId);
  const [episode, setEpisode] = useState<Episode | null | undefined>(undefined);
  const [showRemoved, setShowRemoved] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [current, setCurrent] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [follow, setFollow] = useState(true);
  const audioRef = useRef<HTMLAudioElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

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
  // Words on screen in time order, for finding the one being spoken.
  const visible = useMemo(
    () => turns.flatMap((t) => t.words.map((w) => ({ index: w.index, start: episode!.transcript.words[w.index]!.start }))),
    [turns, episode],
  );
  const wordAt = useCallback((time: number) => lastStartedBefore(visible, time), [visible]);

  const seek = useCallback((time: number, play = false) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, time);
    if (play) void audio.play();
  }, []);

  const selectWord = useCallback(
    (index: number) => {
      setSelected(index);
      const word = episode?.transcript.words[index];
      if (word) seek(word.start);
    },
    [episode, seek],
  );

  // Space plays and pauses, unless someone is typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.code !== "Space" || target.closest("input, textarea, select, button")) return;
      e.preventDefault();
      const audio = audioRef.current;
      if (audio) void (audio.paused ? audio.play() : audio.pause());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Keep the spoken word in view while playing, without scrolling on every word:
  // only when it drifts out of the middle of the transcript panel.
  useEffect(() => {
    if (!follow || !playing || current === null) return;
    const panel = transcriptRef.current;
    const el = panel?.querySelector(`[data-index="${current}"]`);
    if (!panel || !el) return;
    const p = panel.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top < p.top + p.height * 0.15 || r.bottom > p.top + p.height * 0.75) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [current, follow, playing]);

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

      <div className="review-body">
        <aside className="review-side">
          <Section title="Speakers" intro="Used in the transcript and show notes. Give two speakers the same name to merge them.">
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
                {edits.cleanup.repetitions &&
                  `, ${counts.repetition} repetition${counts.repetition === 1 ? "" : "s"}, ${counts.fragment} cut-off word${counts.fragment === 1 ? "" : "s"}`}
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

          <Player
            src={audioUrl(jobId)}
            audioRef={audioRef}
            wordAt={wordAt}
            onWord={setCurrent}
            onPlayingChange={setPlaying}
            follow={follow}
            onFollowChange={setFollow}
          />

          {selected !== null && (
            <WordEditor
              key={selected}
              index={selected}
              episode={episode}
              onChange={update}
              onPlay={() => seek(transcript.words[selected]!.start - 1, true)}
              onClose={() => setSelected(null)}
            />
          )}
        </aside>

        <div className="review-main" ref={transcriptRef}>
          <p className="legend muted">
            Click a word to jump to it, fix its spelling, or remove it. <span className="conf-low">Red</span> words were
            hard to hear; <span className="conf-medium">orange</span> ones are worth a glance.
          </p>
          <div className="transcript">
            {turns.map((turn) => {
              const first = turn.words[0]!.index;
              const last = turn.words.at(-1)!.index;
              const inTurn = (i: number | null) => (i !== null && i >= first && i <= last ? i : null);
              return (
                <Turn
                  key={first}
                  turn={turn}
                  selected={inTurn(selected)}
                  current={inTurn(current)}
                  onSelect={selectWord}
                />
              );
            })}
          </div>
        </div>
      </div>
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
    <div className="row speaker-row">
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
      <div className="speaker-control">
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
  /** Only set when the selected/current word is in this turn, so other turns skip re-rendering. */
  selected: number | null;
  current: number | null;
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
              data-index={w.index}
              className={
                "word" +
                (w.removed ? " removed" : confidenceClass(w.confidence)) +
                (w.edited ? " edited" : "") +
                (props.current === w.index ? " current" : "") +
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

function WordEditor(props: {
  index: number;
  episode: Episode;
  onChange: (e: EpisodeEdits) => void;
  onPlay: () => void;
  onClose: () => void;
}) {
  const { index, episode, onChange } = props;
  const { transcript, edits } = episode;
  const raw = transcript.words[index]!;
  const current = edits.text[index] ?? raw.text;
  const [draft, setDraft] = useState(current);
  const reason = removals(transcript, edits).get(index);
  const ref = useRef<HTMLElement>(null);

  // The card sits below the player, so bring it into view when a word is picked.
  // Braces matter: scrollIntoView now returns a Promise, which React would treat as a cleanup.
  useEffect(() => {
    void ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);

  const saveText = () => {
    const text = { ...edits.text };
    const value = draft.trim();
    if (!value || value === raw.text) delete text[index];
    else text[index] = value;
    onChange({ ...edits, text });
  };

  return (
    <section ref={ref} className="section word-editor" aria-label="Selected word">
      <h2>Selected word</h2>
      <div className="word-editor-info">
        <strong>{speakerName(edits, raw.speaker)}</strong> at {formatTimestamp(raw.start)}
        {raw.confidence !== undefined && ` · ${Math.round(raw.confidence * 100)}% confident`}
        {reason && ` · removed (${REASON_LABEL[reason]})`}
        {current !== raw.text && ` · originally "${raw.text}"`}
      </div>
      <form
        className="word-form"
        onSubmit={(e) => {
          e.preventDefault();
          saveText();
        }}
      >
        <input
          className="input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && props.onClose()}
          aria-label="Word"
        />
        <button className="button primary" type="submit" disabled={draft.trim() === current}>
          Save
        </button>
      </form>
      <div className="word-actions">
        <button className="button" type="button" onClick={props.onPlay}>
          Play from here
        </button>
        <button className="button" type="button" onClick={() => onChange(toggleRemoved(transcript, edits, index))}>
          {reason ? "Put back" : "Remove word"}
        </button>
        <button className="button ghost" type="button" onClick={props.onClose}>
          Close
        </button>
      </div>
    </section>
  );
}
