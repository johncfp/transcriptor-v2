import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/shared/settings";
import {
  audioLevels,
  breakLines,
  cjkTokens,
  CARD_HOLD,
  cardIn,
  clipCaptionWords,
  darken,
  easeInOut,
  easeOut,
  headerIn,
  HOOK_END,
  hookOut,
  hookQuote,
  hasOutro,
  hookWordAlpha,
  isCjkText,
  isKeyword,
  isPlaceholderName,
  MOTION,
  nameCards,
  outroIn,
  outroLines,
  pageAt,
  pageLines,
  popScale,
  QUOTE_HOLD,
  QUOTE_LEAD,
  quoteMoment,
  quoteWords,
  scrollAt,
  stamp,
  speakerRole,
  videoSeconds,
  wordState,
  type CaptionWord,
} from "../src/shared/video";
import { clipCues, videoStrings } from "../src/shared/videoLanguages";
import { clipVideoName } from "../src/shared/exportDocs";

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

test("a clip's caption words: cleaned words between its first and last word, timed from the clip's start", () => {
  const turns = [
    { speaker: "Nigel T.", start: 9, words: [{ index: 9, text: "Before.", start: 9, end: 9.5 }] },
    {
      speaker: "Pete",
      start: 10,
      words: [
        { index: 10, text: "So", start: 10.2, end: 10.4 },
        // index 11 ("um") was removed by cleanup, so it isn't here.
        { index: 12, text: "listen.", start: 11, end: 11.4 },
      ],
    },
    { speaker: "Nigel T.", start: 12, words: [{ index: 13, text: "After.", start: 12, end: 12.5 }] },
  ];
  assert.deepEqual(clipCaptionWords(turns, { firstWord: 10, lastWord: 12, start: 10 }), [
    { text: "So", start: 10.2 - 10, end: 10.4 - 10, speaker: "Pete", index: 10 },
    { text: "listen.", start: 1, end: 11.4 - 10, speaker: "Pete", index: 12 },
  ]);
});

test("waveform levels: one per video frame, loud parts reach 1, silence is 0", () => {
  const rate = 3000; // 100 samples per frame at 30 fps
  const pcm = new Int16Array(rate); // one second, mono
  for (let i = 0; i < pcm.length; i++) {
    const frame = Math.floor(i / 100);
    const amp = frame < 10 ? 0 : frame < 20 ? 4000 : 16000; // silent, quiet, loud
    pcm[i] = i % 2 ? amp : -amp;
  }
  const levels = audioLevels(pcm, 1, rate);
  assert.equal(levels.length, 30);
  assert.ok(levels.slice(0, 10).every((l) => l === 0));
  assert.ok(levels.slice(20).every((l) => l === 1));
  assert.ok(Math.abs(levels[15]! - 0.5) < 0.01, "a quarter as loud shows at half height (square-root curve)");
  assert.deepEqual(audioLevels(new Int16Array(200), 2, rate), [0], "all silence stays flat");
});

test("motion settings: on by default, kept when saved, and bad values fall back", () => {
  assert.deepEqual(DEFAULT_SETTINGS.video.motion, { hook: true, pop: true, glow: true, progress: true, outro: true, nameCards: true, pullQuote: true, keywords: true });
  assert.equal(DEFAULT_SETTINGS.video.waveformStyle, "pulse");
  // A settings file from before motion gets the defaults.
  const old = mergeSettings(DEFAULT_SETTINGS, { video: { enabled: true, waveform: true } });
  assert.deepEqual(old.video.motion, DEFAULT_SETTINGS.video.motion);
  assert.equal(old.video.waveformStyle, "pulse");
  const next = mergeSettings(DEFAULT_SETTINGS, { video: { waveformStyle: "history", motion: { glow: false, sparkle: true } } });
  assert.equal(next.video.waveformStyle, "history");
  assert.deepEqual(next.video.motion, { hook: true, pop: true, glow: false, progress: true, outro: true, nameCards: true, pullQuote: true, keywords: true });
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { video: { waveformStyle: "spiral" } }).video.waveformStyle, "pulse");
});

test("hook quote: the shortest whole sentence of 3–10 words after the first, by one speaker", () => {
  const text = (ws: CaptionWord[] | null) => ws?.map((w) => w.text).join(" ") ?? null;
  // The first sentence is heard straight away, so it isn't used even though it's shortest.
  const ws = words("We start here. This one is a bit longer than that. We're not tech-averse. Two words. And the end of a sentence");
  assert.equal(text(hookQuote(ws)), "We're not tech-averse.");
  // Ties go to the earlier sentence; questions and exclamations count.
  assert.equal(text(hookQuote(words("Hi there you. Is it really true? It is so true!"))), "Is it really true?");
  // More than 10 words is too long for a hook.
  assert.equal(hookQuote(words("Start now please. One two three four five six seven eight nine ten eleven.")), null);
  // A sentence cut off by another speaker isn't whole, and isn't used.
  const cut = [...words("First one here. We are not"), ...words("Mm-hmm.", "Nigel", 3), ...words("tech-averse at all.", "Pete", 4)];
  assert.equal(hookQuote(cut), null);
  assert.equal(hookQuote([]), null);
});

test("motion timing: the hook fades in word by word and lifts away; the word being said pops", () => {
  assert.equal(easeOut(-1), 0);
  assert.equal(easeOut(2), 1);
  assert.equal(easeInOut(0.5), 0.5);
  assert.equal(hookWordAlpha(0, 0), 0);
  assert.equal(hookWordAlpha(0, MOTION.hookWordIn), 1);
  // The third word starts later than the first.
  assert.ok(hookWordAlpha(2, 0.2) < hookWordAlpha(0, 0.2));
  assert.equal(hookOut(MOTION.hookHold), 0);
  assert.equal(hookOut(MOTION.hookHold + MOTION.hookOut), 1);
  // The logo and show name wait until the quote is mostly gone, and are back by HOOK_END.
  assert.equal(headerIn(MOTION.hookHold + MOTION.headerDelay), 0);
  assert.ok(hookOut(MOTION.hookHold + MOTION.headerDelay) > 0.8);
  assert.equal(headerIn(HOOK_END), 1);
  assert.equal(hookWordAlpha(0, HOOK_END), 0);
  const w = { text: "pop", start: 1, end: 1.4, speaker: "Pete" };
  assert.equal(popScale(w, 0.9), 1);
  assert.ok(Math.abs(popScale(w, 1 + MOTION.popSec / 2) - (1 + MOTION.popScale)) < 1e-9);
  assert.equal(popScale(w, 1 + MOTION.popSec + 0.01), 1);
});

test("outro card: only with something to point to; the video runs on past the audio", () => {
  const on = { motion: { outro: true } }, off = { motion: { outro: false } };
  assert.equal(hasOutro(on, "LOL a Podcast", ""), true);
  assert.equal(hasOutro(on, "", "lol.example"), true);
  assert.equal(hasOutro(on, " ", ""), false);
  assert.equal(hasOutro(off, "LOL a Podcast", "lol.example"), false);
  assert.equal(videoSeconds(42.6, true), 42.6 + MOTION.outroSec);
  assert.equal(videoSeconds(42.6, false), 42.6);
  assert.equal(outroIn(42, 42.6), 0);
  assert.equal(outroIn(42.6 + MOTION.outroIn, 42.6), 1);
  assert.deepEqual(outroLines("LOL a Podcast", " lol.example "), { above: "Full episode on", big: "LOL a Podcast", below: "lol.example" });
  assert.deepEqual(outroLines("", "lol.example"), { above: "Full episode at", big: "lol.example", below: "" });
});

test("name cards: one when a named speaker starts, Host or Guest, none for unnamed speakers", () => {
  assert.equal(isPlaceholderName("Speaker 2"), true);
  assert.equal(isPlaceholderName("Delaney Howell"), false);
  assert.equal(speakerRole("Brian", ["Brian Smith"]), "Host");
  assert.equal(speakerRole("nigel t.", ["Nigel T."]), "Host");
  assert.equal(speakerRole("Delaney Howell", ["Brian Smith", " "]), "Guest");
  assert.equal(speakerRole("Pete", []), "Guest");
  // Pete talks for 4 s, Nigel for 0.8 s (too short for a card), Pete again, then Speaker 3 (unnamed).
  const ws = [...words("a b c d e f g h i j", "Pete", 0), ...words("k l", "Nigel", 4.2), ...words("m n o p q r", "Pete", 5.2), ...words("s t u v", "Speaker 3", 8)];
  const cards = nameCards(ws, ["Nigel"]);
  assert.deepEqual(
    cards.map((c) => [c.name, c.role, c.start, +c.end.toFixed(2)]),
    // Pete's card once; coming back after Nigel's short turn doesn't bring it back.
    [["Pete", "Guest", 0, CARD_HOLD]],
  );
  // Nigel's first turn was too short for a card; his next, longer one gets it.
  const later = nameCards([...words("k l", "Nigel", 0), ...words("a b c d e f", "Pete", 1), ...words("m n o p q r", "Nigel", 4)], ["Nigel"]);
  assert.deepEqual(
    later.map((c) => [c.name, c.role, c.start]),
    [
      ["Pete", "Guest", 1],
      ["Nigel", "Host", 4],
    ],
  );
  // Slides in, holds, slides out.
  const card = cards[0]!;
  assert.equal(cardIn(card, -0.1), 0);
  assert.equal(cardIn(card, 1.5), 1);
  assert.equal(cardIn(card, card.end), 0);
  assert.deepEqual(nameCards([], ["Nigel"]), []);
});

test("pull quote in the video: its words by index, a moment around them, words landing, keywords", () => {
  const ws = words("So the thing is we're not tech-averse at all").map((w, i) => ({ ...w, index: 100 + i }));
  const quote = quoteWords(ws, { firstWord: 104, lastWord: 106 });
  assert.deepEqual(
    quote.map((w) => w.text),
    ["we're", "not", "tech-averse"],
  );
  assert.deepEqual(quoteWords(ws, null), []);
  // Captions without indexes (made by hand) have no quote.
  assert.deepEqual(quoteWords(words("we're not tech-averse"), { firstWord: 0, lastWord: 2 }), []);
  const first = quote[0]!.start, last = quote.at(-1)!.end;
  assert.equal(quoteMoment(quote, first - QUOTE_LEAD), 0);
  assert.equal(quoteMoment(quote, first), 1);
  assert.equal(quoteMoment(quote, last + QUOTE_HOLD), 1);
  assert.equal(quoteMoment(quote, last + QUOTE_HOLD + 1), 0);
  assert.equal(quoteMoment([], 1), 0);
  assert.deepEqual(stamp(quote[0]!, first - 0.1), { alpha: 0, scale: 1.6 });
  assert.deepEqual(stamp(quote[0]!, first + 0.25), { alpha: 1, scale: 1 });
  assert.equal(isKeyword({ ...quote[2]!, text: "Tech-averse." }, ["tech-averse"]), true);
  assert.equal(isKeyword(quote[0]!, ["tech-averse"]), false);
  assert.equal(isKeyword(quote[0]!, []), false);
});

test("translated captions in a clip: its cues from the clip's start, cut to fit; the video's own words per language", () => {
  const cues = [
    { start: 8, end: 10.1, lines: ["Antes del clip."] },
    { start: 10.4, end: 12, lines: ["Primera línea."] },
    { start: 12.1, end: 15, lines: ["- Y yo le decía,", "- Sí."] },
    { start: 19.9, end: 22, lines: ["Casi fuera."] },
  ];
  assert.deepEqual(clipCues(cues, { start: 10, end: 20 }), [
    { start: 0.4, end: 2, lines: ["Primera línea."] },
    { start: 2.1, end: 5, lines: ["- Y yo le decía,", "- Sí."] },
  ]);
  assert.equal(videoStrings(null).fullEpisodeOn, "Full episode on");
  assert.equal(videoStrings("es").guest, "Invitado");
  assert.equal(videoStrings("de").host, "Moderation");
  assert.equal(outroLines("LOL a Podcast", "", videoStrings("fr")).above, "Épisode complet sur");
  assert.equal(clipVideoName("Episode 386", 2, "Tools", "vertical", "Spanish"), "Episode 386 - Clip 2 - Tools (vertical, Spanish).mp4");
  assert.equal(clipVideoName("Episode 386", 2, "Tools", "square"), "Episode 386 - Clip 2 - Tools (square).mp4");
  assert.deepEqual(DEFAULT_SETTINGS.video.languages, { es: false, pt: false, fr: false, de: false, zh: false });
});

test("Chinese captions: a token per character, Latin words whole, punctuation never starting a line", () => {
  assert.equal(isCjkText("我们不排斥技术。"), true);
  assert.equal(isCjkText("We're not tech-averse."), false);
  const toks = cjkTokens("我和 Delaney 聊了 2019 年，很开心。");
  assert.deepEqual(toks, ["我", "和 ", "Delaney ", "聊", "了 ", "2019 ", "年，", "很", "开", "心。"]);
  assert.equal(toks.join(""), "我和 Delaney 聊了 2019 年，很开心。");
  // Lines break between tokens, joined with no space; "年，" stays together so "，" doesn't start a line.
  const ws = toks.map((text, i) => ({ text, start: i, end: i + 0.5, speaker: "Delaney" }));
  const lines = breakLines(ws, (t) => [...t].length * 10, 60, "");
  assert.ok(lines.every((l) => !/^[，。]/.test(l.words[0]!.text)));
  assert.equal(lines.map((l) => l.words.map((w) => w.text).join("")).join(""), toks.join(""));
  assert.ok(lines.length > 1);
});
