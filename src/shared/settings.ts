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
    formats: { docx: boolean; txt: boolean; googleDoc: boolean };
  };
  show: ShowProfile;
  /** Show-notes template id; see src/shared/templates.ts (added in M3). */
  template: string;
}

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
  },
  processing: {
    intake: "approve",
    reviewStep: true,
    removeFalseStarts: false,
  },
  output: {
    folder: "",
    formats: { docx: true, txt: false, googleDoc: false },
  },
  show: {
    name: "",
    hosts: [],
    website: "",
    email: "",
    signOff: "",
  },
  template: "full",
};

/** Deep partial, used for patches sent from the renderer. */
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
      if (key === "intake" && p !== "approve" && p !== "auto") continue;
      out[key] = p;
    }
  }
  return out as T;
}
