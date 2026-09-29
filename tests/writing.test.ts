import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { cleanTranscript, defaultEdits, type EpisodeEdits } from "../src/shared/cleanup";
import { buildReference, buildShowNotes, episodeNumberFromFileName, toMarkdown, toPlainText, EMPTY_DETAILS } from "../src/shared/showNotes";
import type { Transcript, Word } from "../src/shared/transcript";
import {
  coerceDraft,
  normalizeUrl,
  parseTimestamp,
  transcriptForPrompt,
  verifyQuotes,
  verifyResearch,
  verifyTimestamps,
} from "../src/shared/verify";
import { startFakeAnthropic } from "../src/main/testing/fakeAnthropic";
import { castOf, writeEpisode } from "../src/main/writing";
import { anthropicWriter } from "../src/main/writing/anthropic";
import { kimiWriter, openaiWriter, parseLooseJson, readResponses } from "../src/main/writing/openai";
import { claudeEfforts, claudeUsable, listModels } from "../src/main/writing/models";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/shared/settings";

// A small two-person episode: host (speaker 0) then guest (speaker 1).
function episode(): { transcript: Transcript; edits: EpisodeEdits } {
  const script: [number, string][] = [
    [0, "Welcome to the show. Today my guest is Pete M."],
    [1, "Thanks for having me. If a tool saves me an hour but costs me the reason I started, that's not a win."],
    [0, "Tell me about the three buckets."],
    [1, "I sort every task into automate, assist, or do it yourself. Nobody has ever fallen in love with an optimized calendar."],
  ];
  const words: Word[] = [];
  let t = 0;
  for (const [speaker, text] of script) {
    for (const w of text.split(" ")) {
      words.push({ text: w, start: t, end: t + 0.4, speaker, confidence: 0.99 });
      t += 2; // spread out so the turns land at distinct times
    }
  }
  const transcript: Transcript = { version: 1, provider: "t", model: "t", speakerCount: 2, durationSec: t, words, createdAt: "" };
  const edits = defaultEdits({ repetitions: false }, 2);
  edits.speakerNames = ["Nigel T.", "Pete M."];
  return { transcript, edits };
}

const DRAFT = {
  title_suggestion: "Productivity and Love with Pete M.",
  summary: "Nigel talks with Pete M. about tools.",
  about_guest: "Pete M. hosts a podcast.",
  timestamps: [
    { time: "00:03", label: "Welcome" },
    { time: "99:00", label: "Past the end" },
    { time: "garbage", label: "Not a time" },
    { time: "00:44", label: "The three buckets" },
  ],
  topics: [{ title: "Tools", points: ["Automate, assist, do it yourself"] }],
  quotes: [
    { text: "If a tool saves me an hour but costs me the reason I started, that's not a win." },
    { text: "Nobody has ever fallen in love with an optimised calendar." }, // spelling changed: must drop
    { text: "costs me the reason I started. Tell me about the three buckets." }, // spans two turns: must drop
  ],
  rapid_fire: [],
  takeaways: ["Sort tasks into buckets."],
  resources: [],
  reference: {
    topics: ["Productivity"],
    keywords: ["ai", "tools", "love", "time", "work", "extra"],
    high_notes: ["Efficiency is a means."],
    quotes: [{ text: "nobody has ever fallen in love with an optimized calendar" }],
    frameworks: [{ name: "Three buckets", description: "Automate, assist, or do it yourself." }],
  },
};

test("quotes must match the transcript word for word within one turn", () => {
  const { transcript, edits } = episode();
  const turns = cleanTranscript(transcript, edits);
  const { quotes, dropped } = verifyQuotes(DRAFT.quotes, turns);
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0]!.speaker, "Pete M.");
  assert.equal(quotes[0]!.text, "If a tool saves me an hour but costs me the reason I started, that's not a win.");
  assert.equal(dropped.length, 2);

  // Case and punctuation don't matter, and the saved text is the transcript's.
  const loose = verifyQuotes([{ text: "nobody has ever fallen in love with an optimized calendar" }], turns);
  assert.equal(loose.quotes[0]!.text, "Nobody has ever fallen in love with an optimized calendar.");
});

test("timestamps: parsed, kept inside the episode, snapped to turns, ordered", () => {
  assert.equal(parseTimestamp("12:05"), 725);
  assert.equal(parseTimestamp("[1:02:05]"), 3725);
  assert.equal(parseTimestamp("12:75"), null);
  const { transcript, edits } = episode();
  const turns = cleanTranscript(transcript, edits);
  const { timestamps, dropped } = verifyTimestamps(DRAFT.timestamps, turns, transcript.durationSec!);
  assert.equal(dropped, 2);
  assert.deepEqual(
    timestamps.map((t) => t.label),
    ["Welcome", "The three buckets"],
  );
  assert.equal(timestamps[0]!.time, 0, "the first segment starts the episode");
  assert.ok(turns.some((t) => Math.floor(t.start) === timestamps[1]!.time), "snapped to a turn start");
});

test("research: only facts and links backed by pages the search returned", () => {
  const { research, linksDropped } = verifyResearch("Pete M.", {
    identified: true,
    facts: [
      { fact: "Hosts Making Life Easy is Hard.", source_urls: ["https://www.petem.example/about/"] },
      { fact: "Won an award.", source_urls: ["https://made-up.example/award"] },
    ],
    links: [
      { label: "Website", url: "https://petem.example/about" },
      { label: "Fake", url: "https://nowhere.example" },
    ],
    searchedUrls: ["https://petem.example/about?ref=search"],
  });
  assert.deepEqual(research.facts.map((f) => f.sources.length), [1, 0]);
  assert.deepEqual(research.links.map((l) => l.label), ["Website"]);
  assert.equal(linksDropped, 1);

  const noSources = verifyResearch("Pete M.", { identified: true, facts: [{ fact: "x", source_urls: ["https://a.example"] }], links: [], searchedUrls: null });
  assert.equal(noSources.research.sourcesUnavailable, true);
  assert.equal(noSources.research.facts[0]!.sources.length, 0, "nothing is confirmed without sources");

  const unsure = verifyResearch("Pete", { identified: false, facts: [{ fact: "x", source_urls: [] }], links: [], searchedUrls: [] });
  assert.equal(unsure.research.facts.length, 0);
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
});

test("drafts with missing or odd fields become empty, not errors", () => {
  const d = coerceDraft({ summary: 5, quotes: ["A quote here now", { text: "Another one here" }, null], reference: null });
  assert.equal(d.summary, "");
  assert.equal(d.quotes.length, 2);
  assert.deepEqual(d.reference.keywords, []);
});

test("cast: hosts from Settings, guest is whoever else talks most", () => {
  const { transcript, edits } = episode();
  assert.deepEqual(castOf(transcript, edits, ["Nigel T."]), { hosts: ["Nigel T."], guest: "Pete M." });
  const unnamed = defaultEdits({ repetitions: false }, 2);
  assert.deepEqual(castOf(transcript, unnamed, []), { hosts: [], guest: null }, "no guest research for 'Speaker 2'");
});

test("transcript prompt has time markers per turn", () => {
  const { transcript, edits } = episode();
  const text = transcriptForPrompt(cleanTranscript(transcript, edits));
  assert.match(text, /^\[00:00\] Nigel T\.: Welcome to the show\./);
  assert.match(text, /\n\[\d\d:\d\d\] Pete M\.: Thanks for having me\./);
});

test("episode number from the file name", () => {
  assert.equal(episodeNumberFromFileName("Ep 386 - Pete.m4a"), "386");
  assert.equal(episodeNumberFromFileName("episode_12_final.wav"), "12");
  assert.equal(episodeNumberFromFileName("BrianxDelaney_Export.m4a"), "");
});

test("end to end with the real Claude SDK against a local fake API", async () => {
  const fake = await startFakeAnthropic({
    draft: DRAFT,
    research: {
      searched: ["https://petem.example/about"],
      input: {
        identified: true,
        facts: [
          { fact: "Hosts Making Life Easy is Hard.", source_urls: ["https://petem.example/about"] },
          { fact: "Invented.", source_urls: ["https://made-up.example"] },
        ],
        links: [{ label: "Website", url: "https://petem.example/about" }],
      },
    },
  });
  try {
    const { transcript, edits } = episode();
    const stages: string[] = [];
    const result = await writeEpisode({
      transcript,
      edits,
      details: { ...EMPTY_DETAILS, episodeNumber: "386", sponsors: "CalmDesk: use code TEST386." },
      show: { name: "This Is A Test Show", hosts: ["Nigel T."] },
      voice: "seo",
      writer: anthropicWriter,
      call: { apiKey: "sk-ant-test", model: "claude-opus-5-5", baseUrl: fake.url, effort: "high" },
      onStage: (s) => stages.push(s),
    });

    // Two calls: research (with web search, strict tool, fallbacks) then the streamed draft.
    assert.equal(fake.requests.length, 2);
    const [research, draft] = fake.requests.map((r) => r.body);
    const tools = research!.tools as { type?: string; name: string; strict?: boolean }[];
    assert.ok(tools.some((t) => t.type === "web_search_20260209"));
    assert.ok(tools.some((t) => t.name === "record_guest_research" && t.strict === true));
    assert.equal(research!.fallbacks, "default");
    // Effort goes in output_config on both calls; the draft keeps its JSON schema alongside it.
    assert.deepEqual(research!.output_config, { effort: "high" });
    assert.equal((draft!.output_config as { effort: string }).effort, "high");
    assert.equal(draft!.fallbacks, "default");
    assert.equal(result.model, "claude-opus-5-5");
    assert.equal(result.effort, "high");
    assert.match(String(fake.requests[0]!.headers["anthropic-beta"]), /server-side-fallback-2026-07-01/);
    assert.equal(draft!.stream, true);
    // The voice comes after the accuracy rules, which are still there.
    const system = JSON.stringify(draft!.system);
    assert.ok(system.indexOf("Copy each one exactly") < system.indexOf("easy to find in search engines"));
    assert.equal(result.voice, "seo");
    assert.equal((draft!.output_config as { format: { type: string } }).format.type, "json_schema");
    assert.match(JSON.stringify(draft!.messages), /Hosts Making Life Easy is Hard/, "confirmed fact reaches the writer");
    assert.doesNotMatch(JSON.stringify(draft!.messages), /Invented/, "unconfirmed fact doesn't");

    assert.deepEqual(stages, ["Looking up Pete M.", "Writing show notes", "Checking quotes and timestamps"]);
    assert.equal(result.guest, "Pete M.");
    assert.equal(result.notes.quotes.length, 1);
    assert.equal(result.reference.keywords.length, 5);
    assert.equal(result.checks.quotesDropped.length, 2);
    assert.equal(result.research?.links.length, 1);

    const show = { name: "This Is A Test Show", website: "thisisatestshow.example.com", email: "", signOff: "Thanks for listening." };
    const md = toMarkdown(buildShowNotes(result, show, ["header", "meta", "quotes", "sponsors", "rapidFire", "connectGuest", "signOff"]));
    assert.match(md, /^# This Is A Test Show\n\n## Episode 386: Productivity and Love with Pete M\./);
    assert.match(md, /\*\*Guest:\*\* Pete M\./);
    assert.match(md, /> "If a tool saves me an hour/);
    assert.match(md, /CalmDesk: use code TEST386\./);
    assert.doesNotMatch(md, /Rapid-Fire/, "empty sections are left out");
    assert.match(md, /Connect with Pete M\.[\s\S]*https:\/\/petem\.example\/about/);
    assert.match(md, /\*Thanks for listening\.\*/);

    const ref = toPlainText(buildReference(result, show));
    assert.match(ref, /Keywords\n\nai, tools, love, time, work/);
    assert.match(ref, /Hosts Making Life Easy is Hard\. \(https:\/\/petem\.example\/about\)/);
    assert.match(ref, /Invented\. \(unconfirmed\)/);
  } finally {
    fake.close();
  }
});

test("a rejected Claude key becomes a readable error", async () => {
  const fake = await startFakeAnthropic({ draft: {}, status: 401 });
  try {
    await assert.rejects(
      anthropicWriter.draft({ apiKey: "bad", model: "claude-opus-5", baseUrl: fake.url }, { system: "s", user: "u" }),
      /Claude rejected the API key/,
    );
  } finally {
    fake.close();
  }
});

test("GPT: sources and citations are collected from a Responses API result", () => {
  const { text, urls } = readResponses({
    output: [
      { type: "web_search_call", action: { sources: [{ url: "https://a.example" }] } },
      {
        type: "message",
        content: [{ type: "output_text", text: '{"ok":true}', annotations: [{ type: "url_citation", url: "https://b.example" }] }],
      },
    ],
  });
  assert.equal(text, '{"ok":true}');
  assert.deepEqual(urls, ["https://a.example", "https://b.example"]);
  assert.deepEqual(parseLooseJson('Here you go:\n```json\n{"a":1}\n```', "X"), { a: 1 });
});

test("Kimi: $web_search arguments are echoed back, and sources are marked unavailable", async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      bodies.push(body);
      const first = bodies.length === 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            first
              ? {
                  finish_reason: "tool_calls",
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [{ id: "c1", type: "builtin_function", function: { name: "$web_search", arguments: '{"q":"Pete"}' } }],
                  },
                }
              : { finish_reason: "stop", message: { role: "assistant", content: '{"identified":true,"facts":[],"links":[]}' } },
          ],
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const raw = await kimiWriter.research({ apiKey: "k", model: "kimi-k3", baseUrl: url }, { system: "s", user: "u" });
    assert.equal(raw.searchedUrls, null);
    const echoed = (bodies[1]!.messages as { role: string; content: string; tool_call_id?: string }[]).at(-1)!;
    assert.deepEqual([echoed.role, echoed.tool_call_id, echoed.content], ["tool", "c1", '{"q":"Pete"}']);
  } finally {
    server.close();
  }
});

test("template files: round trip, unknown sections dropped, junk rejected", async () => {
  const { readTemplateFile, templateFile } = await import("../src/main/templateFile");
  const file = JSON.stringify(templateFile(["header", "summary", "bogus", "quotes"]));
  assert.deepEqual(readTemplateFile(file), ["header", "summary", "quotes"]);
  assert.throws(() => readTemplateFile("{}"), /isn't a Transcriptor 2 template/);
  assert.throws(() => readTemplateFile("not json"), /isn't a Transcriptor 2 template/);
});

test("the sample template imports as the Standard sections", async () => {
  const { readTemplateFile, sampleTemplateFile } = await import("../src/main/templateFile");
  const { TEMPLATES, SECTION_IDS } = await import("../src/shared/showNotes");
  const sample = sampleTemplateFile();
  assert.deepEqual(readTemplateFile(JSON.stringify(sample)), TEMPLATES.find((t) => t.id === "standard")!.sections);
  assert.deepEqual(Object.keys(sample.availableSections), SECTION_IDS);
});

test("Claude: Auto effort sends no effort at all", async () => {
  const fake = await startFakeAnthropic({ draft: {} });
  try {
    await anthropicWriter.research({ apiKey: "k", model: "claude-opus-5-5", baseUrl: fake.url }, { system: "s", user: "u" });
    await anthropicWriter.draft({ apiKey: "k", model: "claude-opus-5-5", baseUrl: fake.url }, { system: "s", user: "u" });
    const [research, draft] = fake.requests.map((r) => r.body);
    assert.equal(research!.output_config, undefined);
    assert.deepEqual(Object.keys(draft!.output_config as object), ["format"]);
  } finally {
    fake.close();
  }
});

test("GPT: effort goes in reasoning.effort on both calls, and only when set", async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      bodies.push(JSON.parse(body));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: '{"identified":false,"facts":[],"links":[]}' }] }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await openaiWriter.research({ apiKey: "k", model: "gpt-5.5", baseUrl: url, effort: "xhigh" }, { system: "s", user: "u" });
    await openaiWriter.draft({ apiKey: "k", model: "gpt-5.5", baseUrl: url, effort: "xhigh" }, { system: "s", user: "u" });
    await openaiWriter.draft({ apiKey: "k", model: "gpt-5.5", baseUrl: url }, { system: "s", user: "u" });
    assert.deepEqual(bodies[0]!.reasoning, { effort: "xhigh" });
    assert.deepEqual(bodies[1]!.reasoning, { effort: "xhigh" });
    assert.equal(bodies[2]!.reasoning, undefined);
  } finally {
    server.close();
  }
});

test("model list: Claude's usable models with their effort levels; a bad key is readable", async () => {
  const fake = await startFakeAnthropic({ draft: {} });
  try {
    const models = await listModels("anthropic", "k", fake.url);
    assert.deepEqual(
      models.map((m) => m.id),
      ["claude-opus-5-5", "claude-opus-5"],
      "newest first; Haiku 4.5 (no adaptive thinking) is left out",
    );
    assert.equal(models[0]!.label, "Claude Opus 5.5");
    assert.deepEqual(models[0]!.efforts, ["low", "medium", "high", "xhigh", "max"]);
  } finally {
    fake.close();
  }
  const bad = await startFakeAnthropic({ draft: {}, status: 401 });
  try {
    await assert.rejects(listModels("anthropic", "bad", bad.url), /Claude rejected the API key/);
  } finally {
    bad.close();
  }
});

test("model list: Claude capabilities are read defensively", () => {
  const level = (on: string[]) => Object.fromEntries(["low", "medium", "high", "xhigh", "max"].map((l) => [l, { supported: on.includes(l) }]));
  assert.equal(claudeEfforts(undefined), null, "not listed: unknown");
  assert.deepEqual(claudeEfforts({ effort: { supported: false } }), []);
  assert.deepEqual(claudeEfforts({ effort: { supported: true, ...level(["low", "medium", "high"]) } }), ["low", "medium", "high"]);
  assert.equal(claudeUsable(undefined), true);
  assert.equal(claudeUsable({ thinking: { types: { adaptive: { supported: true } } }, structured_outputs: { supported: false } }), false);
});

test("model list: GPT keeps text models, newest first; Kimi and Qwen list everything", async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer k");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        data: [
          { id: "gpt-5.5", created: 300 },
          { id: "gpt-6-astra", created: 400 },
          { id: "gpt-realtime", created: 500 },
          { id: "text-embedding-3-large", created: 100 },
          { id: "gpt-image-2", created: 450 },
          { id: "o4-mini", created: 200 },
        ],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const gpt = await listModels("openai", "k", url);
    assert.deepEqual(gpt.map((m) => m.id), ["gpt-6-astra", "gpt-5.5", "o4-mini"]);
    assert.equal(gpt[0]!.efforts, null, "GPT doesn't say which levels a model takes");
    assert.equal((await listModels("moonshot", "k", url)).length, 6);
  } finally {
    server.close();
  }
});

test("settings: effort must be a known level or blank", () => {
  const merged = (effort: string) => mergeSettings(DEFAULT_SETTINGS, { writing: { effort } }).writing.effort;
  assert.equal(DEFAULT_SETTINGS.writing.effort, "");
  assert.equal(merged("xhigh"), "xhigh");
  assert.equal(merged(""), "");
  assert.equal(merged("turbo"), "");
});
