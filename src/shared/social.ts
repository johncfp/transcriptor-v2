import { providerById } from "./providers";

// Social clips: after the show notes, a model picks moments from the timed
// transcript and writes a caption for each platform. The clip text and times
// come from the transcript, never the model; clips are reviewed before they're
// cut (as WAV) and exported.

/**
 * Platforms a caption can be written for. `maxChars` is the platform's limit
 * for the caption with its hashtags (the smaller one where two share an
 * entry: Instagram over TikTok, X over Threads); `maxHashtags` is what the
 * app keeps. `guide` tells the model what to write.
 */
export const PLATFORMS = [
  {
    id: "instagram",
    label: "Instagram / TikTok",
    hint: "Short hook plus hashtags.",
    maxChars: 2200,
    maxHashtags: 5,
    guide: "1 to 3 short sentences that open with a hook; up to 5 hashtags.",
  },
  {
    id: "x",
    label: "X / Threads",
    hint: "One short post.",
    maxChars: 280,
    maxHashtags: 2,
    guide: "one post, under 240 characters including hashtags; at most 2 hashtags.",
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    hint: "Longer, professional post.",
    maxChars: 3000,
    maxHashtags: 5,
    guide: "3 to 6 sentences in a professional tone, ending with the takeaway or a question for readers; up to 3 hashtags.",
  },
  {
    id: "youtube",
    label: "YouTube Shorts",
    hint: "Title plus description.",
    maxChars: 5000,
    maxHashtags: 5,
    guide: "a 1 to 2 sentence description (the clip's title is the Short's title); up to 3 hashtags.",
  },
] as const;

/** Longest clip title kept without a warning (YouTube's title limit). */
export const MAX_TITLE_CHARS = 100;

export type PlatformId = (typeof PLATFORMS)[number]["id"];

/**
 * The step's own default model per provider, used when Settings leaves the
 * model blank. Claude gets Sonnet: picking clips and writing captions is
 * lighter work than the show notes. Other providers use their usual default.
 */
export const SOCIAL_DEFAULT_MODELS: Record<string, string> = { anthropic: "claude-sonnet-5-5" };

export const socialDefaultModel = (provider: string): string =>
  SOCIAL_DEFAULT_MODELS[provider] ?? providerById(provider)?.defaultModel ?? "";

/** Allowed ranges for the clip settings. */
export const CLIP_COUNT_RANGE = { min: 1, max: 10 } as const;
export const CLIP_SECONDS_RANGE = { min: 5, max: 180 } as const;

export interface ClipLimits {
  minClips: number;
  maxClips: number;
  minSeconds: number;
  maxSeconds: number;
}

const clamp = (n: number, range: { min: number; max: number }, fallback: number) =>
  Number.isFinite(n) ? Math.min(range.max, Math.max(range.min, Math.round(n))) : fallback;

/** The clip settings as whole numbers in range, with each minimum at or below its maximum. */
export function clipLimits(s: ClipLimits): ClipLimits {
  const a = clamp(s.minClips, CLIP_COUNT_RANGE, 3);
  const b = clamp(s.maxClips, CLIP_COUNT_RANGE, 5);
  const c = clamp(s.minSeconds, CLIP_SECONDS_RANGE, 15);
  const d = clamp(s.maxSeconds, CLIP_SECONDS_RANGE, 60);
  return { minClips: Math.min(a, b), maxClips: Math.max(a, b), minSeconds: Math.min(c, d), maxSeconds: Math.max(c, d) };
}
