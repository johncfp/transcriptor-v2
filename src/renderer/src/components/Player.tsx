import { useEffect, useRef, useState, type RefObject } from "react";
import { formatTimestamp } from "../../../shared/transcript";

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

/**
 * Audio player for review. Tracks the playhead every animation frame while
 * playing, but only reports a word change (`onWord`) when the spoken word
 * actually changes, so the transcript isn't re-rendered 60 times a second.
 * Chromium stops animation frames while the window is hidden or covered,
 * though the audio plays on, so the media clock's timeupdate events report
 * too; the highlight is then never more than a quarter second behind.
 */
export function Player(props: {
  src: string;
  audioRef: RefObject<HTMLAudioElement | null>;
  /** The word index being spoken at `time`, or null before the first word. */
  wordAt: (time: number) => number | null;
  onWord: (index: number | null) => void;
  onPlayingChange: (playing: boolean) => void;
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
}) {
  const { audioRef, wordAt, onWord } = props;
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [error, setError] = useState(false);
  const lastWord = useRef<number | null>(null);

  // Keep the latest callbacks without restarting the frame loop.
  const latest = useRef({ wordAt, onWord });
  latest.current = { wordAt, onWord };

  const report = (t: number) => {
    const index = latest.current.wordAt(t);
    if (index !== lastWord.current) {
      lastWord.current = index;
      latest.current.onWord(index);
    }
  };

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const audio = audioRef.current;
      if (audio) report(audio.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, audioRef]);

  const audio = () => audioRef.current;
  const seekBy = (delta: number) => {
    const a = audio();
    if (a) a.currentTime = Math.max(0, Math.min(a.duration || 0, a.currentTime + delta));
  };

  return (
    <section className="section player">
      <h2>Playback</h2>
      <audio
        ref={audioRef}
        src={props.src}
        preload="metadata"
        onLoadedMetadata={(e) => {
          setDuration(e.currentTarget.duration);
          setError(false);
        }}
        onTimeUpdate={(e) => {
          setTime(e.currentTarget.currentTime);
          report(e.currentTarget.currentTime);
        }}
        onSeeked={(e) => report(e.currentTarget.currentTime)}
        onPlay={() => {
          setPlaying(true);
          props.onPlayingChange(true);
        }}
        onPause={() => {
          setPlaying(false);
          props.onPlayingChange(false);
        }}
        onError={() => setError(true)}
      />
      {error ? (
        <p className="hint error">The audio file can't be played. It may have been moved or deleted.</p>
      ) : (
        <>
          <input
            className="scrub"
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={time}
            onChange={(e) => {
              const a = audio();
              if (a) a.currentTime = Number(e.target.value);
            }}
            aria-label="Position"
          />
          <div className="player-controls">
            <button className="button" onClick={() => seekBy(-5)} aria-label="Back 5 seconds">
              −5s
            </button>
            <button
              className="button primary play"
              onClick={() => {
                const a = audio();
                if (a) void (a.paused ? a.play() : a.pause());
              }}
            >
              {playing ? "Pause" : "Play"}
            </button>
            <button className="button" onClick={() => seekBy(5)} aria-label="Forward 5 seconds">
              +5s
            </button>
            <span className="player-time">
              {formatTimestamp(time)} / {formatTimestamp(duration)}
            </span>
            <select
              className="input speed"
              value={rate}
              onChange={(e) => {
                const r = Number(e.target.value);
                setRate(r);
                const a = audio();
                if (a) a.playbackRate = r;
              }}
              aria-label="Playback speed"
            >
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
          </div>
          <label className="check follow">
            <input type="checkbox" checked={props.follow} onChange={(e) => props.onFollowChange(e.target.checked)} />
            Follow playback in the transcript
          </label>
          <p className="hint">Space plays and pauses. Clicking a word jumps the audio there.</p>
        </>
      )}
    </section>
  );
}
