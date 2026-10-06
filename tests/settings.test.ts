import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/shared/settings";

test("missing or unreadable file gives the defaults", () => {
  assert.deepEqual(mergeSettings(DEFAULT_SETTINGS, undefined), DEFAULT_SETTINGS);
  assert.deepEqual(mergeSettings(DEFAULT_SETTINGS, "garbage"), DEFAULT_SETTINGS);
});

test("approval before processing is the default", () => {
  assert.equal(DEFAULT_SETTINGS.processing.intake, "approve");
});

test("a partial patch keeps sibling values", () => {
  const next = mergeSettings(DEFAULT_SETTINGS, { processing: { reviewStep: false } });
  assert.equal(next.processing.reviewStep, false);
  assert.equal(next.processing.intake, "approve");
  assert.equal(next.general.startAtLogin, true);
});

test("unknown keys and wrong types are dropped", () => {
  const next = mergeSettings(DEFAULT_SETTINGS, {
    bogus: 1,
    general: { startAtLogin: "yes", closeToTray: false },
    processing: { intake: "sometimes" },
    show: { hosts: ["Nigel T.", 3] },
  });
  assert.equal("bogus" in next, false);
  assert.equal(next.general.startAtLogin, true);
  assert.equal(next.general.closeToTray, false);
  assert.equal(next.processing.intake, "approve");
  assert.deepEqual(next.show.hosts, []);
});

test("string arrays are replaced, not merged", () => {
  const a = mergeSettings(DEFAULT_SETTINGS, { show: { hosts: ["Nigel T.", "Sam K."] } });
  const b = mergeSettings(a, { show: { hosts: ["Nigel T."] } });
  assert.deepEqual(b.show.hosts, ["Nigel T."]);
});

test("the defaults object is never mutated", () => {
  const before = JSON.stringify(DEFAULT_SETTINGS);
  mergeSettings(DEFAULT_SETTINGS, { show: { name: "This Is A Test Show" } });
  assert.equal(JSON.stringify(DEFAULT_SETTINGS), before);
});

test("episode colors must be #rrggbb; custom voice is a valid choice", () => {
  const next = mergeSettings(DEFAULT_SETTINGS, {
    general: { episodeColors: { fresh: "#123abc", reviewed: "orange", notesReady: "#12345" } },
    writing: { voice: "custom", customVoice: "Friendly and short." },
  });
  assert.equal(next.general.episodeColors.fresh, "#123abc");
  assert.equal(next.general.episodeColors.reviewed, DEFAULT_SETTINGS.general.episodeColors.reviewed);
  assert.equal(next.general.episodeColors.notesReady, DEFAULT_SETTINGS.general.episodeColors.notesReady);
  assert.equal(next.writing.voice, "custom");
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { writing: { voice: "pirate" } }).writing.voice, "general");
});

test("custom voice falls back to General when empty and is capped in length", async () => {
  const { voicePrompt, VOICES, CUSTOM_VOICE_MAX } = await import("../src/shared/voices");
  assert.equal(voicePrompt("custom", "   "), VOICES.general.prompt);
  assert.equal(voicePrompt("custom", " Be brief. "), "Be brief.");
  assert.equal(voicePrompt("custom", "x".repeat(5000)).length, CUSTOM_VOICE_MAX);
  assert.equal(voicePrompt("seo", "ignored"), VOICES.seo.prompt);
});

test("social clips are off by default and use Sonnet at medium effort", async () => {
  const { socialDefaultModel } = await import("../src/shared/social");
  const { social } = DEFAULT_SETTINGS;
  assert.equal(social.enabled, false);
  assert.equal(social.provider, "anthropic");
  assert.equal(social.model, "");
  assert.equal(social.effort, "medium");
  assert.equal(socialDefaultModel("anthropic"), "claude-sonnet-5-5");
  // Other providers fall back to their usual default.
  assert.equal(socialDefaultModel("openai"), "gpt-5.5");
  assert.deepEqual(social.platforms, { instagram: true, x: true, linkedin: true, youtube: true });
});

test("social settings merge like the rest, separately from the show notes", () => {
  const next = mergeSettings(DEFAULT_SETTINGS, {
    social: { enabled: true, voice: "seo", effort: "turbo", platforms: { x: false, tiktok: true }, maxClips: "8" },
  });
  assert.equal(next.social.enabled, true);
  assert.equal(next.social.voice, "seo");
  assert.equal(next.social.effort, "medium");
  assert.deepEqual(next.social.platforms, { instagram: true, x: false, linkedin: true, youtube: true });
  assert.equal(next.social.maxClips, 5);
  assert.equal(next.writing.voice, "general");
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { social: { voice: "pirate" } }).social.voice, "general");
});

test("clip limits are whole numbers in range, minimum first", async () => {
  const { clipLimits } = await import("../src/shared/social");
  assert.deepEqual(clipLimits({ minClips: 3, maxClips: 5, minSeconds: 15, maxSeconds: 60 }), {
    minClips: 3,
    maxClips: 5,
    minSeconds: 15,
    maxSeconds: 60,
  });
  assert.deepEqual(clipLimits({ minClips: 0, maxClips: 99, minSeconds: 1, maxSeconds: 1000 }), {
    minClips: 1,
    maxClips: 10,
    minSeconds: 5,
    maxSeconds: 180,
  });
  assert.deepEqual(clipLimits({ minClips: 6, maxClips: 2.4, minSeconds: 90, maxSeconds: 30 }), {
    minClips: 2,
    maxClips: 6,
    minSeconds: 30,
    maxSeconds: 90,
  });
  assert.deepEqual(clipLimits({ minClips: NaN, maxClips: Infinity, minSeconds: NaN, maxSeconds: NaN }), {
    minClips: 3,
    maxClips: 5,
    minSeconds: 15,
    maxSeconds: 60,
  });
});

test("social voices have their own caption wording; empty custom falls back to General", async () => {
  const { socialVoicePrompt, SOCIAL_VOICES, VOICES } = await import("../src/shared/voices");
  assert.equal(socialVoicePrompt("custom", "  "), SOCIAL_VOICES.general.prompt);
  assert.equal(socialVoicePrompt("custom", " Punchy. "), "Punchy.");
  assert.equal(socialVoicePrompt("industry", "ignored"), SOCIAL_VOICES.industry.prompt);
  for (const id of ["general", "industry", "seo"] as const) assert.notEqual(SOCIAL_VOICES[id].prompt, VOICES[id].prompt);
});

test("episode stages for the list colors", async () => {
  const { episodeStage } = await import("../src/shared/jobs");
  assert.equal(episodeStage({ status: "queued" }), "fresh");
  assert.equal(episodeStage({ status: "needs-review" }), "fresh");
  assert.equal(episodeStage({ status: "ready" }), "reviewed");
  assert.equal(episodeStage({ status: "writing" }), "reviewed");
  assert.equal(episodeStage({ status: "failed", failedStep: "writing" }), "reviewed");
  assert.equal(episodeStage({ status: "written" }), "notesReady");
  assert.equal(episodeStage({ status: "failed", failedStep: "transcription" }), null);
  assert.equal(episodeStage({ status: "cancelled" }), null);
});

test("window at startup: normal by default; only known choices are kept", () => {
  assert.equal(DEFAULT_SETTINGS.general.startWindow, "normal");
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { general: { startWindow: "fullscreen" } }).general.startWindow, "fullscreen");
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { general: { startWindow: "huge" } }).general.startWindow, "normal");
});
