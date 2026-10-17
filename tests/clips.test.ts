import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanTranscript, defaultEdits, type EpisodeEdits } from "../src/shared/cleanup";
import {
  checkClips,
  checkKeywords,
  checkQuote,
  cleanHashtag,
  clipContext,
  clipCut,
  coerceClips,
  nudgeClip,
  quoteText,
  rawSpeakerNames,
  reviseClip,
  type ClipCheckOptions,
  type ClipDraft,
  type ClipEdit,
} from "../src/shared/clips";
import { formatTimestamp, type Transcript, type Word } from "../src/shared/transcript";
import { startFakeAnthropic } from "../src/main/testing/fakeAnthropic";
import { anthropicWriter } from "../src/main/writing/anthropic";
import { suggestClips } from "../src/main/writing/social";
import { socialSchema, socialSystem } from "../src/main/writing/socialPrompts";
import { SOCIAL_VOICES } from "../src/shared/voices";

// Host (speaker 0) and guest (speaker 1). Each word takes 0.5 s; "Um" is a
// filler the cleanup removes, so it's in the audio but not the clip text.
function episode(): { transcript: Transcript; edits: EpisodeEdits } {
  const script: [number, string][] = [
    [0, "Welcome back to the show. Today we talk about focus, habits and the long game with Pete."],
    [
      1,
      "Thanks for having me. Um so the biggest mistake I see is people chasing every new tool. If a tool saves me an hour but costs me the reason I started, that's not a win. I learned that the hard way in 2019.",
    ],
    [0, "Tell me about the three buckets."],
    [1, "I sort every task into automate, assist, or do it yourself. Nobody has ever fallen in love with an optimized calendar. That's the whole idea."],
  ];
  const words: Word[] = [];
  let t = 0;
  for (const [speaker, text] of script) {
    for (const w of text.split(" ")) {
      words.push({ text: w, start: t, end: t + 0.4, speaker });
      t += 0.5;
    }
    t += 0.5;
  }
  const transcript: Transcript = {
    version: 1,
    provider: "fake",
    model: "fake",
    durationSec: t,
    speakerCount: 2,
    words,
    createdAt: "2026-10-05T00:00:00.000Z",
  };
  const edits = defaultEdits({ repetitions: false }, 2);
  edits.speakerNames = ["Nigel T.", "Pete M."];
  return { transcript, edits };
}

const caption = (text: string, hashtags: string[] = []) => ({ text, hashtags });
const draft = (over: Partial<ClipDraft>): ClipDraft => ({
  title: "Tools versus reasons",
  why: "A clear, quotable point.",
  first_words: "So the biggest mistake I see",
  last_words: "the reason I started, that's not a win.",
  captions: { instagram: caption("Every new tool has a price.", ["focus"]) },
  ...over,
});

function check(drafts: ClipDraft[], over: Partial<ClipCheckOptions> = {}) {
  const { transcript, edits } = episode();
  return checkClips(drafts, cleanTranscript(transcript, edits), {
    limits: { minClips: 1, maxClips: 3, minSeconds: 5, maxSeconds: 20 },
    platforms: ["instagram", "x", "linkedin", "youtube"],
    rawWords: transcript.words,
    durationSec: transcript.durationSec!,
    facts: [],
    allowedUrls: ["https://example.com/show"],
    ...over,
  });
}

const wordAt = (text: string, nth = 0) => episode().transcript.words.filter((w) => w.text === text)[nth]!;

test("a clip's text, speakers and times come from the transcript, with room around the cut", () => {
  const { clips, checks } = check([draft({})]);
  assert.equal(clips.length, 1);
  const clip = clips[0]!;
  assert.equal(clip.id, "clip-1");
  assert.deepEqual(clip.lines, [
    {
      speaker: "Pete M.",
      text: "So the biggest mistake I see is people chasing every new tool. If a tool saves me an hour but costs me the reason I started, that's not a win.",
    },
  ]);
  // "Um" was removed from the text, but it's still in the audio: the cut starts after it.
  assert.equal(clip.start, wordAt("Um").end);
  // The next word ("I learned…") starts 0.1 s after "win.", so the room after stops there.
  assert.equal(clip.end, wordAt("win.").end + 0.1);
  assert.deepEqual(checks, { suggested: 1, dropped: [], hashtagsDropped: 0, highlightsDropped: 0 });
  // No pull quote or keywords asked for, none given.
  assert.equal(clip.quote, null);
  assert.deepEqual(clip.keywords, []);
});

test("the cut never clips the clip's own words, even if the reported length or word times are off", () => {
  const { transcript, edits } = episode();
  const words = transcript.words.map((w) => ({ ...w }));
  // "So" overlaps the "Um" before it; the episode reports itself shorter than its last word.
  const so = words.findIndex((w) => w.text === "so");
  words[so - 1]!.end = words[so]!.start + 0.2;
  const { clips } = checkClips(
    [draft({ first_words: "I sort every task into automate,", last_words: "That's the whole idea." })],
    cleanTranscript({ ...transcript, words }, edits),
    { limits: { minClips: 1, maxClips: 3, minSeconds: 5, maxSeconds: 20 }, platforms: [], rawWords: words, durationSec: 30, facts: [], allowedUrls: [] },
  );
  assert.equal(clips[0]!.end, words.at(-1)!.end);
  const [overlapping] = checkClips([draft({})], cleanTranscript({ ...transcript, words }, edits), {
    limits: { minClips: 1, maxClips: 3, minSeconds: 5, maxSeconds: 20 },
    platforms: [],
    rawWords: words,
    durationSec: 100,
    facts: [],
    allowedUrls: [],
  }).clips;
  assert.equal(overlapping!.start, words[so]!.start);
});

test("a clip that starts or ends mid-sentence moves to the sentence's edges", () => {
  const { clips } = check([draft({ first_words: "biggest mistake I see is people", last_words: "costs me the reason I started," })]);
  assert.match(clips[0]!.lines[0]!.text, /^So the biggest mistake .* that's not a win\.$/);
});

test("a clip can run across speakers", () => {
  const { clips } = check([draft({ first_words: "Tell me about the three buckets.", last_words: "fallen in love with an optimized calendar." })]);
  assert.deepEqual(
    clips[0]!.lines.map((l) => l.speaker),
    ["Nigel T.", "Pete M."],
  );
});

/** The episode with the host's "Mm." between two of the guest's sentences; later words move along to make room. */
function withInterjection(): { transcript: Transcript; edits: EpisodeEdits } {
  const { transcript, edits } = episode();
  const at = transcript.words.findIndex((w) => w.text === "tool.") + 1;
  const words = transcript.words.map((w, i) => (i < at ? w : { ...w, start: w.start + 0.5, end: w.end + 0.5 }));
  const t = words[at - 1]!.end + 0.1;
  words.splice(at, 0, { text: "Mm.", start: t, end: t + 0.4, speaker: 0 });
  return { transcript: { ...transcript, words, durationSec: transcript.durationSec! + 0.5 }, edits };
}

function checkEpisode(ep: { transcript: Transcript; edits: EpisodeEdits }, drafts: ClipDraft[], over: Partial<ClipCheckOptions> = {}) {
  const { transcript, edits } = ep;
  return checkClips(drafts, cleanTranscript(transcript, edits), {
    limits: { minClips: 1, maxClips: 3, minSeconds: 5, maxSeconds: 30 },
    platforms: [],
    rawWords: transcript.words,
    rawSpeakers: rawSpeakerNames(transcript, edits),
    durationSec: transcript.durationSec!,
    facts: [],
    allowedUrls: [],
    ...over,
  });
}

const acrossSpeakers = draft({ first_words: "If a tool saves me an hour", last_words: "fallen in love with an optimized calendar." });

test("other speakers in a clip are noted for review", () => {
  const [clip] = checkEpisode(episode(), [acrossSpeakers]).clips;
  assert.deepEqual(
    clip!.lines.map((l) => l.speaker),
    ["Pete M.", "Nigel T.", "Pete M."],
  );
  const tell = wordAt("Tell");
  assert.deepEqual(clip!.crosstalk, [`Nigel T. says “Tell me about the three buckets.” ${formatTimestamp(tell.start - clip!.start)} into the clip.`]);
  assert.deepEqual(check([draft({})]).clips[0]!.crosstalk, [], "one speaker, nothing to note");
});

test("one speaker per clip: a clip across speakers is trimmed to its longest one-speaker stretch", () => {
  const { clips, checks } = checkEpisode(episode(), [acrossSpeakers], { oneSpeaker: true });
  assert.deepEqual(clips[0]!.lines, [
    { speaker: "Pete M.", text: "If a tool saves me an hour but costs me the reason I started, that's not a win. I learned that the hard way in 2019." },
  ]);
  assert.deepEqual(clips[0]!.crosstalk, []);
  assert.deepEqual(checks.dropped, []);
});

test("one speaker per clip: dropped when no one-speaker stretch is long enough", () => {
  const { clips, checks } = checkEpisode(episode(), [acrossSpeakers], { oneSpeaker: true, limits: { minClips: 1, maxClips: 3, minSeconds: 15, maxSeconds: 30 } });
  assert.equal(clips.length, 0);
  assert.deepEqual(checks.dropped, [{ title: "Tools versus reasons", reason: "Someone else talks in it, and no stretch with one speaker is long enough." }]);
});

test("an interjection the cleanup removed still counts: it's in the audio", () => {
  const ep = withInterjection();
  const whole = draft({ first_words: "So the biggest mistake I see", last_words: "the reason I started, that's not a win." });
  const [clip] = checkEpisode(ep, [whole]).clips;
  assert.deepEqual(
    clip!.lines.map((l) => l.speaker),
    ["Pete M."],
    "the cleaned text doesn't show it",
  );
  assert.equal(clip!.crosstalk!.length, 1);
  assert.match(clip!.crosstalk![0]!, /^Nigel T\. says “Mm\.” 00:0\d into the clip\.$/);

  const [solo] = checkEpisode(ep, [whole], { oneSpeaker: true }).clips;
  assert.deepEqual(solo!.lines, [{ speaker: "Pete M.", text: "If a tool saves me an hour but costs me the reason I started, that's not a win." }]);

  // Edited in review to take the interjection in again: noted again.
  const ctx = clipContext(ep.transcript, ep.edits, null, "");
  const revised = reviseClip(solo!, { title: solo!.title, kept: true, firstWord: clip!.firstWord, lastWord: solo!.lastWord, captions: {} }, ctx);
  assert.equal(revised.crosstalk!.length, 1);
});

test("next to another speaker, the room around a cut stops halfway to their word", () => {
  const words: Word[] = [
    { text: "Right.", start: 0, end: 1, speaker: 0 },
    { text: "Yes.", start: 1.1, end: 2, speaker: 1 },
    { text: "And", start: 2.2, end: 3, speaker: 0 },
  ];
  assert.deepEqual(clipCut(words, 4, 1, 1), { start: 1.05, end: 2.1 });
  const same = words.map((w) => ({ ...w, speaker: 0 }));
  assert.deepEqual(clipCut(same, 4, 1, 1), { start: 1, end: 2.2 });
});

test("clips that can't be found, don't fit the length, overlap, or go over the count are dropped with a reason", () => {
  const { clips, checks } = check(
    [
      draft({ title: "Made up", first_words: "Productivity is a lie we tell" }),
      draft({ title: "Too short", first_words: "Tell me about the three", last_words: "about the three buckets." }),
      draft({ title: "Too long", first_words: "Welcome back to the show.", last_words: "That's the whole idea." }),
      draft({ title: "Kept" }),
      draft({ title: "Overlapping", first_words: "If a tool saves me an hour", last_words: "the hard way in 2019." }),
      draft({ title: "Second", first_words: "I sort every task into automate,", last_words: "That's the whole idea." }),
      draft({ title: "Third", first_words: "Welcome back to the show.", last_words: "long game with Pete." }),
      draft({ title: "Over the count", first_words: "Thanks for having me.", last_words: "chasing every new tool." }),
      draft({ title: "Cut short", first_words: "So", last_words: "win." }),
    ],
    { limits: { minClips: 1, maxClips: 3, minSeconds: 5, maxSeconds: 20 } },
  );
  assert.deepEqual(
    clips.map((c) => c.title),
    ["Third", "Kept", "Second"],
    "in episode order",
  );
  assert.deepEqual(
    clips.map((c) => c.id),
    ["clip-1", "clip-2", "clip-3"],
  );
  assert.deepEqual(checks.dropped, [
    { title: "Made up", reason: "Its first words aren't in the transcript." },
    { title: "Too short", reason: "Shorter than 5 seconds." },
    { title: "Too long", reason: "Longer than 20 seconds." },
    { title: "Overlapping", reason: "It overlaps another clip." },
    { title: "Over the count", reason: "More than 3 clips were suggested." },
    { title: "Cut short", reason: "Its first or last words were too short to find in the transcript." },
  ]);
  assert.equal(checks.suggested, 9);
});

test("captions: only chosen platforms, hashtags cleaned and capped, problems flagged", () => {
  const { clips, checks } = check(
    [
      draft({
        captions: {
          instagram: caption("Pete learned it the hard way in 2019, and 90% of us still do.", ["#Focus", "focus", "Deep Work!", "habits", "tools", "time", "calm"]),
          x: caption("x".repeat(300), ["one", "two", "three"]),
          linkedin: caption("More at https://example.com/show/ and www.pete-courses.com."),
          youtube: caption("A short description."),
        },
      }),
    ],
    { platforms: ["instagram", "x", "linkedin"] },
  );
  const { captions } = clips[0]!;
  assert.deepEqual(Object.keys(captions), ["instagram", "x", "linkedin"], "YouTube isn't chosen");
  assert.deepEqual(captions.instagram!.hashtags, ["Focus", "DeepWork", "habits", "tools", "time"]);
  assert.deepEqual(captions.instagram!.problems, ["“90%” isn't in the transcript or the confirmed guest facts."], "2019 is in the transcript");
  assert.deepEqual(captions.x!.hashtags, ["one", "two"]);
  // 300 characters, a blank line, then "#one #two".
  assert.deepEqual(captions.x!.problems, ["31 characters over X / Threads's 280 limit."]);
  assert.deepEqual(captions.linkedin!.problems, ["The link www.pete-courses.com isn't the show's website or a confirmed guest link."]);
  // Over the count: "calm" on Instagram, "three" on X. The duplicate "focus" isn't counted.
  assert.equal(checks.hashtagsDropped, 2);
});

test("numbers in confirmed guest facts count as known; long titles are flagged for YouTube", () => {
  const { clips } = check(
    [draft({ title: "T".repeat(110), captions: { instagram: caption("Pete has coached 3,000 founders.") } })],
    { facts: ["Pete has coached 3,000 founders since 2015."] },
  );
  assert.deepEqual(clips[0]!.captions.instagram!.problems, []);
  assert.deepEqual(clips[0]!.titleProblems, ["10 characters over YouTube's 100-character title limit."]);
});

test("model output is read defensively", () => {
  assert.deepEqual(coerceClips(null), []);
  assert.deepEqual(coerceClips({ clips: "no" }), []);
  const [c] = coerceClips({ clips: [{ title: " T ", first_words: 3, captions: { x: { text: "Hi", hashtags: ["a", 2] }, tiktok: { text: "?" } } }] });
  assert.deepEqual(c, { title: "T", why: "", first_words: "", last_words: "", pull_quote: "", keywords: [], captions: { x: { text: "Hi", hashtags: ["a"] } } });
  assert.deepEqual(coerceClips({ clips: [{ pull_quote: " Not a win ", keywords: ["tool", 3, ""] }] })[0]!.keywords, ["tool"]);
  assert.equal(cleanHashtag("##Growth Hacking!"), "GrowthHacking");
  assert.equal(cleanHashtag("#!!"), "");
});

test("prompt: limits and chosen platforms in the rules, the voice last; schema asks only for chosen platforms", () => {
  const limits = { minClips: 2, maxClips: 4, minSeconds: 20, maxSeconds: 45 };
  const system = socialSystem(limits, ["x", "youtube"], "industry");
  assert.match(system, /Choose 2 to 4 clips, each 20 to 45 seconds long/);
  assert.match(system, /- x \(X \/ Threads\)/);
  assert.match(system, /- youtube \(YouTube Shorts\)/);
  assert.doesNotMatch(system, /- instagram/);
  assert.ok(system.endsWith(SOCIAL_VOICES.industry.prompt), "voice comes after the rules");
  assert.ok(system.indexOf("Never add facts") < system.indexOf("Voice ("));
  assert.match(system, /A clip can include more than one speaker\./);
  const solo = socialSystem(limits, ["x"], "industry", "", true);
  assert.match(solo, /Each clip must be one person talking/);
  assert.doesNotMatch(solo, /more than one speaker/);
  const captions = (socialSchema(["x", "youtube"]).properties.clips.items.properties.captions as { required: string[] }).required;
  assert.deepEqual(captions, ["x", "youtube"]);
});

test("Claude: social clips use their own schema, model, effort and fallbacks, and come back checked", async () => {
  const { transcript, edits } = episode();
  const fake = await startFakeAnthropic({
    draft: {},
    social: { clips: [draft({}), draft({ title: "Made up", first_words: "Productivity is a lie we tell" })] },
  });
  try {
    const stages: string[] = [];
    const result = await suggestClips({
      transcript,
      edits,
      writing: null,
      show: { name: "The Test Show", hosts: ["Nigel T."], website: "https://example.com/show" },
      limits: { minClips: 1, maxClips: 3, minSeconds: 5, maxSeconds: 20 },
      platforms: ["instagram"],
      voice: "general",
      writer: anthropicWriter,
      call: { apiKey: "k", model: "claude-sonnet-5-5", baseUrl: fake.url, effort: "medium" },
      onStage: (s) => stages.push(s),
    });
    const body = fake.requests.find((r) => r.body.stream)!.body;
    assert.equal(body.model, "claude-sonnet-5-5");
    const config = body.output_config as { effort?: string; format: { schema: { properties: Record<string, unknown> } } };
    assert.equal(config.effort, "medium");
    assert.ok(config.format.schema.properties.clips);
    assert.equal(body.fallbacks, "default");
    const user = (body.messages as { content: string }[])[0]!.content;
    assert.match(user, /Show website: https:\/\/example.com\/show/);
    assert.match(user, /Guest: Pete M\./, "cast worked out from the transcript when there are no notes");
    // Markers every 15 s (at a sentence end): this turn is under a minute but still gets a second one.
    assert.match(user, /\[00:26\] Pete M\.: I learned that the hard way in 2019\./);
    assert.equal(result.model, "claude-sonnet-5-5");
    assert.equal(result.effort, "medium");
    assert.equal(result.clips.length, 1);
    assert.equal(result.checks.dropped[0]!.title, "Made up");
    assert.deepEqual(stages, ["Picking social clips", "Checking clips against the transcript"]);
  } finally {
    fake.close();
  }
});

// --- Review edits -------------------------------------------------------------

function reviewed() {
  const { transcript, edits } = episode();
  const ctx = clipContext(transcript, edits, null, "https://example.com/show");
  const { clips } = check([draft({ captions: { instagram: caption("Every new tool has a price.", ["focus"]), x: caption("Short.") } })]);
  const clip = clips[0]!;
  const edit: ClipEdit = { title: clip.title, kept: false, firstWord: clip.firstWord, lastWord: clip.lastWord, captions: {} };
  return { transcript, ctx, clip, edit };
}

test("review: trimming moves by whole words, skipping removed fillers, and the text follows", () => {
  const { transcript, ctx, clip } = reviewed();
  const words = transcript.words;
  assert.equal(words[clip.firstWord]!.text, "so");

  const earlier = nudgeClip(ctx.turns, clip, "start", -1)!;
  assert.equal(words[earlier.firstWord]!.text, "me.", "past the removed \"Um\" to the word before it");
  const later = nudgeClip(ctx.turns, clip, "end", -1)!;
  assert.equal(words[later.lastWord]!.text, "a");

  const trimmed = reviseClip(clip, { ...reviewedEdit(clip), ...later }, ctx);
  assert.match(trimmed.lines.at(-1)!.text, /that's not a$/);
  assert.equal(trimmed.end, words[later.lastWord]!.end + 0.1, "the cut follows: up to the next word, 0.1 s later");
  assert.equal(nudgeClip(ctx.turns, { firstWord: 5, lastWord: 5 }, "start", 1), null, "a clip keeps at least one word");
  assert.equal(nudgeClip(ctx.turns, { firstWord: 0, lastWord: 5 }, "start", -1), null, "nothing before the first word");
});

const reviewedEdit = (c: { title: string; kept: boolean; firstWord: number; lastWord: number }): ClipEdit => ({
  title: c.title,
  kept: c.kept,
  firstWord: c.firstWord,
  lastWord: c.lastWord,
  captions: {},
});

test("review: edited captions and titles are checked again; your own extra hashtags are flagged, not removed", () => {
  const { ctx, clip, edit } = reviewed();
  const next = reviseClip(
    clip,
    {
      ...edit,
      title: "  A much better title  ",
      kept: true,
      captions: { x: { text: "Up 40% since 2019!", hashtags: ["a", "#b", "c"] }, youtube: { text: "Not a chosen platform", hashtags: [] } },
    },
    ctx,
  );
  assert.equal(next.title, "A much better title");
  assert.equal(next.kept, true);
  assert.deepEqual(Object.keys(next.captions), ["instagram", "x"], "platforms stay as suggested");
  assert.deepEqual(next.captions.x!.hashtags, ["a", "b", "c"]);
  assert.deepEqual(next.captions.x!.problems, [
    "3 hashtags; 2 is the most to use on X / Threads.",
    "“40%” isn't in the transcript or the confirmed guest facts.",
  ]);
  assert.equal(next.captions.instagram!.text, "Every new tool has a price.", "untouched captions stay");
});

test("review: edits can't point a clip outside the transcript or make up its text", () => {
  const { ctx, clip, edit } = reviewed();
  for (const bad of [
    { firstWord: -1 },
    { lastWord: 10_000 },
    { firstWord: clip.lastWord, lastWord: clip.firstWord },
    { firstWord: 1.5 },
  ]) {
    const next = reviseClip(clip, { ...edit, ...bad }, ctx);
    assert.deepEqual([next.firstWord, next.lastWord, next.start, next.end], [clip.firstWord, clip.lastWord, clip.start, clip.end]);
  }
  const sneaky = reviseClip(clip, { ...edit, lines: [{ speaker: "Pete M.", text: "Something never said." }] } as ClipEdit, ctx);
  assert.deepEqual(sneaky.lines, clip.lines);
});

test("pull quote and keywords: taken from the transcript inside the clip, or left out", () => {
  const ep = episode();
  const turns = cleanTranscript(ep.transcript, ep.edits);
  // Copied with different punctuation and case still matches; the text comes from the transcript.
  const { clips, checks } = check([draft({ pull_quote: "that's NOT a win", keywords: ["Tool", "reason", "tool", "calendar", "the hard way"] })]);
  const clip = clips[0]!;
  assert.equal(quoteText(turns, clip.quote!), "that's not a win.");
  assert.equal(clip.quote!.firstWord, ep.transcript.words.findIndex((w) => w.text === "that's"));
  // "calendar" isn't in this clip, "tool" is there twice, and "the hard way" isn't one word.
  assert.deepEqual(clip.keywords, ["tool", "reason"]);
  assert.equal(checks.highlightsDropped, 1);

  // Not in the clip, too long, too short: no pull quote.
  for (const pull_quote of ["Nobody has ever fallen in love", "So the biggest mistake I see is people chasing every new", "a win"]) {
    const r = check([draft({ pull_quote })]);
    assert.equal(r.clips[0]!.quote, null, pull_quote);
  }
  assert.equal(check([draft({ pull_quote: "Nobody has ever fallen in love" })]).checks.highlightsDropped, 1);

  // Checked directly: edges must be cleaned words inside the clip, 3 to 10 of them, one speaker.
  const span = { firstWord: clip.firstWord, lastWord: clip.lastWord };
  assert.deepEqual(checkQuote(turns, span, clip.quote), clip.quote);
  assert.equal(checkQuote(turns, span, { firstWord: clip.firstWord - 5, lastWord: clip.firstWord + 2 }), null);
  assert.equal(checkQuote(turns, span, { firstWord: clip.lastWord, lastWord: clip.lastWord }), null);
  assert.equal(checkQuote(turns, span, null), null);
  // "Um" was removed in cleanup, so a quote can't start on it.
  const um = ep.transcript.words.findIndex((w) => w.text === "Um");
  assert.equal(checkQuote(turns, { firstWord: um, lastWord: clip.lastWord }, { firstWord: um, lastWord: um + 3 }), null);
  assert.deepEqual(checkKeywords(turns, span, ["win", "WIN", "nope", 4]), ["win"]);
  assert.deepEqual(checkKeywords(turns, span, "win"), []);

  // An edit can change or clear them; a trim drops what falls outside.
  const ctx = clipContext(ep.transcript, ep.edits, null, "");
  const base = { title: clip.title, kept: false, firstWord: clip.firstWord, lastWord: clip.lastWord, captions: {} };
  assert.equal(reviseClip(clip, { ...base, quote: null }, ctx).quote, null);
  assert.deepEqual(reviseClip(clip, { ...base, keywords: ["mistake"] }, ctx).keywords, ["mistake"]);
  const unchanged = reviseClip(clip, base, ctx);
  assert.deepEqual([unchanged.quote, unchanged.keywords], [clip.quote, clip.keywords]);
  const trimmed = reviseClip(clip, { ...base, lastWord: clip.quote!.firstWord + 1 }, ctx);
  assert.equal(trimmed.quote, null);
  // "tool" and "reason" are both said before the quote, so they stay.
  assert.deepEqual(trimmed.keywords, ["tool", "reason"]);
  assert.deepEqual(reviseClip(clip, { ...base, lastWord: clip.firstWord + 4 }, ctx).keywords, []);
});
