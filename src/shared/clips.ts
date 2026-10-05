// Code checks on the social clips the AI suggests, and the saved result
// (`<userData>/episodes/<id>/social.json`). The model only names where a clip
// starts and ends, by copying its first and last words; the clip's text,
// speakers and times come from the transcript. Clips that can't be found or
// don't fit the settings are dropped; caption problems are flagged for review.

import { normalize, type CleanTurn } from "./cleanup";
import { MAX_TITLE_CHARS, PLATFORMS, type ClipLimits, type PlatformId } from "./social";
import type { Word } from "./transcript";
import { normalizeUrl } from "./verify";

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
  /** Where to cut, in seconds, with a little room around the words. */
  start: number;
  end: number;
  /** What's said, by speaker, from the cleaned transcript. */
  lines: { speaker: string; text: string }[];
  captions: Partial<Record<PlatformId, SocialCaption>>;
  /** Title problems, e.g. too long for YouTube. */
  titleProblems: string[];
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

function checkCaption(
  draft: { text: string; hashtags: string[] },
  platform: (typeof PLATFORMS)[number],
  known: { numbers: Set<string>; urls: Set<string> },
): { caption: SocialCaption; hashtagsDropped: number } {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of draft.hashtags) {
    const tag = cleanHashtag(raw);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
  }
  const hashtags = tags.slice(0, platform.maxHashtags);
  const text = draft.text.trim();
  const problems: string[] = [];

  const length = text.length + (hashtags.length ? 2 + hashtags.map((t) => `#${t}`).join(" ").length : 0);
  if (length > platform.maxChars) problems.push(`${length - platform.maxChars} characters over ${platform.label}'s ${platform.maxChars} limit.`);
  for (const n of new Set(numbersIn(text))) {
    if (!known.numbers.has(n)) problems.push(`“${n}” isn't in the transcript or the confirmed guest facts.`);
  }
  for (const url of new Set(urlsIn(text))) {
    const n = normalizeUrl(/^www\./i.test(url) ? `https://${url}` : url);
    if (!n || !known.urls.has(n)) problems.push(`The link ${url} isn't the show's website or a confirmed guest link.`);
  }
  return { caption: { text, hashtags, problems }, hashtagsDropped: tags.length - hashtags.length };
}

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

  const transcriptText = words.map((w) => w.text).join(" ");
  const known = {
    numbers: new Set([...numbersIn(transcriptText), ...opts.facts.flatMap(numbersIn)]),
    urls: new Set(opts.allowedUrls.map(normalizeUrl).filter((u): u is string => u !== null)),
  };
  let hashtagsDropped = 0;

  const clips = kept
    .sort((a, b) => a.from - b.from)
    .map(({ from, to, draft }, n): SocialClip => {
      const span = words.slice(from, to + 1);
      const lines: SocialClip["lines"] = [];
      for (const w of span) {
        const line = lines.at(-1);
        if (line && line.speaker === w.speaker) line.text += ` ${w.text}`;
        else lines.push({ speaker: w.speaker, text: w.text });
      }
      // Room around the words, without reaching into the neighbouring words of the raw
      // audio, and never cutting into the clip's own first or last word.
      const first = span[0]!;
      const last = span.at(-1)!;
      const prev = opts.rawWords[first.index - 1];
      const next = opts.rawWords[last.index + 1];
      const start = Math.max(0, Math.min(first.start, Math.max(prev?.end ?? 0, first.start - PAD_BEFORE)));
      const endLimit = next ? next.start : opts.durationSec || Infinity;
      const end = Math.max(last.end, Math.min(endLimit, last.end + PAD_AFTER));

      const captions: SocialClip["captions"] = {};
      for (const id of opts.platforms) {
        const platform = PLATFORMS.find((p) => p.id === id)!;
        const d = draft.captions[id];
        if (!d?.text) continue;
        const checked = checkCaption(d, platform, known);
        captions[id] = checked.caption;
        hashtagsDropped += checked.hashtagsDropped;
      }
      const title = draft.title || "Untitled clip";
      return {
        id: `clip-${n + 1}`,
        title,
        why: draft.why,
        start: round(start),
        end: round(end),
        lines,
        captions,
        titleProblems: title.length > MAX_TITLE_CHARS ? [`${title.length - MAX_TITLE_CHARS} characters over YouTube's ${MAX_TITLE_CHARS}-character title limit.`] : [],
      };
    });

  return { clips, checks: { suggested: drafts.length, dropped, hashtagsDropped } };
}

const round = (n: number) => Math.round(n * 1000) / 1000;
