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
