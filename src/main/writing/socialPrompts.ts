// Prompt and schema for the social clips step. The model is told the rules
// here; src/shared/clips.ts checks them afterwards.

import type { SourcedFact } from "../../shared/showNotes";
import { PLATFORMS, type ClipLimits, type PlatformId } from "../../shared/social";
import { socialVoicePrompt, type VoiceId } from "../../shared/voices";

export function socialRules(limits: ClipLimits, platforms: PlatformId[], oneSpeaker = false): string {
  const chosen = PLATFORMS.filter((p) => platforms.includes(p.id));
  return `You pick short moments from a podcast episode to post on social media, and write a caption for each.

Choose ${limits.minClips} to ${limits.maxClips} clips, each ${limits.minSeconds} to ${limits.maxSeconds} seconds long. A good clip makes sense on its own to someone who hasn't heard the episode: a clear point, a short story, a surprising answer, a strong opinion, or a useful tip. Skip ads, housekeeping, intros and goodbyes. Clips must not overlap. Fewer strong clips are better than filling the count with weak ones.

The transcript has [mm:ss] markers; use them to judge each clip's length. ${
    oneSpeaker
      ? `Each clip must be one person talking: choose stretches where nobody else speaks, not even a short "yeah" or "right".`
      : "A clip can include more than one speaker."
  }

For each clip:
- first_words: the clip's first 6 to 10 words, copied exactly from the transcript, starting at the beginning of a sentence.
- last_words: the clip's last 6 to 10 words, copied exactly from the transcript, ending at the end of a sentence.
- title: a short hook, under 70 characters. It's also the YouTube Shorts title.
- why: one sentence on why this moment works as a clip.
- captions: one for each platform below.

Captions use only what's said in the episode and the confirmed guest facts provided. Never add facts, numbers, names, titles, links or claims that aren't there. Only put words in quotation marks if they're exactly what was said in the clip. Hashtags go in the hashtags list, without the # sign, never in the text; take them from the clip's topic.

Platforms:
${chosen.map((p) => `- ${p.id} (${p.label}): ${p.guide}`).join("\n")}`;
}

/** The rules with the chosen voice added last; the voice shapes tone, the rules still apply. */
export function socialSystem(limits: ClipLimits, platforms: PlatformId[], voice: VoiceId, customVoice = "", oneSpeaker = false): string {
  return `${socialRules(limits, platforms, oneSpeaker)}

Voice (how the captions should read; the rules above still apply):
${socialVoicePrompt(voice, customVoice)}`;
}

const caption = {
  type: "object",
  properties: { text: { type: "string" }, hashtags: { type: "array", items: { type: "string" } } },
  required: ["text", "hashtags"],
  additionalProperties: false,
};

/** JSON schema for the clips, with a caption field for each chosen platform (see ClipDraft). */
export function socialSchema(platforms: PlatformId[]) {
  const ids = PLATFORMS.map((p) => p.id).filter((id) => platforms.includes(id));
  return {
    type: "object",
    properties: {
      clips: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            why: { type: "string" },
            first_words: { type: "string" },
            last_words: { type: "string" },
            captions: {
              type: "object",
              properties: Object.fromEntries(ids.map((id) => [id, caption])),
              required: ids,
              additionalProperties: false,
            },
          },
          required: ["title", "why", "first_words", "last_words", "captions"],
          additionalProperties: false,
        },
      },
    },
    required: ["clips"],
    additionalProperties: false,
  };
}

export function socialPrompt(input: {
  showName: string;
  website: string;
  hosts: string[];
  guest: string | null;
  facts: SourcedFact[];
  transcript: string;
}): string {
  const facts = input.facts.length ? input.facts.map((f) => `- ${f.fact}`).join("\n") : "(none)";
  return [
    input.showName && `Podcast: ${input.showName}`,
    input.website && `Show website: ${input.website}`,
    `Host${input.hosts.length === 1 ? "" : "s"}: ${input.hosts.join(", ") || "unknown"}`,
    `Guest: ${input.guest ?? "none identified"}`,
    "",
    "Confirmed guest facts (from web sources):",
    facts,
    "",
    "Transcript:",
    input.transcript,
  ]
    .filter((l): l is string => typeof l === "string")
    .join("\n");
}
