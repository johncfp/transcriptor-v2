import { cleanTranscript, speakerName, type EpisodeEdits } from "../../shared/cleanup";
import type { EpisodeDetails, WritingResult } from "../../shared/showNotes";
import type { Transcript } from "../../shared/transcript";
import {
  checkDraft,
  coerceDraft,
  confirmedFacts,
  transcriptForPrompt,
  verifyResearch,
  type RawResearch,
} from "../../shared/verify";
import { anthropicWriter } from "./anthropic";
import { kimiWriter, openaiWriter, qwenWriter } from "./openai";
import { RESEARCH_SYSTEM, researchPrompt, WRITING_SYSTEM, writingPrompt } from "./prompts";
import type { ProviderCall, WritingProvider } from "./types";

export const WRITERS: WritingProvider[] = [anthropicWriter, openaiWriter, kimiWriter, qwenWriter];
export const writerById = (id: string) => WRITERS.find((w) => w.id === id);

export interface WriteEpisodeInput {
  transcript: Transcript;
  edits: EpisodeEdits;
  details: EpisodeDetails;
  show: { name: string; hosts: string[] };
  writer: WritingProvider;
  call: ProviderCall;
  onStage?: (stage: string) => void;
}

const isPlaceholder = (name: string) => /^Speaker \d+$/.test(name);

/**
 * Work out who hosts and who's the guest from the review names: a speaker is
 * a host if their name is one of the show's host names, or they were
 * suggested as host and not renamed. The guest is whoever else talks most.
 */
export function castOf(transcript: Transcript, edits: EpisodeEdits, hostNames: string[]): { hosts: string[]; guest: string | null } {
  const lowerHosts = new Set(hostNames.map((h) => h.trim().toLowerCase()));
  const words = new Map<string, number>();
  const hosts = new Set<string>();
  for (let s = 0; s < transcript.speakerCount; s++) {
    const name = speakerName(edits, s);
    const count = transcript.words.filter((w) => w.speaker === s).length;
    words.set(name, (words.get(name) ?? 0) + count);
    const suggestedHost = edits.speakerNames[s] == null && edits.suggestedNames[s]?.role === "host";
    if (lowerHosts.has(name.toLowerCase()) || suggestedHost) hosts.add(name);
  }
  const guests = [...words]
    .filter(([name]) => !hosts.has(name) && !isPlaceholder(name))
    .sort((a, b) => b[1] - a[1]);
  return { hosts: [...hosts], guest: guests[0]?.[0] ?? null };
}

/** The first stretch of the conversation, which is where guests get introduced. */
function introExcerpt(transcript: string, maxWords = 700): string {
  const words = transcript.split(/\s+/);
  return words.length <= maxWords ? transcript : `${words.slice(0, maxWords).join(" ")} …`;
}

function coerceResearch(value: RawResearch): RawResearch {
  const v = (value ?? {}) as Partial<RawResearch>;
  return {
    identified: v.identified === true,
    facts: Array.isArray(v.facts)
      ? v.facts.map((f) => ({
          fact: typeof f?.fact === "string" ? f.fact : "",
          source_urls: Array.isArray(f?.source_urls) ? f.source_urls.filter((u): u is string => typeof u === "string") : [],
        }))
      : [],
    links: Array.isArray(v.links)
      ? v.links.map((l) => ({ label: typeof l?.label === "string" ? l.label : "", url: typeof l?.url === "string" ? l.url : "" }))
      : [],
    searchedUrls: Array.isArray(v.searchedUrls) ? v.searchedUrls : null,
  };
}

export async function writeEpisode(input: WriteEpisodeInput): Promise<WritingResult> {
  const { transcript, edits, writer, call } = input;
  const turns = cleanTranscript(transcript, edits);
  const text = transcriptForPrompt(turns);
  const { hosts, guest } = castOf(transcript, edits, input.show.hosts);
  const runtimeSec = transcript.durationSec ?? transcript.words.at(-1)?.end ?? 0;

  let research = null;
  let linksDropped = 0;
  if (guest) {
    input.onStage?.(`Looking up ${guest}`);
    const raw = await writer.research(call, {
      system: RESEARCH_SYSTEM,
      user: researchPrompt(guest, input.show.name, introExcerpt(text)),
    });
    ({ research, linksDropped } = verifyResearch(guest, coerceResearch(raw)));
  }

  input.onStage?.("Writing show notes");
  const draft = coerceDraft(
    await writer.draft(call, {
      system: WRITING_SYSTEM,
      user: writingPrompt({ showName: input.show.name, hosts, guest, facts: confirmedFacts(research), transcript: text }),
    }),
  );

  input.onStage?.("Checking quotes and timestamps");
  const checked = checkDraft(draft, turns, runtimeSec);
  return {
    version: 1,
    provider: writer.id,
    model: call.model,
    generatedAt: new Date().toISOString(),
    details: input.details,
    host: hosts,
    guest,
    runtimeSec,
    notes: checked.notes,
    reference: checked.reference,
    research,
    checks: { ...checked.checks, linksDropped },
  };
}
