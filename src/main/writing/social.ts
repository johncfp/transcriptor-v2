import { cleanTranscript, type EpisodeEdits } from "../../shared/cleanup";
import { checkClips, coerceClips, rawSpeakerNames, type SocialResult } from "../../shared/clips";
import type { WritingResult } from "../../shared/showNotes";
import type { ClipLimits, PlatformId } from "../../shared/social";
import type { Transcript } from "../../shared/transcript";
import { confirmedFacts, transcriptForPrompt } from "../../shared/verify";
import type { VoiceId } from "../../shared/voices";
import { castOf } from "./index";
import { socialPrompt, socialSchema, socialSystem } from "./socialPrompts";
import type { ProviderCall, WritingProvider } from "./types";

export interface SuggestClipsInput {
  transcript: Transcript;
  edits: EpisodeEdits;
  /** The episode's show notes, for the cast and the confirmed guest facts; null if there are none. */
  writing: WritingResult | null;
  show: { name: string; hosts: string[]; website: string };
  limits: ClipLimits;
  platforms: PlatformId[];
  /** Only clips where one person talks (Settings > Social clips). */
  oneSpeaker?: boolean;
  voice: VoiceId;
  customVoice?: string;
  writer: WritingProvider;
  call: ProviderCall;
  onStage?: (stage: string) => void;
}

/** Time markers every 15 seconds, so the model can judge clip lengths. */
const MARKER_EVERY_SEC = 15;

export async function suggestClips(input: SuggestClipsInput): Promise<SocialResult> {
  const { transcript, edits, writing, writer, call } = input;
  const turns = cleanTranscript(transcript, edits);
  const cast = writing ? { hosts: writing.host, guest: writing.guest } : castOf(transcript, edits, input.show.hosts);
  const facts = confirmedFacts(writing?.research ?? null);

  input.onStage?.("Picking social clips");
  const raw = await writer.draft(
    call,
    {
      system: socialSystem(input.limits, input.platforms, input.voice, input.customVoice, input.oneSpeaker),
      user: socialPrompt({
        showName: input.show.name,
        website: input.show.website,
        hosts: cast.hosts,
        guest: cast.guest,
        facts,
        transcript: transcriptForPrompt(turns, MARKER_EVERY_SEC),
      }),
    },
    { name: "social_clips", schema: socialSchema(input.platforms), what: "social clips" },
  );

  input.onStage?.("Checking clips against the transcript");
  const { clips, checks } = checkClips(coerceClips(raw), turns, {
    limits: input.limits,
    platforms: input.platforms,
    rawWords: transcript.words,
    rawSpeakers: rawSpeakerNames(transcript, edits),
    oneSpeaker: input.oneSpeaker,
    durationSec: transcript.durationSec ?? transcript.words.at(-1)?.end ?? 0,
    facts: facts.map((f) => f.fact),
    allowedUrls: [input.show.website, ...(writing?.research?.links.map((l) => l.url) ?? [])].filter(Boolean),
  });
  return {
    version: 1,
    provider: writer.id,
    model: call.model,
    ...(call.effort ? { effort: call.effort } : {}),
    voice: input.voice,
    generatedAt: new Date().toISOString(),
    clips,
    checks,
  };
}
