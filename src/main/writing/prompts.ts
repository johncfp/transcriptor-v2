// Prompts and schemas shared by every writing provider. The model is told the
// rules here; src/shared/verify.ts checks them afterwards.

import type { SourcedFact } from "../../shared/showNotes";
import type { JsonFormat } from "./types";
import { voicePrompt, type VoiceId } from "../../shared/voices";

export const RESEARCH_SYSTEM = `You confirm facts about podcast guests so their show notes are accurate.

Search the web for the guest named below. Use the transcript excerpt to make sure you have the right person: their job, company, podcast, books, or location should match what they say on the show.

Record only facts you found on a page during this search, each with that page's URL. Prefer the guest's own website, official profiles, and reputable publications. Links should be the guest's own website, podcast, newsletter, and social profiles, and only URLs you actually saw in the results.

If the name is common and you can't tell which person matches the transcript, set identified to false and record no facts or links. Never guess.`;

export const RESEARCH_TOOL = {
  name: "record_guest_research",
  description: "Record what the web search confirmed about the guest. Call this once, when you are done searching.",
  input_schema: {
    type: "object" as const,
    properties: {
      identified: { type: "boolean", description: "True only if you're confident these results are about this guest." },
      facts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            fact: { type: "string" },
            source_urls: { type: "array", items: { type: "string" } },
          },
          required: ["fact", "source_urls"],
          additionalProperties: false,
        },
      },
      links: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: 'e.g. "Website", "Podcast", "Instagram"' },
            url: { type: "string" },
          },
          required: ["label", "url"],
          additionalProperties: false,
        },
      },
    },
    required: ["identified", "facts", "links"],
    additionalProperties: false,
  },
};

export function researchPrompt(guest: string, showName: string, excerpt: string): string {
  return [
    `Guest: ${guest}`,
    showName && `Podcast: ${showName}`,
    "",
    "Transcript excerpt, for context:",
    excerpt,
  ]
    .filter((l): l is string => typeof l === "string" && l !== "")
    .join("\n");
}

export const WRITING_SYSTEM = `You write podcast show notes and a reference file from an episode transcript.

Use only what is in the transcript and in the confirmed guest facts provided. Never add facts, numbers, names, titles, links or claims that aren't there. If something isn't covered, leave it out: use an empty string or an empty list rather than filling the gap.

- title_suggestion: short and specific, in the style "<Theme> with <Guest>".
- summary: one paragraph, 3 to 5 sentences, third person, naming the host and guest.
- about_guest: 2 to 4 sentences built from what the guest and host say about the guest, plus any confirmed facts. Empty if there's no guest.
- timestamps: 6 to 12 segments covering the whole episode in order. Each time must be a [mm:ss] marker that appears in the transcript where that segment starts.
- topics: 3 to 6, each with 2 to 4 short points.
- quotes: 3 to 5 lines worth repeating. Copy each one exactly, word for word, from a single turn of the transcript: no fixing grammar, no joining separate passages, no ellipses. One to three sentences each.
- rapid_fire: only if the conversation actually has a rapid-fire or quick-questions round; otherwise an empty list.
- takeaways: 3 to 6 practical lines a listener can act on.
- resources: only books, tools, websites, episodes or organizations mentioned by name in the conversation.
- reference: for reusing this episode in courses and classes later.
  - topics: short labels for everything substantial that was discussed.
  - keywords: at most 5.
  - high_notes: the most important insights, each a standalone statement.
  - quotes: 3 to 8, with the same exact-copy rule as above.
  - frameworks: named methods, models, systems or concepts explained in the episode, each with a one-sentence description in the speaker's own terms.`;

const stringArray = { type: "array", items: { type: "string" } };
const quoteArray = {
  type: "array",
  items: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
};

/** JSON schema for the draft (see WritingDraft in src/shared/verify.ts). */
export const WRITING_SCHEMA = {
  type: "object",
  properties: {
    title_suggestion: { type: "string" },
    summary: { type: "string" },
    about_guest: { type: "string" },
    timestamps: {
      type: "array",
      items: {
        type: "object",
        properties: { time: { type: "string", description: "mm:ss or h:mm:ss" }, label: { type: "string" } },
        required: ["time", "label"],
        additionalProperties: false,
      },
    },
    topics: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, points: stringArray },
        required: ["title", "points"],
        additionalProperties: false,
      },
    },
    quotes: quoteArray,
    rapid_fire: {
      type: "array",
      items: {
        type: "object",
        properties: { question: { type: "string" }, answer: { type: "string" } },
        required: ["question", "answer"],
        additionalProperties: false,
      },
    },
    takeaways: stringArray,
    resources: stringArray,
    reference: {
      type: "object",
      properties: {
        topics: stringArray,
        keywords: stringArray,
        high_notes: stringArray,
        quotes: quoteArray,
        frameworks: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, description: { type: "string" } },
            required: ["name", "description"],
            additionalProperties: false,
          },
        },
      },
      required: ["topics", "keywords", "high_notes", "quotes", "frameworks"],
      additionalProperties: false,
    },
  },
  required: [
    "title_suggestion", "summary", "about_guest", "timestamps", "topics", "quotes",
    "rapid_fire", "takeaways", "resources", "reference",
  ],
  additionalProperties: false,
};

export function writingPrompt(input: {
  showName: string;
  hosts: string[];
  guest: string | null;
  facts: SourcedFact[];
  transcript: string;
}): string {
  const facts = input.facts.length
    ? input.facts.map((f) => `- ${f.fact}`).join("\n")
    : "(none)";
  return [
    input.showName && `Podcast: ${input.showName}`,
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

/**
 * The writing instructions with the chosen voice added last. The voice
 * shapes tone and emphasis; the rules above it still apply.
 */
export function writingSystem(voice: VoiceId, customVoice = ""): string {
  return `${WRITING_SYSTEM}

Voice (how the notes should read; the rules above still apply):
${voicePrompt(voice, customVoice)}`;
}

export const NOTES_FORMAT: JsonFormat = { name: "show_notes", schema: WRITING_SCHEMA, what: "show notes" };

/** For providers without schema enforcement: the shape, spelled out in the prompt. */
export const jsonInstruction = (schema: object) =>
  `Reply with a single JSON object and nothing else, matching this JSON schema:\n${JSON.stringify(schema)}`;
