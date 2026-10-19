import assert from "node:assert/strict";
import { test } from "node:test";
import type { CleanTurn } from "../src/shared/cleanup";
import { buildCues, cueTime, languageName, splitLines, subtitleFileName, SUBTITLE_LIMITS, toSrt, toVtt } from "../src/shared/subtitles";

/** A turn whose words are spaced `step` seconds apart from `from`, each 0.3 s long. */
function turn(speaker: string, text: string, from = 0, step = 0.4): CleanTurn {
  let t = from;
  return {
    speaker,
    start: from,
    words: text.split(" ").map((w, index) => {
      const word = { index, text: w, start: t, end: t + 0.3 };
      t += step;
      return word;
    }),
  };
}

const text = (lines: string[]) => lines.join(" ");

test("lines: one if it fits, else two balanced ones within the limit, preferring a break after punctuation", () => {
  assert.deepEqual(splitLines("Short and sweet."), ["Short and sweet."]);
  const two = splitLines("So the biggest mistake I see is people chasing every new tool out there");
  assert.equal(two.length, 2);
  assert.ok(two.every((l) => l.length <= SUBTITLE_LIMITS.lineChars));
  assert.equal(text(two), "So the biggest mistake I see is people chasing every new tool out there");
  // A comma almost in the middle wins over the exact middle.
  assert.deepEqual(splitLines("If a tool saves me an hour of work, it costs me the reason I started"), [
    "If a tool saves me an hour of work,",
    "it costs me the reason I started",
  ]);
});

test("cues: every word once, in order; within two lines and seven seconds; never two speakers", () => {
  const turns = [
    turn("Nigel", "Welcome back to the show. Today we talk about focus, habits and the long game with Pete, who has been building tools for twenty years and has opinions about all of them.", 0),
    turn("Pete", "Thanks for having me.", 14),
    turn("Nigel", "So where do we start?", 16),
  ];
  const cues = buildCues(turns);
  assert.equal(cues.map((c) => text(c.lines)).join(" "), turns.flatMap((t) => t.words.map((w) => w.text)).join(" "));
  for (const c of cues) {
    assert.ok(c.lines.length <= 2 && c.lines.every((l) => l.length <= SUBTITLE_LIMITS.lineChars), c.lines.join(" / "));
    assert.ok(c.end - c.start <= SUBTITLE_LIMITS.maxSec + 1e-9);
    assert.ok(c.end - c.start >= SUBTITLE_LIMITS.minSec - 1e-9);
  }
  // Each speaker's words start their own cue.
  assert.ok(cues.some((c) => text(c.lines) === "Thanks for having me."));
  assert.ok(cues.some((c) => text(c.lines) === "So where do we start?"));
  assert.ok(cues.every((c) => !c.lines.some((l) => l.startsWith("- "))));
  // Cues don't overlap, with a small gap between.
  cues.slice(1).forEach((c, i) => assert.ok(c.start - cues[i]!.end >= SUBTITLE_LIMITS.gapSec - 1e-9));
});

test("cues: a long pause starts a new one; a cue cut mid-sentence is cut after a comma; times hold briefly", () => {
  const paused = buildCues([turn("Pete", "One two three", 0), turn("Pete", "four five", 3)]);
  assert.deepEqual(
    paused.map((c) => text(c.lines)),
    ["One two three", "four five"],
  );
  // Held 0.5 s after the last word ends (1.1 s), as the next cue is far off.
  assert.equal(paused[0]!.end, 1.6);
  const long = buildCues([turn("Pete", "I sort every single task I get into three buckets, automate it, assist it, or just do it myself the old way", 0, 0.3)]);
  assert.ok(long.length >= 2);
  assert.ok(/,$/.test(text(long[0]!.lines)), text(long[0]!.lines));
  // A one-word reply still stays up long enough to read.
  const short = buildCues([turn("Pete", "Yes.", 0)]);
  assert.ok(short[0]!.end - short[0]!.start >= SUBTITLE_LIMITS.minSec);
});

test("SRT and WebVTT: times, numbering and layout", () => {
  assert.equal(cueTime(3723.4, ","), "01:02:03,400");
  assert.equal(cueTime(0.0005, "."), "00:00:00.001");
  const cues = [
    { start: 1, end: 2.5, lines: ["Hello there."] },
    { start: 3, end: 5, lines: ["Two lines", "of text."] },
  ];
  assert.equal(toSrt(cues), "1\r\n00:00:01,000 --> 00:00:02,500\r\nHello there.\r\n\r\n2\r\n00:00:03,000 --> 00:00:05,000\r\nTwo lines\r\nof text.\r\n");
  assert.equal(toVtt(cues), "WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello there.\n\n00:00:03.000 --> 00:00:05.000\nTwo lines\nof text.\n");
  assert.equal(languageName("eng"), "English");
  assert.equal(languageName("cmn"), "Mandarin");
  assert.equal(languageName("tlh"), "tlh");
  assert.equal(languageName(undefined), "Original");
  assert.equal(subtitleFileName("Episode 386", "English", "srt"), "Episode 386 - Subtitles (English).srt");
});

test("cues: no line over the limit even when the words don't split evenly; overlapping speech still shows", () => {
  // 83 characters, but no break leaves both lines within 42: it becomes two cues.
  const cues = buildCues([turn("Brian", "Yeah. So let's start at the beginning. Tell us a little bit about where you grew up", 0, 0.2)]);
  assert.ok(cues.every((c) => c.lines.every((l) => l.length <= SUBTITLE_LIMITS.lineChars)), JSON.stringify(cues));
  // Two quick replies at the same moment share one cue.
  assert.deepEqual(buildCues([turn("Brian", "Right.", 5), turn("Delaney", "Exactly.", 5)]).map((c) => c.lines), [["- Right.", "- Exactly."]]);
  // Overlapping speech too long to share a cue: both still get time on screen.
  const overlap = buildCues([
    turn("Brian", "And that was the whole reason we started the show in the first place", 5, 0.1),
    turn("Delaney", "Which I think was the right call for everybody involved in it", 5, 0.1),
  ]);
  assert.ok(overlap.length >= 2);
  assert.ok(overlap.every((c) => c.end - c.start >= 0.3 - 1e-9), JSON.stringify(overlap));
});

test("cues: a quick reply over another speaker shares their cue, a dash per speaker, when both fit a line", () => {
  const cues = buildCues([turn("Delaney", "And I would just tell him,", 10), turn("Brian", "Yeah.", 10.6), turn("Delaney", "I have no idea what that looks like after graduation, honestly.", 12)]);
  assert.deepEqual(cues[0]!.lines, ["- And I would just tell him,", "- Yeah."]);
  assert.equal(cues[0]!.start, 10);
  // Too long to share a cue: the reply keeps its own.
  const long = buildCues([turn("Delaney", "So I always knew I wanted to be in a career in agriculture,", 0, 0.2), turn("Brian", "Right.", 1.5)]);
  assert.ok(long.some((c) => text(c.lines) === "Right."));
  // Two longer turns never share a cue.
  const both = buildCues([turn("Delaney", "We did a lot of education", 0), turn("Brian", "That makes a lot of sense", 2.1)]);
  assert.equal(both.length, 2);
});
