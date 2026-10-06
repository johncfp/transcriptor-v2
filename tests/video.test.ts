import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/shared/settings";
import { breakLines, darken, pageAt, pageLines, scrollAt, wordState, type CaptionWord } from "../src/shared/video";

/** Each character is 10 px wide; a space too. */
const measure = (text: string) => text.length * 10;

function words(text: string, speaker = "Pete", from = 0): CaptionWord[] {
  let t = from;
  return text.split(" ").map((w) => {
    const word = { text: w, start: t, end: t + 0.3, speaker };
    t += 0.4;
    return word;
  });
}

test("captions break into lines that fit, and a new speaker starts a new line", () => {
  const ws = [...words("one two three four five six"), ...words("seven eight", "Nigel", 3)];
  const lines = breakLines(ws, measure, 140); // 14 characters
  assert.deepEqual(
    lines.map((l) => l.words.map((w) => w.text).join(" ")),
    ["one two three", "four five six", "seven eight"],
  );
  assert.deepEqual(
    lines.map((l) => l.speaker),
    ["Pete", "Pete", "Nigel"],
  );
  assert.deepEqual([lines[0]!.start, lines[0]!.end], [0, 1.1]);
  // A word wider than a line gets a line of its own rather than vanishing.
  assert.deepEqual(
    breakLines(words("a extraordinarily b"), measure, 50).map((l) => l.words.map((w) => w.text).join(" ")),
    ["a", "extraordinarily", "b"],
  );
});

test("pages hold a few lines of one speaker, and each stays up until the next is about to start", () => {
  const ws = [...words("aa bb cc dd ee ff gg hh"), ...words("ii jj", "Nigel", 4)];
  const pages = pageLines(breakLines(ws, measure, 50), 2); // two words a line, two lines a page
  assert.deepEqual(
    pages.map((p) => p.lines.map((l) => l.words.map((w) => w.text).join(" ")).join(" / ")),
    ["aa bb / cc dd", "ee ff / gg hh", "ii jj"],
  );
  assert.equal(pageAt(pages, -1), null, "nothing before the first lead-in");
  assert.equal(pageAt(pages, -0.2), pages[0], "shows a moment early");
  assert.equal(pageAt(pages, 1.3), pages[0], "until the next page's lead-in (1.6 s − 0.25 s)");
  assert.equal(pageAt(pages, 1.6 - 0.2), pages[1], "the next page takes over at its lead-in");
  assert.equal(pageAt(pages, 60), pages[2], "the last page stays up");
});

test("scrolling: the reading position moves line to line, sliding just before each starts", () => {
  const lines = breakLines(words("aa bb cc dd ee ff"), measure, 50); // lines start at 0, 0.8, 1.6
  assert.equal(scrollAt(lines, 0), 0);
  assert.equal(scrollAt(lines, 0.5), 0);
  assert.equal(scrollAt(lines, 0.8 - 0.125), 0.5, "halfway through the slide");
  assert.equal(scrollAt(lines, 0.8), 1);
  assert.equal(scrollAt(lines, 99), 2);
});

test("word states: said, being said (with a short hold), still to come", () => {
  const w = { text: "a", start: 1, end: 1.05, speaker: "" };
  assert.equal(wordState(w, 0.9), "ahead");
  assert.equal(wordState(w, 1.1), "now", "held a moment so quick words don't flicker");
  assert.equal(wordState(w, 1.2), "said");
});

test("video settings: off by default, vertical only, Inter, word by word; bad values keep the defaults", () => {
  const { video } = DEFAULT_SETTINGS;
  assert.equal(video.enabled, false);
  assert.deepEqual(video.shapes, { vertical: true, square: false, wide: false });
  assert.deepEqual([video.captionStyle, video.font, video.captionSize, video.backgroundType], ["highlight", "inter", "medium", "color"]);

  const next = mergeSettings(DEFAULT_SETTINGS, {
    video: {
      enabled: true,
      shapes: { square: true, panorama: true },
      captionStyle: "karaoke",
      font: "lexend",
      colors: { background: "#000000", text: "white", highlight: "#ABCDEF" },
      backgroundType: "video",
      backgroundImage: "../../secrets.jpg",
    },
  });
  assert.equal(next.video.enabled, true);
  assert.deepEqual(next.video.shapes, { vertical: true, square: true, wide: false });
  assert.equal(next.video.captionStyle, "highlight");
  assert.equal(next.video.font, "lexend");
  assert.deepEqual(next.video.colors, { background: "#000000", text: "#ffffff", highlight: "#ABCDEF" });
  assert.equal(next.video.backgroundType, "color");
  assert.equal(next.video.backgroundImage, "", "only an imported background's own file name is accepted");
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { video: { backgroundImage: "background-1759700000000.jpg" } }).video.backgroundImage, "background-1759700000000.jpg");
});

test("background gradient colour: darker by the amount asked", () => {
  assert.equal(darken("#ffffff", 0.5), "#808080");
  assert.equal(darken("#14213d", 0), "#14213d");
  assert.equal(darken("#14213d", 1), "#000000");
});
