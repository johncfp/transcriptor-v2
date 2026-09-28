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
