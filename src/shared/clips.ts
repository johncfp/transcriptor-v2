// Code checks on the social clips the AI suggests, and the saved result
// (`<userData>/episodes/<id>/social.json`). The model only names where a clip
// starts and ends, by copying its first and last words; the clip's text,
// speakers and times come from the transcript. Clips that can't be found or
// don't fit the settings are dropped; caption problems are flagged for review.

import { cleanTranscript, normalize, speakerName, type CleanTurn, type EpisodeEdits } from "./cleanup";
import type { WritingResult } from "./showNotes";
import { MAX_TITLE_CHARS, PLATFORMS, type ClipLimits, type PlatformId } from "./social";
import { formatTimestamp, type Transcript, type Word } from "./transcript";
import { confirmedFacts, normalizeUrl } from "./verify";

// ---------------------------------------------------------------------------
// Saved result

export interface SocialCaption {
  text: string;
  /** Without the "#". */
  hashtags: string[];
  /** Things to check before posting, e.g. over the length limit. Empty = none found. */
  problems: string[];
}

export interface SocialClip {
  /** "clip-1", "clip-2", … in episode order. */
  id: string;
  title: string;
  /** Why the model picked it. */
  why: string;
  /** The clip's first and last words, as indexes into the raw transcript's words. */
  firstWord: number;
  lastWord: number;
  /** Where to cut, in seconds, with a little room around the words (see clipCut). */
  start: number;
  end: number;
  /** What's said, by speaker, from the cleaned transcript. */
  lines: { speaker: string; text: string }[];
  captions: Partial<Record<PlatformId, SocialCaption>>;
  /** Title problems, e.g. too long for YouTube. */
  titleProblems: string[];
  /** Other speakers heard in the clip, e.g. a "yeah" from the host. Missing in clips saved before 2.0.0-beta.7. */
  crosstalk?: string[];
  /** Chosen in review to be cut and exported. */
  kept: boolean;
}

export interface SocialResult {
  version: 1;
  provider: string;
  model: string;
  effort?: string;
  voice: string;
  generatedAt: string;
  clips: SocialClip[];
  checks: {
    /** How many clips the model suggested. */
    suggested: number;
    /** Clips left out, and why. */
    dropped: { title: string; reason: string }[];
    /** Hashtags removed for going over a platform's count. */
    hashtagsDropped: number;
  };
}

// ---------------------------------------------------------------------------
// The draft from the model

export interface ClipDraft {
  title: string;
  why: string;
  first_words: string;
  last_words: string;
  captions: Partial<Record<PlatformId, { text: string; hashtags: string[] }>>;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const arr = (v: unknown) => (Array.isArray(v) ? v : []);
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Read the model's clips defensively; Kimi and Qwen don't enforce the schema. */
export function coerceClips(value: unknown): ClipDraft[] {
  return arr(obj(value).clips).map((c) => {
    const d = obj(c);
    const captions: ClipDraft["captions"] = {};
    for (const p of PLATFORMS) {
      const cap = obj(obj(d.captions)[p.id]);
      if (!Object.keys(cap).length) continue;
      captions[p.id] = { text: str(cap.text), hashtags: arr(cap.hashtags).map(str).filter(Boolean) };
    }
    return { title: str(d.title), why: str(d.why), first_words: str(d.first_words), last_words: str(d.last_words), captions };
  });
}

// ---------------------------------------------------------------------------
// Checks

interface FlatWord {
  key: string;
  text: string;
  start: number;
  end: number;
  speaker: string;
  /** Index into the raw transcript's words. */
  index: number;
  endsSentence: boolean;
}

const endsSentence = (text: string) => /[.?!]["'”’)]*$/.test(text);
/** Split copied text into comparable words, as quotes are ("don't—really" → ["don't", "really"]). */
const keysOf = (text: string) => text.split(/[\s—–]+/).map(normalize).filter(Boolean);

function flatten(turns: CleanTurn[]): FlatWord[] {
  return turns.flatMap((t) =>
    t.words.map((w) => ({
      key: normalize(w.text),
      text: w.text,
      start: w.start,
      end: w.end,
      speaker: t.speaker,
      index: w.index,
      endsSentence: endsSentence(w.text),
    })),
  );
}

/** Every position where `keys` appears in a row. */
function findAll(words: FlatWord[], keys: string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + keys.length <= words.length; i++) {
    if (keys.every((k, j) => words[i + j]!.key === k)) out.push(i);
  }
  return out;
}

/** Sentence boundaries may move a clip's edge by at most this much. */
const SNAP_SEC = 10;
/** Clip lengths are approximate: this much shorter or longer than the settings still counts. */
const SHORT_SLACK_SEC = 2;
const LONG_SLACK_SEC = 5;
/** Room left before the first word and after the last, so the cut doesn't clip them. */
const PAD_BEFORE = 0.15;
const PAD_AFTER = 0.3;

/** Move the start back to where its sentence begins, if that's close. */
function snapStart(words: FlatWord[], i: number): number {
  let s = i;
  while (s > 0 && !words[s - 1]!.endsSentence && words[s - 1]!.speaker === words[s]!.speaker) {
    if (words[i]!.start - words[s - 1]!.start > SNAP_SEC) return i;
    s--;
  }
  return s;
}

/** Move the end forward to where its sentence finishes, if that's close. */
function snapEnd(words: FlatWord[], j: number): number {
  let e = j;
  while (!words[e]!.endsSentence && e + 1 < words.length && words[e + 1]!.speaker === words[e]!.speaker) {
    if (words[e + 1]!.end - words[j]!.end > SNAP_SEC) return j;
    e++;
  }
  return e;
}

export interface ClipCheckOptions {
  limits: ClipLimits;
  platforms: PlatformId[];
  /** The raw transcript's words, for the room around each cut. */
  rawWords: Word[];
  /** Each raw word's speaker, as named in review (see rawSpeakerNames); by number if left out. */
  rawSpeakers?: string[];
  /** Keep only stretches where one person talks: clips with someone else in them are trimmed or dropped. */
  oneSpeaker?: boolean;
  durationSec: number;
  /** Confirmed guest facts: numbers in captions may come from these too. */
  facts: string[];
  /** Links a caption may contain: the show's website and confirmed guest links. */
  allowedUrls: string[];
}

/** Numbers as written ("3,000", "40%", "2.5") with the thousands commas removed. */
const numbersIn = (text: string) =>
  [...text.matchAll(/\d[\d,]*(?:\.\d+)?%?/g)].map((m) => m[0].replace(/,(?=\d{3}\b)/g, "").replace(/[.,]$/, ""));
const urlsIn = (text: string) => [...text.matchAll(/\b(?:https?:\/\/|www\.)[^\s)]+/gi)].map((m) => m[0].replace(/[.,!?]+$/, ""));

/** "#Growth Hacking!" → "GrowthHacking"; empty when nothing usable is left. */
export const cleanHashtag = (tag: string) => tag.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "");

/** What a caption may mention: numbers from the transcript and confirmed facts, and allowed links. */
export interface CaptionKnown {
  numbers: Set<string>;
  urls: Set<string>;
}

export function captionKnown(turns: CleanTurn[], facts: string[], allowedUrls: string[]): CaptionKnown {
  const text = turns.flatMap((t) => t.words.map((w) => w.text)).join(" ");
  return {
    numbers: new Set([...numbersIn(text), ...facts.flatMap(numbersIn)]),
    urls: new Set(allowedUrls.map(normalizeUrl).filter((u): u is string => u !== null)),
  };
}

/** A caption with its hashtags, as posted: text, a blank line, then the hashtags. */
export const captionWithHashtags = (c: { text: string; hashtags: string[] }) =>
  c.hashtags.length ? `${c.text}\n\n${c.hashtags.map((t) => `#${t}`).join(" ")}` : c.text;

/**
 * Check a caption. The model's extra hashtags are removed ("model"); the
 * user's own are kept and flagged instead ("edit"), since they chose them.
 */
export function checkCaption(
  draft: { text: string; hashtags: string[] },
  platformId: PlatformId,
  known: CaptionKnown,
  mode: "model" | "edit",
): { caption: SocialCaption; hashtagsDropped: number } {
  const platform = PLATFORMS.find((p) => p.id === platformId)!;
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of draft.hashtags) {
    const tag = cleanHashtag(raw);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
  }
  const hashtags = mode === "model" ? tags.slice(0, platform.maxHashtags) : tags;
  const text = draft.text.trim();
  const problems: string[] = [];

  const length = captionWithHashtags({ text, hashtags }).length;
  if (length > platform.maxChars) problems.push(`${length - platform.maxChars} characters over ${platform.label}'s ${platform.maxChars} limit.`);
  if (hashtags.length > platform.maxHashtags) {
    problems.push(`${hashtags.length} hashtags; ${platform.maxHashtags} is the most to use on ${platform.label}.`);
  }
  for (const n of new Set(numbersIn(text))) {
    if (!known.numbers.has(n)) problems.push(`“${n}” isn't in the transcript or the confirmed guest facts.`);
  }
  for (const url of new Set(urlsIn(text))) {
    const n = normalizeUrl(/^www\./i.test(url) ? `https://${url}` : url);
    if (!n || !known.urls.has(n)) problems.push(`The link ${url} isn't the show's website or a confirmed guest link.`);
  }
  return { caption: { text, hashtags, problems }, hashtagsDropped: tags.length - hashtags.length };
}

const titleProblems = (title: string) =>
  title.length > MAX_TITLE_CHARS ? [`${title.length - MAX_TITLE_CHARS} characters over YouTube's ${MAX_TITLE_CHARS}-character title limit.`] : [];

// ---------------------------------------------------------------------------
// Where a clip is cut, and what it says

/**
 * Where to cut for the raw words `firstWord`..`lastWord`: a little room
 * around them, without reaching into the neighbouring words of the audio and
 * never cutting into the clip's own first or last word. Next to another
 * speaker the room stops halfway to their word, since their sound (a breath,
 * the start of a word) often comes before the word's time.
 */
export function clipCut(rawWords: Word[], durationSec: number, firstWord: number, lastWord: number): { start: number; end: number } {
  const first = rawWords[firstWord]!;
  const last = rawWords[lastWord]!;
  const prev = rawWords[firstWord - 1];
  const next = rawWords[lastWord + 1];
  const startLimit = !prev ? 0 : prev.speaker === first.speaker ? prev.end : (prev.end + first.start) / 2;
  const start = Math.max(0, Math.min(first.start, Math.max(startLimit, first.start - PAD_BEFORE)));
  const endLimit = !next ? durationSec || Infinity : next.speaker === last.speaker ? next.start : (last.end + next.start) / 2;
  const end = Math.max(last.end, Math.min(endLimit, last.end + PAD_AFTER));
  return { start: round(start), end: round(end) };
}

/** What's said between two raw words, by speaker, from the cleaned transcript. */
export function clipLines(turns: CleanTurn[], firstWord: number, lastWord: number): SocialClip["lines"] {
  const lines: SocialClip["lines"] = [];
  for (const turn of turns) {
    for (const w of turn.words) {
      if (w.index < firstWord || w.index > lastWord) continue;
      const line = lines.at(-1);
      if (line && line.speaker === turn.speaker) line.text += ` ${w.text}`;
      else lines.push({ speaker: turn.speaker, text: w.text });
    }
  }
  return lines;
}

/** Each raw word's speaker as named in review, so two diarized speakers given one name count as one. */
export const rawSpeakerNames = (transcript: Transcript, edits: EpisodeEdits): string[] =>
  transcript.words.map((w) => speakerName(edits, w.speaker));

/** Most notes about other speakers listed one by one; beyond this they're summed up. */
const MAX_CROSSTALK_NOTES = 3;

/**
 * Other speakers heard between the raw words `firstWord`..`lastWord`, as
 * notes for review ("Nigel T. says “Yeah.” 00:12 into the clip."). Words the
 * cleanup removed count too: they're still in the audio.
 */
export function clipCrosstalk(rawWords: Word[], rawSpeakers: string[], firstWord: number, lastWord: number, clipStart: number): string[] {
  const count = new Map<string, number>();
  for (let i = firstWord; i <= lastWord; i++) count.set(rawSpeakers[i]!, (count.get(rawSpeakers[i]!) ?? 0) + 1);
  if (count.size < 2) return [];
  const main = [...count].sort((a, b) => b[1] - a[1])[0]![0];
  const runs: { speaker: string; words: Word[] }[] = [];
  for (let i = firstWord; i <= lastWord; i++) {
    const speaker = rawSpeakers[i]!;
    if (speaker === main) continue;
    const run = runs.at(-1);
    if (run && run.speaker === speaker && rawSpeakers[i - 1] === speaker) run.words.push(rawWords[i]!);
    else runs.push({ speaker, words: [rawWords[i]!] });
  }
  if (runs.length > MAX_CROSSTALK_NOTES) {
    const names = [...new Set(runs.map((r) => r.speaker))];
    return [`${names.join(" and ")} ${names.length > 1 ? "talk" : "talks"} ${runs.length} times in this clip.`];
  }
  return runs.map((r) => {
    const said = r.words.slice(0, 8).map((w) => w.text).join(" ") + (r.words.length > 8 ? " …" : "");
    return `${r.speaker} says “${said}” ${formatTimestamp(r.words[0]!.start - clipStart)} into the clip.`;
  });
}

/**
 * The longest stretch of the flat words `from`..`to` with only one speaker
 * heard (removed words count: they're still in the audio), trimmed to whole
 * sentences where that leaves it long enough; null if no stretch is.
 */
function soloSpan(words: FlatWord[], rawSpeakers: string[], from: number, to: number, minSec: number): { from: number; to: number } | null {
  let best: { from: number; to: number } | null = null;
  const seconds = (s: { from: number; to: number }) => words[s.to]!.end - words[s.from]!.start;
  const close = (a: number, b: number) => {
    const s = sentenceSpan(words, rawSpeakers, a, b, minSec);
    if (s && (!best || seconds(s) > seconds(best))) best = s;
  };
  let runStart = from;
  for (let k = from + 1; k <= to; k++) {
    const speaker = rawSpeakers[words[k - 1]!.index];
    let mixed = false;
    for (let r = words[k - 1]!.index + 1; r <= words[k]!.index && !mixed; r++) mixed = rawSpeakers[r] !== speaker;
    if (mixed) {
      close(runStart, k - 1);
      runStart = k;
    }
  }
  close(runStart, to);
  return best;
}

/** `a`..`b` with its edges moved in to sentence boundaries where close and still at least `minSec` long; null if it's too short. */
function sentenceSpan(words: FlatWord[], rawSpeakers: string[], a: number, b: number, minSec: number): { from: number; to: number } | null {
  const seconds = (s: number, e: number) => words[e]!.end - words[s]!.start;
  if (seconds(a, b) < minSec) return null;
  // A sentence starts here if this speaker's previous word ended one; other speakers' words in between don't count.
  const speaker = rawSpeakers[words[a]!.index];
  let p = a - 1;
  while (p >= 0 && rawSpeakers[words[p]!.index] !== speaker) p--;
  let from = a;
  if (p >= 0 && !words[p]!.endsSentence) {
    for (let k = a + 1; k <= b && words[k]!.start - words[a]!.start <= SNAP_SEC; k++) {
      if (!words[k - 1]!.endsSentence) continue;
      if (seconds(k, b) >= minSec) from = k;
      break;
    }
  }
  let to = b;
  if (!words[b]!.endsSentence) {
    for (let k = b - 1; k >= from && words[b]!.end - words[k]!.end <= SNAP_SEC; k--) {
      if (!words[k]!.endsSentence) continue;
      if (seconds(from, k) >= minSec) to = k;
      break;
    }
  }
  return { from, to };
}

/**
 * Move a clip's start or end by one word of the cleaned transcript (removed
 * fillers are skipped). Null when it can't move: past the episode's edges, or
 * so the clip would have no words.
 */
export function nudgeClip(
  turns: CleanTurn[],
  clip: Pick<SocialClip, "firstWord" | "lastWord">,
  edge: "start" | "end",
  by: -1 | 1,
): { firstWord: number; lastWord: number } | null {
  const order = turns.flatMap((t) => t.words.map((w) => w.index));
  const at = order.indexOf(edge === "start" ? clip.firstWord : clip.lastWord);
  const target = order[at + by];
  if (at < 0 || target === undefined) return null;
  const next = edge === "start" ? { firstWord: target, lastWord: clip.lastWord } : { firstWord: clip.firstWord, lastWord: target };
  return next.firstWord <= next.lastWord ? next : null;
}

/** What the transcript and notes say, for re-checking a clip after an edit. */
export interface ClipContext {
  turns: CleanTurn[];
  rawWords: Word[];
  /** See rawSpeakerNames. */
  rawSpeakers: string[];
  durationSec: number;
  known: CaptionKnown;
}

/** The parts of a clip someone can change in review. */
export interface ClipEdit {
  title: string;
  kept: boolean;
  firstWord: number;
  lastWord: number;
  captions: Partial<Record<PlatformId, { text: string; hashtags: string[] }>>;
}

/**
 * Apply an edit and check the clip again. The cut and the text are worked
 * out from the words, never taken from the edit, so they always match the
 * transcript. Out-of-range words or unknown platforms leave those parts as
 * they were.
 */
export function reviseClip(clip: SocialClip, edit: ClipEdit, ctx: ClipContext): SocialClip {
  const n = ctx.rawWords.length;
  const valid = (i: unknown): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < n;
  const span =
    valid(edit.firstWord) && valid(edit.lastWord) && edit.firstWord <= edit.lastWord
      ? { firstWord: edit.firstWord, lastWord: edit.lastWord }
      : { firstWord: clip.firstWord, lastWord: clip.lastWord };
  const lines = clipLines(ctx.turns, span.firstWord, span.lastWord);
  const captions: SocialClip["captions"] = {};
  for (const id of Object.keys(clip.captions) as PlatformId[]) {
    const c = edit.captions[id] ?? clip.captions[id]!;
    const text = typeof c.text === "string" ? c.text.slice(0, 10_000) : "";
    const hashtags = Array.isArray(c.hashtags) ? c.hashtags.filter((h): h is string => typeof h === "string").slice(0, 60) : [];
    captions[id] = checkCaption({ text, hashtags }, id, ctx.known, "edit").caption;
  }
  const title = typeof edit.title === "string" ? edit.title.trim().slice(0, 300) : clip.title;
  const cut = clipCut(ctx.rawWords, ctx.durationSec, span.firstWord, span.lastWord);
  return {
    ...clip,
    ...span,
    ...cut,
    crosstalk: clipCrosstalk(ctx.rawWords, ctx.rawSpeakers, span.firstWord, span.lastWord, cut.start),
    // Keep the old text if the edit left no words between the edges (it can't, but just in case).
    lines: lines.length ? lines : clip.lines,
    title,
    titleProblems: titleProblems(title),
    kept: edit.kept === true,
    captions,
  };
}

// ---------------------------------------------------------------------------
// Checking the model's suggestions

/**
 * Turn the model's suggestions into clips that hold up: each one found in
 * the transcript by its first and last words, edges on sentence boundaries
 * where close, within the length settings, not overlapping another, and no
 * more than the most clips allowed.
 */
export function checkClips(
  drafts: ClipDraft[],
  turns: CleanTurn[],
  opts: ClipCheckOptions,
): { clips: SocialClip[]; checks: SocialResult["checks"] } {
  const words = flatten(turns);
  const { limits } = opts;
  const speakers = opts.rawSpeakers ?? opts.rawWords.map((w) => String(w.speaker));
  const dropped: SocialResult["checks"]["dropped"] = [];
  const kept: { from: number; to: number; draft: ClipDraft }[] = [];
  const minSec = limits.minSeconds - SHORT_SLACK_SEC;
  const maxSec = limits.maxSeconds + LONG_SLACK_SEC;

  for (const draft of drafts) {
    const title = draft.title || "Untitled clip";
    const first = keysOf(draft.first_words);
    const last = keysOf(draft.last_words);
    if (first.length < 3 || last.length < 3) {
      dropped.push({ title, reason: "Its first or last words were too short to find in the transcript." });
      continue;
    }
    const starts = findAll(words, first);
    if (!starts.length) {
      dropped.push({ title, reason: "Its first words aren't in the transcript." });
      continue;
    }
    // The first start with a matching ending in range; otherwise say why the closest one failed.
    let found: { from: number; to: number } | null = null;
    let tooLong = false;
    let tooShort = false;
    const ends = findAll(words, last).map((e) => e + last.length - 1);
    for (const s of starts) {
      for (const e of ends) {
        if (e < s + first.length - 1) continue;
        const from = snapStart(words, s);
        const to = snapEnd(words, e);
        // Prefer the sentence edges, but not if they push the clip out of range.
        const options = [
          { from, to },
          { from: s, to },
          { from, to: e },
          { from: s, to: e },
        ];
        const fits = options.find((o) => {
          const sec = words[o.to]!.end - words[o.from]!.start;
          return sec >= minSec && sec <= maxSec;
        });
        if (fits) {
          found = fits;
          break;
        }
        const sec = words[e]!.end - words[s]!.start;
        if (sec > maxSec) tooLong = true;
        else tooShort = true;
      }
      if (found) break;
    }
    if (!found) {
      dropped.push({
        title,
        reason: !ends.length
          ? "Its last words aren't in the transcript."
          : tooShort && !tooLong
            ? `Shorter than ${limits.minSeconds} seconds.`
            : tooLong && !tooShort
              ? `Longer than ${limits.maxSeconds} seconds.`
              : "Its last words don't come after its first words within the clip length.",
      });
      continue;
    }
    if (opts.oneSpeaker) {
      const solo = soloSpan(words, speakers, found.from, found.to, minSec);
      if (!solo) {
        dropped.push({ title, reason: "Someone else talks in it, and no stretch with one speaker is long enough." });
        continue;
      }
      found = solo;
    }
    if (kept.length >= limits.maxClips) {
      dropped.push({ title, reason: `More than ${limits.maxClips} clips were suggested.` });
      continue;
    }
    const overlaps = kept.some((k) => found!.from <= k.to && k.from <= found!.to);
    if (overlaps) {
      dropped.push({ title, reason: "It overlaps another clip." });
      continue;
    }
    kept.push({ ...found, draft });
  }

  const known = captionKnown(turns, opts.facts, opts.allowedUrls);
  let hashtagsDropped = 0;

  const clips = kept
    .sort((a, b) => a.from - b.from)
    .map(({ from, to, draft }, n): SocialClip => {
      const firstWord = words[from]!.index;
      const lastWord = words[to]!.index;
      const captions: SocialClip["captions"] = {};
      for (const id of opts.platforms) {
        const d = draft.captions[id];
        if (!d?.text) continue;
        const checked = checkCaption(d, id, known, "model");
        captions[id] = checked.caption;
        hashtagsDropped += checked.hashtagsDropped;
      }
      const title = draft.title || "Untitled clip";
      const cut = clipCut(opts.rawWords, opts.durationSec, firstWord, lastWord);
      return {
        id: `clip-${n + 1}`,
        title,
        why: draft.why,
        firstWord,
        lastWord,
        ...cut,
        lines: clipLines(turns, firstWord, lastWord),
        captions,
        titleProblems: titleProblems(title),
        crosstalk: clipCrosstalk(opts.rawWords, speakers, firstWord, lastWord, cut.start),
        kept: false,
      };
    });

  return { clips, checks: { suggested: drafts.length, dropped, hashtagsDropped } };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Everything needed to re-check an episode's clips, from its transcript, review edits and notes. */
export function clipContext(transcript: Transcript, edits: EpisodeEdits, writing: WritingResult | null, website: string): ClipContext {
  const turns = cleanTranscript(transcript, edits);
  const facts = confirmedFacts(writing?.research ?? null).map((f) => f.fact);
  const links = writing?.research?.links.map((l) => l.url) ?? [];
  return {
    turns,
    rawWords: transcript.words,
    rawSpeakers: rawSpeakerNames(transcript, edits),
    durationSec: transcript.durationSec ?? transcript.words.at(-1)?.end ?? 0,
    known: captionKnown(turns, facts, [website, ...links].filter(Boolean)),
  };
}
