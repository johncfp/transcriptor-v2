// Code checks on what the AI writes. The model is asked to follow the rules;
// these functions make sure it did, and drop anything that doesn't hold up.

import { normalize, type CleanTurn } from "./cleanup";
import type { GuestResearch, NotesContent, Quote, ReferenceContent, SourcedFact, WritingChecks } from "./showNotes";
import { formatTimestamp } from "./transcript";

// ---------------------------------------------------------------------------
// Transcript as the model sees it

/**
 * "[mm:ss] Name: text" lines. Long turns get a fresh time marker about every
 * `every` seconds, so segment timestamps can land mid-turn.
 */
export function transcriptForPrompt(turns: CleanTurn[], every = 60): string {
  const lines: string[] = [];
  for (const turn of turns) {
    let chunk: string[] = [];
    let chunkStart = turn.start;
    const flush = () => {
      if (chunk.length) lines.push(`[${formatTimestamp(chunkStart)}] ${turn.speaker}: ${chunk.join(" ")}`);
      chunk = [];
    };
    for (const w of turn.words) {
      if (chunk.length && w.start - chunkStart >= every && /[.?!]$/.test(chunk.at(-1)!)) {
        flush();
        chunkStart = w.start;
      }
      if (!chunk.length) chunkStart = w.start;
      chunk.push(w.text);
    }
    flush();
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Quotes

interface FlatWord {
  key: string;
  text: string;
  start: number;
  speaker: string;
  turn: number;
}

function flatten(turns: CleanTurn[]): FlatWord[] {
  return turns.flatMap((t, turn) =>
    t.words.map((w) => ({ key: normalize(w.text), text: w.text, start: w.start, speaker: t.speaker, turn })),
  );
}

/** Split quote text into comparable words ("don't—really" → ["don't", "really"]). */
const quoteKeys = (text: string) => text.split(/[\s—–]+/).map(normalize).filter(Boolean);

/**
 * Keep only quotes that appear word for word (ignoring punctuation and case)
 * inside a single turn. The saved text, speaker and time come from the
 * transcript itself, so nothing the model paraphrased survives.
 */
export function verifyQuotes(drafts: { text: string }[], turns: CleanTurn[]): { quotes: Quote[]; dropped: string[] } {
  const words = flatten(turns);
  const quotes: Quote[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();

  for (const draft of drafts) {
    const keys = quoteKeys(draft.text);
    if (keys.length < 3) {
      dropped.push(draft.text);
      continue;
    }
    let at = -1;
    for (let i = 0; i + keys.length <= words.length && at < 0; i++) {
      if (words[i]!.key !== keys[0]) continue;
      if (keys.every((k, j) => words[i + j]!.key === k && words[i + j]!.turn === words[i]!.turn)) at = i;
    }
    if (at < 0) {
      dropped.push(draft.text);
      continue;
    }
    const span = words.slice(at, at + keys.length);
    const text = span
      .map((w) => w.text)
      .join(" ")
      .replace(/[,;:—–-]+$/, "");
    if (seen.has(text)) continue;
    seen.add(text);
    quotes.push({ speaker: span[0]!.speaker, text: capitalizeFirst(text), time: span[0]!.start });
  }
  return { quotes, dropped };
}

const capitalizeFirst = (s: string) => s.replace(/^(\P{L}*)(\p{Ll})/u, (_, pre: string, c: string) => pre + c.toUpperCase());

// ---------------------------------------------------------------------------
// Timestamps

/** "12:05" or "1:02:05" → seconds; null if it isn't a time. */
export function parseTimestamp(s: string): number | null {
  const m = s.trim().replace(/^\[|\]$/g, "").match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [, h, min, sec] = m;
  if (Number(sec) >= 60) return null;
  return Number(h ?? 0) * 3600 + Number(min) * 60 + Number(sec);
}

/**
 * Keep segment times that fall inside the episode, snap each to the nearest
 * turn start (within 30 s) so it lands where someone starts talking, and put
 * them in order without duplicates.
 */
export function verifyTimestamps(
  drafts: { time: string; label: string }[],
  turns: CleanTurn[],
  durationSec: number,
): { timestamps: { time: number; label: string }[]; dropped: number } {
  const starts = turns.map((t) => t.start);
  const kept = new Map<number, string>();
  let dropped = 0;
  for (const d of drafts) {
    const t = parseTimestamp(d.time);
    const label = d.label.trim();
    if (t === null || !label || t > durationSec + 1) {
      dropped++;
      continue;
    }
    const nearest = starts.reduce((best, s) => (Math.abs(s - t) < Math.abs(best - t) ? s : best), Infinity);
    const time = Math.abs(nearest - t) <= 30 ? Math.floor(nearest) : t;
    if (kept.has(time)) {
      dropped++;
      continue;
    }
    kept.set(time, label);
  }
  const timestamps = [...kept].sort((a, b) => a[0] - b[0]).map(([time, label]) => ({ time, label }));
  // The first segment starts the episode.
  if (timestamps[0] && timestamps[0].time <= 30) timestamps[0].time = 0;
  return { timestamps, dropped };
}

// ---------------------------------------------------------------------------
// Research

/** Comparable form of a URL: no scheme, "www.", query, hash or trailing slash. */
export function normalizeUrl(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return (u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch {
    return null;
  }
}

export interface RawResearch {
  identified: boolean;
  facts: { fact: string; source_urls: string[] }[];
  links: { label: string; url: string }[];
  /** URLs the search actually returned, or null when the provider doesn't say. */
  searchedUrls: string[] | null;
}

/**
 * A fact counts as confirmed only when one of its sources is a page the
 * search really returned; a link is kept only on the same condition. When
 * the provider doesn't return sources, nothing can be confirmed.
 */
export function verifyResearch(guestName: string, raw: RawResearch): { research: GuestResearch; linksDropped: number } {
  const allowed = raw.searchedUrls ? new Set(raw.searchedUrls.map(normalizeUrl).filter(Boolean)) : null;
  const isAllowed = (url: string) => {
    const n = normalizeUrl(url);
    return n !== null && allowed !== null && allowed.has(n);
  };

  const facts: SourcedFact[] = raw.identified
    ? raw.facts
        .filter((f) => f.fact.trim())
        .map((f) => ({ fact: f.fact.trim(), sources: [...new Set(f.source_urls.filter(isAllowed))] }))
    : [];
  const links = raw.identified ? raw.links.filter((l) => l.label.trim() && isAllowed(l.url)) : [];
  return {
    research: {
      guestName,
      identified: raw.identified,
      facts,
      links: links.map((l) => ({ label: l.label.trim(), url: l.url.trim() })),
      sourcesUnavailable: allowed === null,
    },
    linksDropped: raw.identified ? raw.links.length - links.length : 0,
  };
}

/** The facts the writer is allowed to use: confirmed ones about the right person. */
export const confirmedFacts = (r: GuestResearch | null) =>
  r?.identified ? r.facts.filter((f) => f.sources.length > 0) : [];

// ---------------------------------------------------------------------------
// The draft from the writing model

export interface WritingDraft {
  title_suggestion: string;
  summary: string;
  about_guest: string;
  timestamps: { time: string; label: string }[];
  topics: { title: string; points: string[] }[];
  quotes: { text: string }[];
  rapid_fire: { question: string; answer: string }[];
  takeaways: string[];
  resources: string[];
  reference: {
    topics: string[];
    keywords: string[];
    high_notes: string[];
    quotes: { text: string }[];
    frameworks: { name: string; description: string }[];
  };
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const arr = (v: unknown) => (Array.isArray(v) ? v : []);
const strs = (v: unknown) => arr(v).map(str).filter(Boolean);
const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/**
 * Read a draft defensively. Providers without schema enforcement (Kimi,
 * Qwen) can return missing or oddly typed fields; those become empty rather
 * than breaking the run.
 */
export function coerceDraft(value: unknown): WritingDraft {
  const d = obj(value);
  const ref = obj(d.reference);
  const quotes = (v: unknown) => arr(v).map((q) => ({ text: typeof q === "string" ? q.trim() : str(obj(q).text) })).filter((q) => q.text);
  return {
    title_suggestion: str(d.title_suggestion),
    summary: str(d.summary),
    about_guest: str(d.about_guest),
    timestamps: arr(d.timestamps).map((t) => ({ time: str(obj(t).time), label: str(obj(t).label) })),
    topics: arr(d.topics)
      .map((t) => ({ title: str(obj(t).title), points: strs(obj(t).points) }))
      .filter((t) => t.title),
    quotes: quotes(d.quotes),
    rapid_fire: arr(d.rapid_fire)
      .map((r) => ({ question: str(obj(r).question), answer: str(obj(r).answer) }))
      .filter((r) => r.question && r.answer),
    takeaways: strs(d.takeaways),
    resources: strs(d.resources),
    reference: {
      topics: strs(ref.topics),
      keywords: strs(ref.keywords),
      high_notes: strs(ref.high_notes),
      quotes: quotes(ref.quotes),
      frameworks: arr(ref.frameworks)
        .map((f) => ({ name: str(obj(f).name), description: str(obj(f).description) }))
        .filter((f) => f.name),
    },
  };
}

/** Turn a draft into checked content, recording what was dropped. */
export function checkDraft(
  draft: WritingDraft,
  turns: CleanTurn[],
  durationSec: number,
): { notes: NotesContent; reference: ReferenceContent; checks: Omit<WritingChecks, "linksDropped"> } {
  const notesQuotes = verifyQuotes(draft.quotes, turns);
  const refQuotes = verifyQuotes(draft.reference.quotes, turns);
  const times = verifyTimestamps(draft.timestamps, turns, durationSec);
  return {
    notes: {
      titleSuggestion: draft.title_suggestion,
      summary: draft.summary,
      aboutGuest: draft.about_guest,
      timestamps: times.timestamps,
      topics: draft.topics,
      quotes: notesQuotes.quotes,
      rapidFire: draft.rapid_fire,
      takeaways: draft.takeaways,
      resources: draft.resources,
    },
    reference: {
      topics: draft.reference.topics,
      keywords: [...new Set(draft.reference.keywords)].slice(0, 5),
      highNotes: draft.reference.high_notes,
      quotes: refQuotes.quotes,
      frameworks: draft.reference.frameworks,
    },
    checks: {
      quotesDropped: [...notesQuotes.dropped, ...refQuotes.dropped],
      timestampsDropped: times.dropped,
    },
  };
}
