// Guess who each diarized speaker is from what's said in the transcript and
// the host names in Settings. Offline and conservative: a speaker with no
// clear evidence gets no suggestion rather than a guess. The AI writing step
// (M3) can refine these later.

import type { SpeakerSuggestion } from "./cleanup";
import { toTurns, type Word } from "./transcript";

const NAME = String.raw`(\p{Lu}[\p{L}'’-]*\.?(?:\s+\p{Lu}[\p{L}'’-]*\.?){0,2})`;

/**
 * Host phrases that name the guest. The phrase is matched in any case, via
 * (?i:…), but the name must be capitalized. A plain /i flag would make
 * \p{Lu} match lowercase letters too.
 */
const GUEST_INTROS = [
  String.raw`(?i:welcome(?: to the (?:show|podcast|program))?),?\s+${NAME}`,
  String.raw`(?i:joining (?:me|us)(?: (?:today|now|this week))?,? (?:is|are))\s+${NAME}`,
  String.raw`(?i:my guest(?: (?:today|this week))? is)\s+${NAME}`,
  String.raw`(?i:please welcome)\s+${NAME}`,
  String.raw`(?i:(?:talking|speaking|sitting down) with)\s+${NAME}`,
].map((p) => new RegExp(p, "u"));

/** Capitalized words that follow those phrases but aren't names. */
const NOT_NAMES = new Set(["back", "everyone", "everybody", "to", "the", "my", "our", "a", "an", "today", "and", "you", "i", "we"]);

const selfIntro = (name: string) =>
  new RegExp(String.raw`\b(?:i'?m|i am|my name is|this is)\s+${escape(name)}\b`, "iu");

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "Pete M." → "Pete M."; drops trailing commas and stray non-name words. */
function cleanName(raw: string): string | null {
  const parts = raw.replace(/[,;:!?]+$/, "").split(/\s+/);
  while (parts.length && NOT_NAMES.has(parts.at(-1)!.toLowerCase().replace(/\.$/, ""))) parts.pop();
  if (!parts.length || NOT_NAMES.has(parts[0]!.toLowerCase())) return null;
  const name = parts.join(" ").replace(/(?<!\b\p{Lu})\.$/u, ""); // keep "M." but drop a sentence-ending period
  return name || null;
}

export function suggestSpeakers(words: Word[], speakerCount: number, hosts: string[]): (SpeakerSuggestion | null)[] {
  const out: (SpeakerSuggestion | null)[] = Array(speakerCount).fill(null);
  if (speakerCount === 0) return out;
  const turns = toTurns(words).map((t) => ({ speaker: t.speaker, text: t.words.map((w) => w.text).join(" ") }));
  const wordCounts = Array(speakerCount).fill(0);
  for (const w of words) wordCounts[w.speaker]++;

  // 1. Hosts who introduce themselves: "I'm Nigel", "this is Nigel T."
  for (const host of hosts) {
    const firstName = host.split(/\s+/)[0]!;
    const turn = turns.find((t) => out[t.speaker] === null && selfIntro(firstName).test(t.text));
    if (turn) out[turn.speaker] = { name: host, role: "host", because: `introduces themselves as ${firstName}` };
  }

  // 2. With one host name that wasn't heard, the first person to speak is usually the host.
  if (hosts.length === 1 && !out.some((s) => s?.role === "host") && speakerCount >= 2) {
    const first = turns[0]!.speaker;
    out[first] = { name: hosts[0]!, role: "host", because: "speaks first" };
  }

  // 3. A guest introduced by a host: "welcome to the show, Pete M."
  const hostSpeakers = new Set(out.flatMap((s, i) => (s?.role === "host" ? [i] : [])));
  if (hostSpeakers.size) {
    for (const turn of turns) {
      if (!hostSpeakers.has(turn.speaker)) continue;
      const name = GUEST_INTROS.map((re) => turn.text.match(re)?.[1]).map((m) => (m ? cleanName(m) : null)).find(Boolean);
      if (!name) continue;
      // The guest is whoever talks most among the speakers that aren't hosts yet.
      const guest = wordCounts
        .map((count, i) => ({ count, i }))
        .filter(({ i }) => out[i] === null)
        .sort((a, b) => b.count - a.count)[0];
      if (guest) out[guest.i] = { name, role: "guest", because: `introduced by the host as ${name}` };
      break;
    }
  }
  return out;
}
