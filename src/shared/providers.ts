// Every third-party service Transcriptor 2 can send data to. The key screen
// is driven entirely by this list; the request code for each provider lands
// in M1 (transcription) and M3 (writing).

export type ProviderRole = "transcription" | "writing";

export interface ProviderInfo {
  id: string;
  role: ProviderRole;
  label: string;
  /** Who receives the data, shown in the third-party notice. */
  company: string;
  /** Where to create an API key. */
  keyUrl: string;
  /** What leaves the computer when this provider is used. */
  sends: string;
  /** Set when the provider is listed but not usable yet, with the reason. */
  unavailable?: string;
  /** Writing providers: the model used when Settings leaves it blank. */
  defaultModel?: string;
  /** Writing providers: takes an effort level (see EFFORTS). */
  effort?: boolean;
}

/**
 * Effort levels, lowest to highest: how much the model thinks before writing.
 * Claude (output_config.effort) and GPT (reasoning.effort) both take these;
 * not every model takes every level.
 */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
export const EFFORT_LABELS: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** A model a writing provider offers, from its live model list. */
export interface ModelOption {
  id: string;
  /** Display name, e.g. "Claude Opus 5.5"; the id when the provider has none. */
  label: string;
  /** Effort levels it takes; null when the provider doesn't say. */
  efforts: Effort[] | null;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "elevenlabs",
    role: "transcription",
    label: "ElevenLabs Scribe",
    company: "ElevenLabs",
    keyUrl: "https://elevenlabs.io/app/settings/api-keys",
    sends: "the episode audio file",
  },
  // OpenAI transcription is switched off for now: its API caps uploads at
  // 25 MB (about 25 minutes of MP3) and can't return speakers together with
  // word timings. Bringing it back would mean splitting or compressing the
  // audio first (bundling ffmpeg).
  // {
  //   id: "openai-transcribe",
  //   role: "transcription",
  //   label: "OpenAI transcription",
  //   company: "OpenAI",
  //   keyUrl: "https://platform.openai.com/api-keys",
  //   sends: "the episode audio file",
  // },
  {
    id: "anthropic",
    role: "writing",
    label: "Claude",
    company: "Anthropic",
    defaultModel: "claude-opus-5-5",
    effort: true,
    keyUrl: "https://console.anthropic.com/settings/keys",
    sends: "the full transcript and your show details",
  },
  {
    id: "openai",
    role: "writing",
    label: "GPT",
    company: "OpenAI",
    defaultModel: "gpt-5.5",
    effort: true,
    keyUrl: "https://platform.openai.com/api-keys",
    sends: "the full transcript and your show details",
  },
  {
    id: "moonshot",
    role: "writing",
    label: "Kimi",
    company: "Moonshot AI",
    defaultModel: "kimi-k3",
    keyUrl: "https://platform.moonshot.ai/console/api-keys",
    sends: "the full transcript and your show details",
  },
  {
    id: "qwen",
    role: "writing",
    label: "Qwen",
    company: "Alibaba Cloud (Model Studio)",
    defaultModel: "qwen-plus",
    keyUrl: "https://modelstudio.console.alibabacloud.com/",
    sends: "the full transcript and your show details",
  },
];

export const providerById = (id: string): ProviderInfo | undefined =>
  PROVIDERS.find((p) => p.id === id);
