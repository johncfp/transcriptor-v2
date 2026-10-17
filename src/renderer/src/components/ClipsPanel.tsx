import { useEffect, useMemo, useRef, useState } from "react";
import { normalize } from "../../../shared/cleanup";
import {
  captionWithHashtags,
  checkQuote,
  clipContext,
  MAX_KEYWORDS,
  MAX_QUOTE_WORDS,
  MIN_QUOTE_WORDS,
  nudgeClip,
  quoteText,
  reviseClip,
  type ClipContext,
  type ClipEdit,
  type SocialCaption,
  type SocialClip,
  type SocialResult,
} from "../../../shared/clips";
import { audioUrl, type Job } from "../../../shared/jobs";
import { EFFORT_LABELS, providerById, type Effort } from "../../../shared/providers";
import type { Settings } from "../../../shared/settings";
import { PLATFORMS, socialDefaultModel, type PlatformId } from "../../../shared/social";
import { SHAPES } from "../../../shared/video";
import { formatTimestamp } from "../../../shared/transcript";
import { isVoiceId, VOICES } from "../../../shared/voices";
import { Section } from "./Section";
import { ClipVideoPreview } from "./ClipVideoPreview";

/** 75.25 → "01:15.2" */
const clock = (sec: number) => `${formatTimestamp(sec)}.${Math.floor((sec % 1) * 10)}`;

const editOf = (c: SocialClip): ClipEdit => ({
  title: c.title,
  kept: c.kept,
  firstWord: c.firstWord,
  lastWord: c.lastWord,
  captions: Object.fromEntries(Object.entries(c.captions).map(([id, cap]) => [id, { text: cap.text, hashtags: cap.hashtags }])),
  quote: c.quote ?? null,
  keywords: c.keywords ?? [],
});

/** "#focus, deep work #habits" → ["focus", "deep", "work", "habits"] */
const parseHashtags = (s: string) => s.split(/[\s,]+/).map((t) => t.replace(/^#+/, "")).filter(Boolean);

/** Social clips for one episode: suggest them, then play, trim, edit and choose which to keep. */
export function ClipsPanel({ job, settings }: { job: Job; settings: Settings }) {
  const [result, setResult] = useState<SocialResult | null>(null);
  const [ctx, setCtx] = useState<ClipContext | null>(null);
  const [saveError, setSaveError] = useState("");
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState<SocialClip | null>(null);
  /** The clip in the video preview: the one last played or clicked. */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const pending = useRef<Record<string, ClipEdit>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const status = job.social?.status;
  const busy = status === "queued" || status === "running";

  // Re-read the clips whenever the step finishes (or starts again).
  useEffect(() => {
    void window.api.getSocial(job.id).then(setResult);
  }, [job.id, status]);

  // What the clips are checked against: the reviewed transcript and the notes' confirmed facts.
  useEffect(() => {
    let live = true;
    void Promise.all([window.api.getEpisode(job.id), window.api.getWriting(job.id)]).then(([episode, writing]) => {
      if (live && episode) setCtx(clipContext(episode.transcript, episode.edits, writing, settings.show.website));
    });
    return () => {
      live = false;
    };
  }, [job.id, settings.show.website]);

  // Save edits shortly after typing stops, and before leaving.
  const flush = (): Promise<void> => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const edits = pending.current;
    pending.current = {};
    if (!Object.keys(edits).length) return Promise.resolve();
    return window.api.saveClips(job.id, edits).then(
      () => setSaveError(""),
      () => setSaveError("Changes couldn't be saved. Try again."),
    );
  };
  useEffect(() => () => void flush(), []);

  const update = (clip: SocialClip, change: Partial<ClipEdit>) => {
    if (!ctx || !result) return;
    const edit = { ...editOf(clip), ...change };
    const next = reviseClip(clip, edit, ctx);
    setResult({ ...result, clips: result.clips.map((c) => (c.id === clip.id ? next : c)) });
    pending.current[clip.id] = edit;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 500);
    // Hear a trimmed edge straight away.
    if (playing?.id === clip.id && (change.firstWord !== undefined || change.lastWord !== undefined)) play(next);
  };

  // Play a clip from its start and stop at its end. Animation frames stop while the window
  // is covered, though the audio plays on, so the media clock's timeupdate checks too.
  const play = (clip: SocialClip) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = clip.start;
    setPlaying(clip);
    setSelectedId(clip.id);
    void a.play();
  };
  const stop = () => {
    audioRef.current?.pause();
    setPlaying(null);
  };
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const a = audioRef.current;
      if (a && a.currentTime >= playing.end) stop();
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const suggest = () => {
    if (result?.clips.length && !confirm("Suggest new clips? This replaces the current clips and any changes you made to them.")) return;
    void flush().then(() => window.api.suggestClips(job.id));
  };

  const clips = result?.clips ?? [];
  const selected = clips.find((c) => c.id === selectedId) ?? clips[0] ?? null;
  const keptCount = clips.filter((c) => c.kept).length;
  const provider = providerById(settings.social.provider);
  const model = settings.social.model || socialDefaultModel(settings.social.provider);

  return (
    <div className="review-body">
      <aside className="review-side">
        <Section title="Social clips" intro="Short moments from the episode, with a caption for each platform. Keep the ones you want; only kept clips are exported.">
          <div className="notes-actions">
            {busy ? (
              <>
                <span className="hint">{job.social?.stage ?? "Working"}…</span>
                <button className="button ghost" onClick={() => void window.api.cancelClips(job.id)}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="button primary" disabled={job.status !== "written"} onClick={suggest}>
                {result ? "Suggest new clips" : "Suggest clips"}
              </button>
            )}
          </div>
          {status === "running" && job.social?.stage !== "Waiting" && (
            <div className="progress indeterminate">
              <div className="progress-bar" />
            </div>
          )}
          {job.status !== "written" && <p className="hint">Write the show notes first; clips are picked after them.</p>}
          {status === "failed" && <p className="hint error">{job.social?.error}</p>}
          {saveError && <p className="hint error">{saveError}</p>}
          <p className="hint">
            Sends the cleaned transcript to {provider?.label ?? "the provider"} ({model}). Change the model, clip lengths, platforms
            and voice on the Social tab in Settings.
            {!settings.social.enabled && " Social clips are switched off there, so new episodes don't get them automatically."}
          </p>
        </Section>
        {selected && ctx && (
          <ClipVideoPreview
            jobId={job.id}
            clip={selected}
            ctx={ctx}
            settings={settings}
            audioRef={audioRef}
            playing={playing?.id === selected.id}
          />
        )}
        {result && result.clips.length > 0 && (
          <ClipsExport
            job={job}
            keptCount={keptCount}
            folder={job.exportRoot || settings.output.folder || "Documents › Transcriptor 2"}
            video={settings.video}
            beforeExport={flush}
          />
        )}
        {result && <ClipChecks result={result} keptCount={keptCount} />}
      </aside>

      <div className="review-main">
        <audio
          ref={audioRef}
          src={audioUrl(job.id)}
          preload="metadata"
          onPause={() => setPlaying(null)}
          onTimeUpdate={(e) => playing && e.currentTarget.currentTime >= playing.end && stop()}
        />
        {clips.length > 0 && ctx ? (
          clips.map((clip) => (
            <ClipCard
              key={`${result!.generatedAt}:${clip.id}`}
              clip={clip}
              ctx={ctx}
              playing={playing?.id === clip.id}
              onPlay={() => (playing?.id === clip.id ? stop() : play(clip))}
              onSelect={() => setSelectedId(clip.id)}
              selected={selected?.id === clip.id}
              onChange={(change) => update(clip, change)}
            />
          ))
        ) : (
          <div className="empty">
            <p className="empty-title">{busy ? "Picking clips…" : result ? "No clips held up" : "No clips yet"}</p>
            <p className="muted">
              {busy
                ? "This usually takes a minute or two."
                : result
                  ? "None of the suggested clips matched the transcript and the settings. The reasons are on the left. You can ask for new ones."
                  : job.status === "written"
                    ? "Choose Suggest clips to have them picked from the episode."
                    : "Once the show notes are written, clips can be picked here."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

const cleanError = (err: unknown) =>
  String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** Export the kept clips: each as a WAV, plus a Social Clips document with their captions. */
/** Export the kept clips: each as a WAV (and, with video clips on, an MP4 per shape), plus a Social Clips document. */
function ClipsExport(props: { job: Job; keptCount: number; folder: string; video: Settings["video"]; beforeExport: () => Promise<void> }) {
  const { job, keptCount, video } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const exported = job.social?.exported;
  const progress = job.social?.exporting;
  useEffect(() => setError(job.social?.exportError ?? ""), [job.social?.exportError]);
  const shapes = SHAPES.filter((s) => video.shapes[s.id]);
  const withVideo = video.enabled && shapes.length > 0;
  const percent = progress && progress.total ? Math.floor((progress.done / progress.total) * 100) : 0;

  return (
    <Section title="Export clips">
      <p className="hint">
        {withVideo
          ? `Each kept clip as a WAV file and as video (${shapes.map((s) => s.label).join(", ")}), in a Clips folder, `
          : "Each kept clip as a WAV file in a Clips folder, "}
        plus a Social Clips document with their captions, in your usual formats. Saved to {props.folder}, in the episode's folder.
        {!withVideo && " For videos, turn on Make video clips in Settings › Social."}
      </p>
      <div className="notes-actions">
        <button
          className="button primary"
          disabled={!keptCount || busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              // The latest edits first, so the export has them.
              await props.beforeExport();
              await window.api.exportClips(job.id);
            } catch (err) {
              setError(cleanError(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? (progress ? "Making videos…" : "Cutting clips…") : keptCount ? `Export ${keptCount} kept clip${keptCount === 1 ? "" : "s"}` : "Export kept clips"}
        </button>
        {busy && (
          <button className="button ghost" onClick={() => void window.api.cancelClipsExport(job.id)}>
            Cancel
          </button>
        )}
        {exported && !busy && (
          <button className="button" onClick={() => void window.api.openFolder(exported.folder)}>
            Open folder
          </button>
        )}
      </div>
      {busy && progress && (
        <>
          <div className="progress" role="progressbar" aria-label="Video progress" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
            <div className="progress-bar" style={{ width: `${percent}%` }} />
          </div>
          <p className="hint">{percent}% of the videos made.</p>
        </>
      )}
      {!keptCount && <p className="hint">Keep at least one clip to export.</p>}
      {error && <p className="hint error">{error}</p>}
      {exported && !error && !busy && (
        <p className="hint">
          Exported {exported.files.length} file{exported.files.length === 1 ? "" : "s"} on {new Date(exported.at).toLocaleString()}.
        </p>
      )}
    </Section>
  );
}

function ClipChecks({ result, keptCount }: { result: SocialResult; keptCount: number }) {
  const { checks } = result;
  return (
    <Section title="Checks">
      <p className="hint">
        {result.clips.length} {result.clips.length === 1 ? "clip" : "clips"}, {keptCount} kept. Suggested by{" "}
        {providerById(result.provider)?.label ?? result.provider} ({result.model}
        {result.effort ? `, ${EFFORT_LABELS[result.effort as Effort]?.toLowerCase() ?? result.effort} effort` : ""})
        {isVoiceId(result.voice) ? ` in the ${VOICES[result.voice].label} voice` : ""} on {new Date(result.generatedAt).toLocaleString()}.
      </p>
      <p>Every clip's words and times come from the transcript.</p>
      {checks.dropped.length > 0 && (
        <ul className="checks-list">
          <li>
            {checks.dropped.length} of {checks.suggested} suggested {checks.suggested === 1 ? "clip was" : "clips were"} left out:
            <ul>
              {checks.dropped.map((d, i) => (
                <li key={i} className="muted">
                  “{d.title}”: {d.reason}
                </li>
              ))}
            </ul>
          </li>
        </ul>
      )}
      {!!checks.highlightsDropped && (
        <p className="hint">
          {checks.highlightsDropped} suggested pull quote{checks.highlightsDropped === 1 ? " or keyword wasn't" : "s or keywords weren't"} in the clip as
          given, so {checks.highlightsDropped === 1 ? "it was" : "they were"} left out.
        </p>
      )}
      {checks.hashtagsDropped > 0 && (
        <p className="hint">
          {checks.hashtagsDropped} extra hashtag{checks.hashtagsDropped === 1 ? "" : "s"} removed to stay within each platform's count.
        </p>
      )}
    </Section>
  );
}

function ClipCard(props: {
  clip: SocialClip;
  ctx: ClipContext;
  playing: boolean;
  onPlay: () => void;
  onChange: (change: Partial<ClipEdit>) => void;
  onSelect: () => void;
  selected: boolean;
}) {
  const { clip, ctx } = props;
  const [title, setTitle] = useState(clip.title);
  // Collapsed to the title, buttons and why; the rest on "Show more".
  const [expanded, setExpanded] = useState(false);
  const crosstalk = clip.crosstalk ?? [];
  const toCheck = clip.titleProblems.length + crosstalk.length + Object.values(clip.captions).reduce((n, c) => n + (c?.problems.length ?? 0), 0);
  const move = (edge: "start" | "end", by: -1 | 1) => nudgeClip(ctx.turns, clip, edge, by);
  const Nudge = ({ edge, by, label }: { edge: "start" | "end"; by: -1 | 1; label: string }) => {
    const next = move(edge, by);
    return (
      <button className="button ghost nudge" disabled={!next} aria-label={label} title={label} onClick={() => next && props.onChange(next)}>
        {by < 0 ? "◀" : "▶"}
      </button>
    );
  };

  return (
    <section
      className={`section clip-card${clip.kept ? " kept" : ""}${props.selected ? " selected" : ""}`}
      aria-label={clip.title}
      onMouseDownCapture={props.onSelect}
    >
      <div className="clip-head">
        <input
          className="input clip-title"
          aria-label="Clip title"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            props.onChange({ title: e.target.value });
          }}
        />
        <button className="button" onClick={props.onPlay}>
          {props.playing ? "Stop" : "Play clip"}
        </button>
        <button className={`button${clip.kept ? " primary" : ""}`} aria-pressed={clip.kept} onClick={() => props.onChange({ kept: !clip.kept })}>
          {clip.kept ? "Kept" : "Keep"}
        </button>
      </div>
      {clip.why && <p className="hint">Why: {clip.why}</p>}
      <div className="clip-more">
        <button className="button ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Show more"}
        </button>
        {!expanded && toCheck > 0 && (
          <span className="hint warn">
            {toCheck} {toCheck === 1 ? "thing" : "things"} to check
          </span>
        )}
      </div>

      {expanded && (
        <div className="clip-details">
          {[...clip.titleProblems, ...crosstalk].map((p) => (
            <p key={p} className="hint warn">
              {p}
            </p>
          ))}

          <div className="clip-times">
            <span>Start {clock(clip.start)}</span>
            <Nudge edge="start" by={-1} label="Start one word earlier" />
            <Nudge edge="start" by={1} label="Start one word later" />
            <span className="clip-times-gap">End {clock(clip.end)}</span>
            <Nudge edge="end" by={-1} label="End one word earlier" />
            <Nudge edge="end" by={1} label="End one word later" />
            <span className="muted">{(clip.end - clip.start).toFixed(1)} s</span>
          </div>

          <ClipHighlights clip={clip} ctx={ctx} onChange={props.onChange} />

          {(Object.keys(clip.captions) as PlatformId[]).map((id) => (
            <CaptionEditor key={id} platform={id} caption={clip.captions[id]!} onChange={(c) => props.onChange({ captions: { ...editOf(clip).captions, [id]: c } })} />
          ))}
        </div>
      )}
    </section>
  );
}

function CaptionEditor(props: {
  platform: PlatformId;
  caption: SocialCaption;
  onChange: (c: { text: string; hashtags: string[] }) => void;
}) {
  const platform = PLATFORMS.find((p) => p.id === props.platform)!;
  // Local drafts, so typing isn't trimmed under the cursor; the checked caption comes back in props.
  const [text, setText] = useState(props.caption.text);
  const [tags, setTags] = useState(props.caption.hashtags.map((t) => `#${t}`).join(" "));
  const [copied, setCopied] = useState(false);
  const hashtags = useMemo(() => parseHashtags(tags), [tags]);
  const length = captionWithHashtags({ text: text.trim(), hashtags }).length;

  return (
    <div className="caption-editor">
      <div className="caption-head">
        <strong>{platform.label}</strong>
        <span className={`hint${length > platform.maxChars ? " error" : ""}`}>
          {length.toLocaleString()} / {platform.maxChars.toLocaleString()}
        </span>
        <button
          className="button ghost"
          onClick={async () => {
            await navigator.clipboard.writeText(captionWithHashtags({ text: text.trim(), hashtags }));
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <textarea
        className="input"
        aria-label={`${platform.label} caption`}
        rows={platform.id === "linkedin" ? 5 : 3}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          props.onChange({ text: e.target.value, hashtags });
        }}
      />
      <input
        className="input"
        aria-label={`${platform.label} hashtags`}
        placeholder="#hashtags"
        value={tags}
        onChange={(e) => {
          setTags(e.target.value);
          props.onChange({ text, hashtags: parseHashtags(e.target.value) });
        }}
      />
      {props.caption.problems.map((p) => (
        <p key={p} className="hint warn">
          {p}
        </p>
      ))}
    </div>
  );
}

/**
 * What's said in the clip, word by word, with its pull quote and keywords
 * marked. Click a word to make it a keyword or not; to set the pull quote,
 * choose Pick quote, then click its first and last words. Both are checked
 * against the transcript like the model's picks (reviseClip).
 */
function ClipHighlights(props: { clip: SocialClip; ctx: ClipContext; onChange: (change: Partial<ClipEdit>) => void }) {
  const { clip, ctx } = props;
  /** null: clicks toggle keywords; "quote": the next click is the quote's first word; a number: its first word, waiting for the last. */
  const [pick, setPick] = useState<null | "quote" | number>(null);
  const [note, setNote] = useState("");
  const keywords = clip.keywords ?? [];
  const quote = clip.quote ?? null;
  // The clip's words by speaker, from the cleaned transcript (as clip.lines).
  const runs = useMemo(() => {
    const out: { speaker: string; words: { text: string; index: number }[] }[] = [];
    for (const t of ctx.turns) {
      for (const w of t.words) {
        if (w.index < clip.firstWord || w.index > clip.lastWord) continue;
        const run = out.at(-1);
        if (run && run.speaker === t.speaker) run.words.push(w);
        else out.push({ speaker: t.speaker, words: [w] });
      }
    }
    return out;
  }, [ctx.turns, clip.firstWord, clip.lastWord]);

  const click = (w: { text: string; index: number }) => {
    setNote("");
    if (pick === "quote") return setPick(w.index);
    if (typeof pick === "number") {
      const next = checkQuote(ctx.turns, clip, { firstWord: Math.min(pick, w.index), lastWord: Math.max(pick, w.index) });
      setPick(null);
      if (next) props.onChange({ quote: next });
      else setNote(`A pull quote is ${MIN_QUOTE_WORDS} to ${MAX_QUOTE_WORDS} words said by one person. Choose Pick quote to try again.`);
      return;
    }
    const key = normalize(w.text);
    if (!key) return;
    if (keywords.includes(key)) props.onChange({ keywords: keywords.filter((k) => k !== key) });
    else if (keywords.length >= MAX_KEYWORDS) setNote(`Up to ${MAX_KEYWORDS} keywords. Click one to remove it first.`);
    else props.onChange({ keywords: [...keywords, key] });
  };

  return (
    <div className="clip-highlights">
      <div className="clip-highlights-head">
        <span>
          <strong>Pull quote:</strong> {quote ? `“${quoteText(ctx.turns, quote)}”` : <span className="muted">none</span>}
        </span>
        <button className={`button ghost${pick !== null ? " active" : ""}`} aria-pressed={pick !== null} onClick={() => setPick(pick === null ? "quote" : null)}>
          {pick === null ? "Pick quote" : "Cancel"}
        </button>
        {quote && (
          <button className="button ghost" onClick={() => props.onChange({ quote: null })}>
            Clear quote
          </button>
        )}
        <span>
          <strong>Keywords:</strong> {keywords.length ? keywords.join(", ") : <span className="muted">none</span>}
        </span>
      </div>
      <p className="hint">
        {pick === "quote"
          ? "Click the quote's first word."
          : typeof pick === "number"
            ? "Now click its last word."
            : `Click a word to make it a keyword (up to ${MAX_KEYWORDS}), or again to remove it. Both show in the clip's video.`}
      </p>
      {note && <p className="hint warn">{note}</p>}
      <blockquote className={`clip-lines${pick !== null ? " picking" : ""}`}>
        {runs.map((r, i) => (
          <p key={i}>
            <strong>{r.speaker}:</strong>{" "}
            {r.words.map((w, j) => {
              const inQuote = !!quote && w.index >= quote.firstWord && w.index <= quote.lastWord;
              const key = keywords.includes(normalize(w.text));
              const start = typeof pick === "number" && w.index === pick;
              return (
                <span key={w.index}>
                  <button
                    className={`clip-word${inQuote ? " in-quote" : ""}${key ? " keyword" : ""}${start ? " pick-start" : ""}`}
                    aria-pressed={key}
                    onClick={() => click(w)}
                  >
                    {w.text}
                  </button>
                  {j < r.words.length - 1 ? " " : ""}
                </span>
              );
            })}
          </p>
        ))}
      </blockquote>
    </div>
  );
}
