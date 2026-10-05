import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanTranscript, defaultEdits, type EpisodeEdits } from "../src/shared/cleanup";
import { checkClips, cleanHashtag, coerceClips, type ClipCheckOptions, type ClipDraft } from "../src/shared/clips";
import type { Transcript, Word } from "../src/shared/transcript";
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
  assert.deepEqual(checks, { suggested: 1, dropped: [], hashtagsDropped: 0 });
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
  assert.deepEqual(c, { title: "T", why: "", first_words: "", last_words: "", captions: { x: { text: "Hi", hashtags: ["a"] } } });
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
