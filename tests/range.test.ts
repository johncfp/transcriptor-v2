import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRange } from "../src/main/range";

test("byte ranges for seeking", () => {
  assert.deepEqual(parseRange("bytes=0-", 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRange("bytes=100-199", 1000), { start: 100, end: 199 });
  assert.deepEqual(parseRange("bytes=900-5000", 1000), { start: 900, end: 999 }, "end is clamped");
  assert.deepEqual(parseRange("bytes=-100", 1000), { start: 900, end: 999 }, "suffix range");
});

test("missing or unsatisfiable ranges mean the whole file", () => {
  assert.equal(parseRange(null, 1000), null);
  assert.equal(parseRange("bytes=1000-", 1000), null);
  assert.equal(parseRange("bytes=5-2", 1000), null);
  assert.equal(parseRange("bytes=0-10,20-30", 1000), null);
  assert.equal(parseRange("items=0-1", 1000), null);
});
