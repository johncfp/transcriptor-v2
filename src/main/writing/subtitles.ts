// Translates an episode's subtitles with the writing model (the Social
// clips model: Claude Sonnet by default). Checked in src/shared/subtitleTranslation.ts.

import {
  checkTranslation,
  readTranslations,
  translationPrompt,
  translationSchema,
  translationSystem,
  type Segment,
  type TranslationLanguage,
} from "../../shared/subtitleTranslation";
import type { ProviderCall, WritingProvider } from "./types";

/** Segments per request, the context around each batch, and requests at once. */
const BATCH = 100;
const BEFORE = 6;
const AFTER = 3;
const AT_ONCE = 3;

export interface TranslateInput {
  segments: Segment[];
  /** The episode's language, by name ("English"). */
  source: string;
  target: TranslationLanguage;
  writer: WritingProvider;
  call: ProviderCall;
}

/** Run `tasks` with at most `limit` at a time, keeping their order. */
async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        out[i] = await tasks[i]!();
      }
    }),
  );
  return out;
}

export async function translateSubtitles(input: TranslateInput): Promise<{ texts: string[]; problems: string[] }> {
  const { segments, writer, call } = input;
  const system = translationSystem(input.source, input.target);
  const got = new Map<number, string>();
  const ask = async (batch: Segment[]) => {
    const first = segments.indexOf(batch[0]!);
    const last = segments.indexOf(batch.at(-1)!);
    const raw = await writer.draft(
      call,
      { system, user: translationPrompt(batch, segments.slice(Math.max(0, first - BEFORE), first), segments.slice(last + 1, last + 1 + AFTER)) },
      { name: "subtitle_translation", schema: translationSchema, what: "the subtitle translation" },
    );
    for (const [id, text] of readTranslations(raw, batch)) got.set(id, text);
  };
  const batches = (list: Segment[]) => Array.from({ length: Math.ceil(list.length / BATCH) }, (_, i) => list.slice(i * BATCH, (i + 1) * BATCH));
  await pool(batches(segments).map((b) => () => ask(b)), AT_ONCE);
  // Once more for any that didn't come back.
  const missing = segments.filter((s) => !got.has(s.id));
  if (missing.length) await pool(batches(missing).map((b) => () => ask(b)), AT_ONCE);
  return checkTranslation(segments, got);
}
