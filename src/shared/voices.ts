// Show-notes voice presets. The chosen one is added to the writing
// instructions after the accuracy rules, so a voice changes how the notes
// read, never what they're allowed to say: quotes stay word for word and
// nothing outside the transcript and confirmed facts is added.

export const VOICES = {
  general: {
    label: "General",
    description: "Warm and clear, for any listener.",
    prompt: `Write for a general audience in a warm, clear, conversational voice. Use plain language and short sentences. Avoid jargon; if the guests use a specialist term that matters, keep it and explain it briefly in the words they used. Make the summary and takeaways easy to skim and inviting to someone who hasn't heard the show.`,
  },
  industry: {
    label: "Industry",
    description: "For listeners who work in the field.",
    prompt: `Write for listeners who work in the show's industry. Use the field's terminology the way practitioners do, as it's used in the conversation, and don't explain basic terms. Favor specifics over generalities: the methods, tools, numbers and examples actually given in the episode. Keep the tone professional and direct, and frame takeaways as things a practitioner could apply at work.`,
  },
  seo: {
    label: "SEO",
    description: "Written to be found in search and podcast apps.",
    prompt: `Write so the notes are easy to find in search engines and podcast apps. Put the guest's name and the episode's main topic in the title suggestion (keep it under 60 characters) and in the first sentence of the summary. Use the specific phrases a listener would search for, taken from the conversation itself, naturally in the summary, topic titles and takeaways. Make the reference keywords the terms someone would type into a search box. Never repeat keywords unnaturally or add topics the episode doesn't cover.`,
  },
  custom: {
    label: "Custom",
    description: "Your own instruction.",
    /** Comes from Settings (writing.customVoice). */
    prompt: "",
  },
} as const;

/** Longest custom voice instruction accepted. */
export const CUSTOM_VOICE_MAX = 2000;

/** The instruction for a voice; an empty custom one falls back to General. */
export function voicePrompt(voice: VoiceId, custom: string): string {
  if (voice !== "custom") return VOICES[voice].prompt;
  const text = custom.trim().slice(0, CUSTOM_VOICE_MAX);
  return text || VOICES.general.prompt;
}

/**
 * The same presets for social captions. Added after the social rules the same
 * way: a voice changes how a caption reads, never what it may claim.
 */
export const SOCIAL_VOICES: Record<Exclude<VoiceId, "custom">, { description: string; prompt: string }> = {
  general: {
    description: "Warm and clear, for any listener.",
    prompt: `Write captions for a general audience in a warm, clear, conversational voice. Open with the most interesting idea in the clip, in plain words, so someone scrolling past wants to hear it. Avoid jargon; keep a specialist term only if the guest uses it and it matters.`,
  },
  industry: {
    description: "For people who work in the field.",
    prompt: `Write captions for people who work in the show's field. Use the field's terms the way the guests use them, without explaining basics. Open with the specific insight, method or number in the clip, and keep the tone professional and direct.`,
  },
  seo: {
    description: "Written to be found in each platform's search.",
    prompt: `Write captions that are easy to find in each platform's search. Put the guest's name and the clip's main topic near the start, use the phrases a listener would search for, taken from the conversation itself, and choose hashtags from those phrases. Never repeat keywords unnaturally or add topics the clip doesn't cover.`,
  },
};

/** The caption instruction for a voice; an empty custom one falls back to General. */
export function socialVoicePrompt(voice: VoiceId, custom: string): string {
  if (voice !== "custom") return SOCIAL_VOICES[voice].prompt;
  const text = custom.trim().slice(0, CUSTOM_VOICE_MAX);
  return text || SOCIAL_VOICES.general.prompt;
}

export type VoiceId = keyof typeof VOICES;
export const VOICE_IDS = Object.keys(VOICES) as VoiceId[];
export const isVoiceId = (s: string): s is VoiceId => s in VOICES;
