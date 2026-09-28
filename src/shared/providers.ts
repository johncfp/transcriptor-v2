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
  {
    id: "openai-transcribe",
    role: "transcription",
    label: "OpenAI transcription",
    company: "OpenAI",
    keyUrl: "https://platform.openai.com/api-keys",
    sends: "the episode audio file",
  },
  {
    id: "anthropic",
    role: "writing",
    label: "Claude",
    company: "Anthropic",
    keyUrl: "https://console.anthropic.com/settings/keys",
    sends: "the full transcript and your show details",
  },
  {
    id: "openai",
    role: "writing",
    label: "GPT",
    company: "OpenAI",
    keyUrl: "https://platform.openai.com/api-keys",
    sends: "the full transcript and your show details",
  },
  {
    id: "moonshot",
    role: "writing",
    label: "Kimi",
    company: "Moonshot AI",
    keyUrl: "https://platform.moonshot.ai/console/api-keys",
    sends: "the full transcript and your show details",
  },
  {
    id: "qwen",
    role: "writing",
    label: "Qwen",
    company: "Alibaba Cloud (Model Studio)",
    keyUrl: "https://modelstudio.console.alibabacloud.com/",
    sends: "the full transcript and your show details",
  },
];

export const providerById = (id: string): ProviderInfo | undefined =>
  PROVIDERS.find((p) => p.id === id);
