// Clip videos with translated captions (subtitles S3). The captions are the
// episode's translated subtitle cues (src/shared/subtitleTranslation.ts)
// that fall in the clip, shown a cue at a time with the cue's own times:
// there are no word times in a translation, so there's no word highlight.
// The few fixed words a video shows (the outro, name cards) are translated
// here, by hand, not by the model.

import type { Cue } from "./subtitles";
import type { TranslationLanguage } from "./subtitleTranslation";

/** The words a video shows besides the captions, per caption language; null = the original's (English). */
export interface VideoStrings {
  fullEpisodeOn: string;
  fullEpisodeAt: string;
  host: string;
  guest: string;
}

export const VIDEO_STRINGS: Record<TranslationLanguage | "original", VideoStrings> = {
  original: { fullEpisodeOn: "Full episode on", fullEpisodeAt: "Full episode at", host: "Host", guest: "Guest" },
  es: { fullEpisodeOn: "Episodio completo en", fullEpisodeAt: "Episodio completo en", host: "Anfitrión", guest: "Invitado" },
  pt: { fullEpisodeOn: "Episódio completo em", fullEpisodeAt: "Episódio completo em", host: "Apresentador", guest: "Convidado" },
  fr: { fullEpisodeOn: "Épisode complet sur", fullEpisodeAt: "Épisode complet sur", host: "Animateur", guest: "Invité" },
  de: { fullEpisodeOn: "Ganze Folge bei", fullEpisodeAt: "Ganze Folge auf", host: "Moderation", guest: "Gast" },
  zh: { fullEpisodeOn: "完整节目：", fullEpisodeAt: "完整节目：", host: "主持人", guest: "嘉宾" },
};

export const videoStrings = (language: TranslationLanguage | null | undefined) => VIDEO_STRINGS[language ?? "original"];

/** A clip's captions in a translation: its cues, times from the clip's start, kept inside the clip. */
export interface ClipTranslation {
  language: TranslationLanguage;
  cues: Cue[];
  /** The clip's pull quote, translated; null when the clip has none (or it couldn't be translated). */
  quote: string | null;
}

/**
 * The cues that fall in a clip (from `start` to `end`, episode seconds), with
 * times from the clip's start. A cue that starts before the clip or runs past
 * its end is cut to fit; cues barely inside it (under a quarter of a second)
 * are left out, as they'd only flash.
 */
export function clipCues(cues: Cue[], clip: { start: number; end: number }): Cue[] {
  const length = clip.end - clip.start;
  return cues
    .map((c) => ({ ...c, start: Math.max(0, c.start - clip.start), end: Math.min(length, c.end - clip.start) }))
    .filter((c) => c.end - c.start >= 0.25)
    .map((c) => ({ ...c, start: round(c.start), end: round(c.end) }));
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** "Episode 386 - Clip 2 - Tools versus reasons (vertical).mp4", with the language when it's a translation: "(vertical, Spanish)". */
export const videoLanguageTag = (languageName: string | null) => (languageName ? `, ${languageName}` : "");
