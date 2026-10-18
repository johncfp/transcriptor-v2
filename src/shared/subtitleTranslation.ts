// Translated subtitles: the episode's cues, translated by the writing model
// one cue at a time so each keeps its times. Like other AI output, the
// translation is checked in code: every cue must come back, once, in order;
// any that don't (after a retry) stay in the original language and are
// counted, and numbers that go missing are noted.

import { splitLines, SUBTITLE_LIMITS, type Cue } from "./subtitles";

export const TRANSLATION_LANGUAGES = [
  { id: "es", name: "Spanish", prompt: "Spanish (Latin American)" },
  { id: "pt", name: "Portuguese", prompt: "Portuguese (Brazilian)" },
  { id: "fr", name: "French", prompt: "French" },
  { id: "de", name: "German", prompt: "German" },
  { id: "zh", name: "Mandarin", prompt: "Simplified Chinese (Mandarin)" },
] as const;
export type TranslationLanguage = (typeof TRANSLATION_LANGUAGES)[number]["id"];
export const translationLanguage = (id: TranslationLanguage) => TRANSLATION_LANGUAGES.find((l) => l.id === id)!;

/** Saved translations for an episode: for the subtitles with this `source` key, by language. */
export interface SubtitleTranslations {
  version: 1;
  source: string;
  languages: Partial<Record<TranslationLanguage, { provider: string; model: string; at: string; texts: string[]; problems: string[] }>>;
  /** Clips' pull quotes, by language, original text → translation, for translated videos. */
  quotes?: Partial<Record<TranslationLanguage, Record<string, string>>>;
}

/** Chinese subtitle lines are shorter: 16 characters is the usual limit. */
export const CJK_LINE_CHARS = 16;

/**
 * What's sent for translation: one segment per cue, or one per speaker in a
 * cue shared by two (the "- " lines), so the dashes can be put back.
 */
export interface Segment {
  id: number;
  cue: number;
  /** Which dash line of a shared cue; absent for a cue with one speaker. */
  part?: 0 | 1;
  text: string;
}

export function segmentsOf(cues: Cue[]): Segment[] {
  const out: Segment[] = [];
  cues.forEach((c, cue) => {
    if (c.lines.length === 2 && c.lines.every((l) => l.startsWith("- "))) {
      c.lines.forEach((l, part) => out.push({ id: out.length, cue, part: part as 0 | 1, text: l.slice(2) }));
    } else out.push({ id: out.length, cue, text: c.lines.join(" ") });
  });
  return out;
}

/** The segments' texts as one string, to tell whether a saved translation is of the same subtitles. */
export function sourceKey(segments: Segment[]): string {
  // FNV-1a over the texts, with the count; enough to notice any change.
  let h = 0x811c9dc5;
  const text = segments.map((s) => s.text).join("\u0001");
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${segments.length}:${h.toString(16)}`;
}

export function translationSystem(source: string, target: TranslationLanguage): string {
  const lang = translationLanguage(target);
  return `You translate a podcast's subtitles from ${source} into ${lang.prompt}.

Each segment is a short stretch of speech, shown on screen while it's said. Translate every segment in order, keeping each one's meaning in that segment, so the subtitles still line up with the speech; move a word to a neighbouring segment only where the grammar truly forces it. Translate naturally, as people speak, not word for word, and never add, drop, explain or tidy up what was said. Keep the names of people, shows, companies, products and places as they are${
    target === "zh" ? ", in Latin letters unless they have a well-known Chinese name" : ""
  }. Keep numbers, as digits. Segments marked as context are there only to help with meaning: don't return them.

Return every segment you're asked to translate, once each, with its id.`;
}

/** The user prompt for one batch: context before and after, then the segments to translate. */
export function translationPrompt(batch: Segment[], before: Segment[], after: Segment[]): string {
  const line = (s: Segment) => `${s.id}: ${s.text}`;
  return [
    before.length ? `Context before (don't translate):\n${before.map(line).join("\n")}\n` : "",
    `Translate these segments:\n${batch.map(line).join("\n")}`,
    after.length ? `\nContext after (don't translate):\n${after.map(line).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export const translationSchema = {
  type: "object",
  properties: {
    segments: {
      type: "array",
      items: { type: "object", properties: { id: { type: "integer" }, text: { type: "string" } }, required: ["id", "text"], additionalProperties: false },
    },
  },
  required: ["segments"],
  additionalProperties: false,
};

/** Read a batch's translations defensively: only asked-for ids, first answer for each, non-empty text. */
export function readTranslations(value: unknown, asked: Segment[]): Map<number, string> {
  const ids = new Set(asked.map((s) => s.id));
  const out = new Map<number, string>();
  const list = value && typeof value === "object" && Array.isArray((value as { segments?: unknown }).segments) ? (value as { segments: unknown[] }).segments : [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const { id, text } = item as { id?: unknown; text?: unknown };
    const n = typeof id === "number" ? id : typeof id === "string" ? Number(id) : NaN;
    if (!ids.has(n) || out.has(n) || typeof text !== "string" || !text.trim()) continue;
    out.set(n, text.trim().replace(/\s*\n\s*/g, " "));
  }
  return out;
}

const numbersIn = (text: string) => [...text.matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => m[0].replace(/[.,]/g, ""));

/**
 * Checks on a finished translation: segments that never came back keep the
 * original text (and are counted), and segments whose numbers changed are noted.
 */
export function checkTranslation(segments: Segment[], got: Map<number, string>): { texts: string[]; problems: string[] } {
  let missing = 0;
  const numberIssues: string[] = [];
  const texts = segments.map((s) => {
    const t = got.get(s.id);
    if (t === undefined) {
      missing++;
      return s.text;
    }
    const want = numbersIn(s.text), have = new Set(numbersIn(t));
    if (want.some((n) => !have.has(n))) numberIssues.push(s.text);
    return t;
  });
  const problems: string[] = [];
  if (missing) problems.push(`${missing} subtitle${missing === 1 ? "" : "s"} couldn't be translated and ${missing === 1 ? "is" : "are"} left in the original language.`);
  if (numberIssues.length) {
    const first = numberIssues[0]!.slice(0, 60);
    problems.push(`${numberIssues.length} subtitle${numberIssues.length === 1 ? " has" : "s have"} a number that changed in translation (first: “${first}”). Worth a look.`);
  }
  return { texts, problems };
}

/**
 * The translated cues: the same times as the original, the translated text
 * laid out in lines again (a shared cue keeps its dashes when each part still
 * fits a line). Translations can run longer than the original, so a line may
 * be longer than the usual limit rather than the cue being re-timed.
 */
export function translatedCues(cues: Cue[], segments: Segment[], texts: string[], target: TranslationLanguage): Cue[] {
  const cjk = target === "zh";
  const limit = cjk ? CJK_LINE_CHARS : SUBTITLE_LIMITS.lineChars;
  const split = (t: string) => (cjk ? splitCjk(t, limit) : splitLines(t, limit));
  return cues.map((c, i) => {
    const parts = segments.map((s, k) => ({ s, t: texts[k]! })).filter((p) => p.s.cue === i);
    if (parts.length === 2) {
      const [a, b] = parts.map((p) => p.t);
      if (a!.length + 2 <= limit * 1.25 && b!.length + 2 <= limit * 1.25) return { ...c, lines: [`- ${a}`, `- ${b}`] };
      return { ...c, lines: split(`${a}${cjk ? "" : " "}${b}`) };
    }
    return { ...c, lines: split(parts[0]?.t ?? c.lines.join(" ")) };
  });
}

const CJK_BREAK_AFTER = /[，。！？、；：,.!?;:）」』”]/;

/**
 * Chinese has no spaces between words, so lines break between characters:
 * one line if it fits, otherwise two near the middle, after punctuation
 * where there's some close by, never leaving punctuation to start a line.
 */
export function splitCjk(text: string, lineChars: number = CJK_LINE_CHARS): string[] {
  const chars = [...text];
  if (chars.length - (CJK_BREAK_AFTER.test(chars.at(-1) ?? "") ? 1 : 0) <= lineChars) return [text];
  const mid = chars.length / 2;
  let best = { at: Math.ceil(mid), score: Infinity };
  for (let i = 1; i < chars.length; i++) {
    if (CJK_BREAK_AFTER.test(chars[i]!) && !/\s/.test(chars[i]!)) continue; // punctuation can't start a line
    // Punctuation ending a line doesn't count towards its length, as is usual.
    const endsPunct = CJK_BREAK_AFTER.test(chars[i - 1]!);
    const a = i - (endsPunct ? 1 : 0), b = chars.length - i - (CJK_BREAK_AFTER.test(chars.at(-1)!) ? 1 : 0);
    const over = Math.max(0, a - lineChars) + Math.max(0, b - lineChars);
    const punct = endsPunct ? 6 : 0;
    const score = over * 100 + Math.abs(a - b) - punct;
    if (score < best.score) best = { at: i, score };
  }
  return [chars.slice(0, best.at).join("").trim(), chars.slice(best.at).join("").trim()];
}
