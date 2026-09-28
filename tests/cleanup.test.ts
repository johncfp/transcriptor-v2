import assert from "node:assert/strict";
import { test } from "node:test";
import {
  autoRemovals,
  cleanTranscript,
  defaultEdits,
  isDeletionOnly,
  reviewTurns,
  toggleRemoved,
  type EpisodeEdits,
} from "../src/shared/cleanup";
import { suggestSpeakers } from "../src/shared/speakerNames";
import type { Transcript, Word } from "../src/shared/transcript";

/** Build words from "A: text | B: text" turns; each word gets 0.5 s. */
function words(script: string): Word[] {
  const out: Word[] = [];
  for (const part of script.split("|")) {
    const [who, text] = part.split(/:(.*)/s).map((s) => s.trim());
    const speaker = who!.charCodeAt(0) - 65;
    for (const t of text!.split(/\s+/).filter(Boolean)) {
      out.push({ text: t, start: out.length * 0.5, end: out.length * 0.5 + 0.4, speaker });
    }
  }
  return out;
}

function transcriptOf(script: string): Transcript {
  const w = words(script);
  return {
    version: 1,
    provider: "test",
    model: "test",
    speakerCount: Math.max(...w.map((x) => x.speaker)) + 1,
    words: w,
    createdAt: "",
  };
}

const text = (t: Transcript, edits: Partial<EpisodeEdits> = {}) =>
  cleanTranscript(t, { ...defaultEdits({ repetitions: true }, t.speakerCount), ...edits })
    .map((turn) => `${turn.speaker}: ${turn.words.map((w) => w.text).join(" ")}`)
    .join(" | ");

test("fillers are always removed, other words never", () => {
  const w = words("A: Um, so, uh, I think, like, you know, it's good. Mhm. Uh-huh.");
  const removed = autoRemovals(w, { repetitions: false });
  assert.deepEqual(
    [...removed.keys()].map((i) => w[i]!.text),
    ["Um,", "uh,"],
  );
});

test("repetitions: stutters and repeated phrases, keeping the last copy", () => {
  const t = transcriptOf("A: I I think the the thing is, I think I think we should go.");
  assert.equal(text(t), "Speaker 1: I think the thing is, I think we should go.");
});

test("repetitions: deliberate doubles and sentence breaks are kept", () => {
  const t = transcriptOf("A: I know that that works. It was very very good. No. No, I didn't.");
  assert.equal(text(t), "Speaker 1: I know that that works. It was very very good. No. No, I didn't.");
});

test("repetitions: a filler between the copies doesn't hide them", () => {
  const t = transcriptOf("A: We, um, we went home.");
  assert.equal(text(t), "Speaker 1: We went home.");
});

test("repetitions and fragments are off unless enabled", () => {
  const t = transcriptOf("A: I I went th- there.");
  const edits = defaultEdits({ repetitions: false }, 1);
  assert.equal(text(t, edits), "Speaker 1: I I went th- there.");
  assert.equal(text(t), "Speaker 1: I went there.");
});

test("repeats across speakers are not merged", () => {
  const t = transcriptOf("A: Right | B: Right, exactly.");
  assert.equal(text(t), "Speaker 1: Right | Speaker 2: Right, exactly.");
});

test("a removed sentence opener capitalizes the next word", () => {
  const t = transcriptOf("A: That's great. Um, so we started. | B: Uh, yes.");
  assert.equal(text(t), "Speaker 1: That's great. So we started. | Speaker 2: Yes.");
});

test("a removed filler's sentence end moves to the previous word", () => {
  const t = transcriptOf("A: And we left, um. Then");
  assert.equal(text(t), "Speaker 1: And we left. Then");
});

test("manual removals, restores, spelling fixes and names", () => {
  const t = transcriptOf("A: Um, welcome Pete Emm. | B: Thanks, um, Nigel.");
  const out = text(t, {
    removed: [3], // "Emm."
    restored: [5], // the second "um," back
    text: { 2: "Pete M." },
    speakerNames: ["Nigel T.", null],
    suggestedNames: [null, { name: "Pete M.", role: "guest", because: "" }],
  });
  assert.equal(out, "Nigel T.: Welcome Pete M. | Pete M.: Thanks, um, Nigel.");
});

test("giving two speakers the same name merges their turns", () => {
  const t = transcriptOf("A: Hello there | B: and more | A: done");
  assert.equal(text(t, { speakerNames: ["Pete", "Pete"] }), "Pete: Hello there and more done");
});

test("deletion-only check", () => {
  const orig = "I was, we went to the store".split(" ");
  assert.equal(isDeletionOnly(orig, "We went to the store.".split(" ")), true);
  assert.equal(isDeletionOnly(orig, "We walked to the store".split(" ")), false, "changed a word");
  assert.equal(isDeletionOnly(orig, "went we to the store".split(" ")), false, "reordered");
  assert.equal(isDeletionOnly(orig, "I was, we went to the big store".split(" ")), false, "added a word");
});

test("speaker suggestions: host self-intro and guest intro", () => {
  const w = words(
    "B: Hey everyone, I'm Nigel and this is This Is A Test Show. Welcome to the show, Pete M. | A: Thanks for having me.",
  );
  const s = suggestSpeakers(w, 2, ["Nigel T."]);
  assert.equal(s[1]?.name, "Nigel T.");
  assert.equal(s[1]?.role, "host");
  assert.equal(s[0]?.name, "Pete M.");
  assert.equal(s[0]?.role, "guest");
});

test("speaker suggestions: one host, no self-intro, falls back to who speaks first", () => {
  const w = words("A: Today my guest is Pete. | B: Glad to be here.");
  const s = suggestSpeakers(w, 2, ["Nigel T."]);
  assert.equal(s[0]?.name, "Nigel T.");
  assert.equal(s[0]?.because, "speaks first");
  assert.equal(s[1]?.name, "Pete");
});

test("speaker suggestions: no host names and no evidence means no guesses", () => {
  const w = words("A: Hello. | B: Hi.");
  assert.deepEqual(suggestSpeakers(w, 2, []), [null, null]);
});

test("speaker suggestions: 'welcome back everyone' is not a name", () => {
  const w = words("A: I'm Nigel. Welcome back everyone. | B: Hi.");
  const s = suggestSpeakers(w, 2, ["Nigel T."]);
  assert.equal(s[1], null);
});

test("toggleRemoved removes and restores both manual and automatic removals", () => {
  const t = transcriptOf("A: Um, hello there.");
  let edits = defaultEdits({ repetitions: false }, 1);
  edits = toggleRemoved(t, edits, 0); // put back the automatic "Um,"
  assert.equal(text(t, edits), "Speaker 1: Um, hello there.");
  edits = toggleRemoved(t, edits, 0); // and remove it again
  assert.equal(text(t, edits), "Speaker 1: Hello there.");
  edits = toggleRemoved(t, edits, 2); // remove "there." by hand
  assert.equal(text(t, edits), "Speaker 1: Hello");
  edits = toggleRemoved(t, edits, 2);
  assert.equal(text(t, edits), "Speaker 1: Hello there.");
  assert.deepEqual([edits.removed, edits.restored], [[], []]);
});

test("reviewTurns shows removed words only when asked, with cleaned text for kept ones", () => {
  const t = transcriptOf("A: Um, so we went.");
  const edits = defaultEdits({ repetitions: false }, 1);
  const hidden = reviewTurns(t, edits, false)[0]!.words.map((w) => w.text);
  assert.deepEqual(hidden, ["So", "we", "went."]);
  const shown = reviewTurns(t, edits, true)[0]!.words;
  assert.deepEqual(
    shown.map((w) => [w.text, w.removed ?? ""]),
    [["Um,", "filler"], ["So", ""], ["we", ""], ["went.", ""]],
  );
});
