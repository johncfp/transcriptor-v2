import { EFFORTS, type Effort } from "./providers";
import { DEFAULT_CONFIDENCE_THRESHOLDS } from "./confidence";
import { VOICE_IDS, type VoiceId } from "./voices";
import type { PlatformId } from "./social";
import {
  BACKGROUND_FILE,
  BACKGROUND_TYPES,
  CAPTION_SIZES,
  CAPTION_STYLES,
  VIDEO_FONTS,
  WAVEFORM_STYLES,
  type BackgroundType,
  type CaptionSize,
  type CaptionStyle,
  type ShapeId,
  type VideoFontId,
  type WaveformStyle,
} from "./video";

// Settings schema shared by the main process (which owns the file on disk)
// and the renderer (which edits it over IPC). Keep this file free of Node and
// DOM imports so both sides can use it.

/** Anything added here needs a default in DEFAULT_SETTINGS. */
export interface Settings {
  general: {
    /** Launch at login and sit in the tray. */
    startAtLogin: boolean;
    /** Closing the window hides it to the tray instead of quitting. */
    closeToTray: boolean;
    /** "system" follows Windows/macOS. */
    theme: Theme;
    /** Episode list colors by stage, as "#rrggbb". */
    episodeColors: EpisodeColors;
    /** How the window first opens each time the app starts (see WINDOW_STARTS). */
    startWindow: StartWindow;
  };
  processing: {
    /** "approve" asks before each new file is processed; "auto" just starts. */
    intake: "approve" | "auto";
    /** Pause after transcription so speakers and words can be checked. */
    reviewStep: boolean;
    /** Filler words ("um", "uh") are always removed. This adds false starts and repetitions. */
    removeFalseStarts: boolean;
  };
  output: {
    /** Empty means the default: Documents/Transcriptor 2. */
    folder: string;
    formats: { docx: boolean; txt: boolean; pdf: boolean; googleDoc: boolean };
    /** Export as soon as show notes are written. */
    autoExport: boolean;
    /** Each turn's start time in the exported transcript. */
    transcriptTimestamps: boolean;
    /** How the exported transcript lays out each speaker turn (see SPEAKER_FORMATS). */
    speakerFormat: SpeakerFormat;
    /** Color low- and medium-confidence words in the exported Word transcript. */
    colorConfidence: boolean;
    /** Cover page, logo, header and footer on Word and PDF exports. */
    branding: Branding;
  };
  /**
   * Google Drive folder watching (M5). Built but switched off: nothing reads
   * these until the wiring in src/main/index.ts is turned on.
   */
  watch: { enabled: boolean; folderId: string };
  /**
   * Watching a folder on this computer, typically one Google Drive for
   * Desktop keeps in sync (src/main/watch/folderWatcher.ts).
   */
  folderWatch: {
    enabled: boolean;
    folder: string;
    /** How long to let other computers' claims sync before taking a file (1, 5 or 15). */
    settleMinutes: number;
  };
  /** Where words get a low- or medium-confidence color. */
  confidence: { lowMax: number; mediumMax: number };
  show: ShowProfile;
  writing: ModelChoice & VoiceChoice;
  /**
   * Social clips (src/shared/social.ts): after the show notes, a model picks
   * moments from the transcript and writes captions; they're reviewed before
   * the clips are cut and exported.
   */
  /** Video clips (src/shared/video.ts): kept clips as MP4s with captions. */
  video: VideoSettings;
  social: ModelChoice &
    VoiceChoice & {
      enabled: boolean;
      /** How many clips to suggest; clamped by clipLimits. */
      minClips: number;
      maxClips: number;
      /** Clip length in seconds; clamped by clipLimits. */
      minSeconds: number;
      maxSeconds: number;
      /** Only clips where one person talks: others are trimmed to one speaker or dropped (see checkClips). */
      oneSpeaker: boolean;
      /** Which platforms get a caption (see PLATFORMS). */
      platforms: Record<PlatformId, boolean>;
    };
  /** "full", "standard", "minimal" or "custom" (see src/shared/showNotes.ts). */
  template: string;
  /** Section ids, in order, for the "custom" template. */
  customSections: string[];
}

export interface VideoSettings {
  enabled: boolean;
  shapes: Record<ShapeId, boolean>;
  captionStyle: CaptionStyle;
  font: VideoFontId;
  captionSize: CaptionSize;
  /** As "#rrggbb". The highlight colours the current word, the speaker name and the waveform's newest bar. */
  colors: { background: string; text: string; highlight: string };
  backgroundType: BackgroundType;
  /** File name of the imported background in userData/branding (a JPEG); empty = none. */
  backgroundImage: string;
  /** The logo from Output › Cover page, header and footer. */
  showLogo: boolean;
  showShowName: boolean;
  showSpeakers: boolean;
  waveform: boolean;
  waveformStyle: WaveformStyle;
  /** Animation, each part on its own (see MOTION in src/shared/video.ts). */
  motion: VideoMotion;
}

export interface VideoMotion {
  /** A short quote from the clip at the start, in place of the logo and show name. */
  hook: boolean;
  /** The word being said grows for a moment. */
  pop: boolean;
  /** A soft light that drifts across the background and brightens with the voice. */
  glow: boolean;
  /** A bar along the bottom showing how far into the clip it is. */
  progress: boolean;
  /** A card after the audio: the logo, "Full episode on {show}" and the website. */
  outro: boolean;
}

/** Which provider, model and effort a writing step uses. */
export interface ModelChoice {
  /** Provider id from src/shared/providers.ts (role "writing"). */
  provider: string;
  /** Blank = the step's default model for the provider. */
  model: string;
  /** Blank = the provider's usual endpoint. Needed for Qwen outside the default region. */
  baseUrl: string;
  /** Effort level for providers that take one (see EFFORTS); blank = the model's own default. */
  effort: "" | Effort;
}

/** A voice preset (src/shared/voices.ts), or the user's own instruction. */
export interface VoiceChoice {
  voice: VoiceId;
  /** The instruction used when voice is "custom". */
  customVoice: string;
}

/** Transcript turn layouts, as in Transcriptor 1's Speaker Format menu. */
export const SPEAKER_FORMATS = [
  { id: "stacked", label: "Name Above Text" },
  { id: "inline", label: "Name: Text" },
  { id: "dash", label: "Name — Text" },
  { id: "caps", label: "NAME: Text" },
  { id: "timeAfter", label: "Name [Time]: Text" },
] as const;

export type SpeakerFormat = (typeof SPEAKER_FORMATS)[number]["id"];

export interface EpisodeColors {
  /** Just added, through transcription and review. */
  fresh: string;
  /** Reviewed and ready for (or being written into) show notes. */
  reviewed: string;
  /** Show notes are ready. */
  notesReady: string;
}

/** Dark yellow, dark orange, dark green. */
export const DEFAULT_EPISODE_COLORS: EpisodeColors = { fresh: "#a16207", reviewed: "#c2410c", notesReady: "#15803d" };

export const THEMES = [
  { id: "system", label: "Match system" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
] as const;

export type Theme = (typeof THEMES)[number]["id"];

export const WINDOW_STARTS = [
  { id: "normal", label: "Normal" },
  { id: "maximized", label: "Maximized" },
  { id: "fullscreen", label: "Full screen" },
] as const;

export type StartWindow = (typeof WINDOW_STARTS)[number]["id"];

/** Keys holding a "#rrggbb" colour: the episode stages and the video colours. */
const COLOR_KEYS = new Set([...Object.keys(DEFAULT_EPISODE_COLORS), "background", "text", "highlight"]);

/** An imported logo's file name (see src/main/logo.ts), so settings can't point anywhere else. */
export const LOGO_FILE = /^logo-\d+\.png$/;

/** String settings that only accept certain values; anything else keeps the default. */
const ALLOWED: Record<string, readonly string[]> = {
  intake: ["approve", "auto"],
  speakerFormat: SPEAKER_FORMATS.map((f) => f.id),
  theme: THEMES.map((t) => t.id),
  startWindow: WINDOW_STARTS.map((w) => w.id),
  voice: VOICE_IDS,
  effort: ["", ...EFFORTS],
  captionStyle: CAPTION_STYLES.map((s) => s.id),
  waveformStyle: WAVEFORM_STYLES.map((s) => s.id),
  font: VIDEO_FONTS.map((f) => f.id),
  captionSize: CAPTION_SIZES.map((s) => s.id),
  backgroundType: BACKGROUND_TYPES,
};

export interface ShowProfile {
  name: string;
  /** Host names, used for show notes and for naming speakers. */
  hosts: string[];
  website: string;
  email: string;
  signOff: string;
}

export const DEFAULT_SETTINGS: Settings = {
  general: {
    startAtLogin: true,
    closeToTray: true,
    theme: "system",
    episodeColors: { ...DEFAULT_EPISODE_COLORS },
    startWindow: "normal",
  },
  processing: {
    intake: "approve",
    reviewStep: true,
    removeFalseStarts: false,
  },
  output: {
    folder: "",
    formats: { docx: true, txt: false, pdf: false, googleDoc: false },
    autoExport: true,
    transcriptTimestamps: true,
    speakerFormat: "stacked",
    colorConfidence: true,
    branding: {
      coverPage: false,
      logo: "",
      logoInHeader: true,
      headerText: "",
      footerText: "",
      pageNumbers: false,
    },
  },
  confidence: { ...DEFAULT_CONFIDENCE_THRESHOLDS },
  watch: { enabled: false, folderId: "" },
  folderWatch: { enabled: false, folder: "", settleMinutes: 1 },
  show: {
    name: "",
    hosts: [],
    website: "",
    email: "",
    signOff: "",
  },
  writing: { provider: "anthropic", model: "", baseUrl: "", effort: "", voice: "general", customVoice: "" },
  social: {
    // Off until turned on: it's an extra paid model call per episode.
    enabled: false,
    // Blank = Claude Sonnet 5.5 (SOCIAL_DEFAULT_MODELS), at medium effort.
    provider: "anthropic",
    model: "",
    baseUrl: "",
    effort: "medium",
    voice: "general",
    customVoice: "",
    minClips: 3,
    maxClips: 5,
    minSeconds: 15,
    maxSeconds: 60,
    oneSpeaker: false,
    platforms: { instagram: true, x: true, linkedin: true, youtube: true },
  },
  video: {
    // Off until turned on: rendering takes a while.
    enabled: false,
    shapes: { vertical: true, square: false, wide: false },
    captionStyle: "highlight",
    font: "inter",
    captionSize: "medium",
    colors: { background: "#14213d", text: "#ffffff", highlight: "#fca311" },
    backgroundType: "color",
    backgroundImage: "",
    showLogo: true,
    showShowName: true,
    showSpeakers: true,
    waveform: true,
    waveformStyle: "pulse",
    motion: { hook: true, pop: true, glow: true, progress: true, outro: true },
  },
  template: "full",
  customSections: [],
};

/** Deep partial, used for patches sent from the renderer. */
export interface Branding {
  /** A first page with the logo, show name, document, episode and date. */
  coverPage: boolean;
  /** File name of the imported logo in userData/branding (a PNG); empty = none. */
  logo: string;
  /** Also put the logo, small, at the top left of every page after the cover. */
  logoInHeader: boolean;
  headerText: string;
  footerText: string;
  /** "Page 2 of 5" at the bottom right. */
  pageNumbers: boolean;
}

export type SettingsPatch = {
  [K in keyof Settings]?: Settings[K] extends unknown[]
    ? Settings[K]
    : Settings[K] extends object
      ? Partial<Settings[K]>
      : Settings[K];
};

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Overlay `patch` onto `base`, keeping only keys `base` knows about and only
 * values whose type matches the base. This is how a settings file from an
 * older or newer build (or a hand-edited one) is read safely: unknown keys
 * are dropped, wrong types fall back to the default.
 */
export function mergeSettings<T>(base: T, patch: unknown): T {
  if (!isObject(base) || !isObject(patch)) return base;
  const out: Json = { ...base };
  for (const key of Object.keys(base)) {
    const b = (base as Json)[key];
    const p = patch[key];
    if (p === undefined) continue;
    if (isObject(b)) out[key] = mergeSettings(b, p);
    else if (Array.isArray(b)) {
      if (Array.isArray(p) && p.every((x) => typeof x === "string")) out[key] = [...p];
    } else if (typeof p === typeof b) {
      if (ALLOWED[key] && !ALLOWED[key].includes(p as string)) continue;
      if (COLOR_KEYS.has(key) && !/^#[0-9a-f]{6}$/i.test(p as string)) continue;
      if (key === "logo" && p !== "" && !LOGO_FILE.test(p as string)) continue;
      if (key === "backgroundImage" && p !== "" && !BACKGROUND_FILE.test(p as string)) continue;
      out[key] = p;
    }
  }
  return out as T;
}
