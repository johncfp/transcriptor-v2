import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkTranslation,
  readTranslations,
  segmentsOf,
  sourceKey,
  splitCjk,
  translatedCues,
  translationPrompt,
  translationSystem,
} from "../src/shared/subtitleTranslation";
import type { Cue } from "../src/shared/subtitles";
import { startFakeAnthropic } from "../src/main/testing/fakeAnthropic";
import { anthropicWriter } from "../src/main/writing/anthropic";
import { translateSubtitles } from "../src/main/writing/subtitles";

const cues: Cue[] = [
  { start: 0, end: 2, lines: ["Welcome back to the show."] },
  { start: 2.1, end: 4, lines: ["- And I would just tell him,", "- Yeah."] },
  { start: 4.1, end: 8, lines: ["We grew 40 percent in 2019, which", "nobody expected at the time."] },
];

test("segments: one per cue, one per speaker in a shared cue; the key changes with the text", () => {
  const segs = segmentsOf(cues);
  assert.deepEqual(
    segs.map((s) => [s.id, s.cue, s.part, s.text]),
    [
      [0, 0, undefined, "Welcome back to the show."],
      [1, 1, 0, "And I would just tell him,"],
      [2, 1, 1, "Yeah."],
      [3, 2, undefined, "We grew 40 percent in 2019, which nobody expected at the time."],
    ],
  );
  assert.equal(sourceKey(segs), sourceKey(segmentsOf(cues)));
  assert.notEqual(sourceKey(segs), sourceKey(segmentsOf([{ ...cues[0]!, lines: ["Welcome back."] }, ...cues.slice(1)])));
});

test("prompt: rules for the target language, context marked as not to translate", () => {
  const segs = segmentsOf(cues);
  assert.match(translationSystem("English", "zh"), /Simplified Chinese/);
  assert.match(translationSystem("English", "zh"), /Latin letters/);
  assert.doesNotMatch(translationSystem("English", "es"), /Latin letters/);
  const p = translationPrompt(segs.slice(1, 3), segs.slice(0, 1), segs.slice(3));
  assert.match(p, /^Context before \(don't translate\):\n0: Welcome back/);
  assert.match(p, /Translate these segments:\n1: And I would just tell him,\n2: Yeah\./);
  assert.match(p, /Context after \(don't translate\):\n3: We grew/);
});

test("checks: only asked-for ids, once each; missing ones stay in the original; changed numbers are noted", () => {
  const segs = segmentsOf(cues);
  const got = readTranslations(
    { segments: [{ id: 0, text: "Bienvenidos de nuevo." }, { id: "1", text: "Y yo le decía,\n" }, { id: 1, text: "twice" }, { id: 9, text: "not asked" }, { id: 3, text: "Crecimos un 40 por ciento en 2018." }] },
    segs,
  );
  assert.deepEqual([...got.keys()], [0, 1, 3]);
  assert.equal(got.get(1), "Y yo le decía,");
  const { texts, problems } = checkTranslation(segs, got);
  assert.equal(texts[2], "Yeah.");
  assert.equal(problems.length, 2);
  assert.match(problems[0]!, /^1 subtitle couldn't be translated/);
  assert.match(problems[1]!, /number that changed/);
  assert.deepEqual(readTranslations("nonsense", segs), new Map());
});

test("translated cues: same times, lines laid out again, dashes kept when they fit; Chinese breaks between characters", () => {
  const segs = segmentsOf(cues);
  const out = translatedCues(cues, segs, ["Bienvenidos de nuevo al programa.", "Y yo le decía,", "Sí.", "Crecimos un 40 por ciento en 2019, algo que nadie esperaba en ese momento."], "es");
  assert.deepEqual(out.map((c) => [c.start, c.end]), cues.map((c) => [c.start, c.end]));
  assert.deepEqual(out[1]!.lines, ["- Y yo le decía,", "- Sí."]);
  assert.equal(out[2]!.lines.length, 2);
  assert.deepEqual(splitCjk("欢迎回来。"), ["欢迎回来。"]);
  const zh = splitCjk("我们在二零一九年增长了百分之四十，当时谁也没有想到会这样。");
  assert.equal(zh.length, 2);
  // Lines within 16 characters, not counting a punctuation mark at the end.
  assert.ok(zh.every((l) => [...l.replace(/[，。]$/, "")].length <= 16), zh.join(" / "));
  assert.ok(zh[0]!.endsWith("，"), zh.join(" / "));
  // Punctuation never starts a line.
  assert.ok(!/^[，。！？、]/.test(zh[1]!));
});

test("translation against the Claude SDK: batches, a retry for what's missing, then the checks", async () => {
  const segs = Array.from({ length: 130 }, (_, i) => ({ id: i, cue: i, text: `Line ${i}.` }));
  let calls = 0;
  let skipped = false;
  const fake = await startFakeAnthropic({
    draft: {},
    subtitles: (prompt) => {
      calls++;
      // Only the segments to translate, not the context around them.
      const part = prompt.split("Translate these segments:\n")[1]!.split("\n\nContext after")[0]!;
      const asked = [...part.matchAll(/^(\d+): Line \d+\.$/gm)].map((m) => Number(m[1]));
      // Segment 5 is left out the first time it's asked for; the retry gets it.
      const list = asked
        .filter((id) => {
          if (id === 5 && !skipped) return !(skipped = true);
          return true;
        })
        .map((id) => ({ id, text: `Línea ${id}.` }));
      return { segments: list };
    },
  });
  try {
    const r = await translateSubtitles({ segments: segs, source: "English", target: "es", writer: anthropicWriter, call: { apiKey: "test", model: "claude-sonnet-5-5", baseUrl: fake.url } });
    assert.equal(r.texts.length, 130);
    assert.equal(r.texts[5], "Línea 5.");
    assert.equal(r.texts[129], "Línea 129.");
    assert.deepEqual(r.problems, []);
    assert.equal(calls, 3); // two batches, then one retry
  } finally {
    fake.close();
  }
});
