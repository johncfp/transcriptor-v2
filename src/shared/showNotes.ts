// Show notes and the per-episode reference file: what the AI step produces
// (after code has checked it), the templates that pick and order sections,
// and a small document model that every output format renders from (the
// in-app preview, Markdown, plain text, and DOCX in M4).

import { formatTimestamp } from "./transcript";

// ---------------------------------------------------------------------------
// Inputs

/** Filled in per episode. Anything blank is left out of the notes, never invented. */
export interface EpisodeDetails {
  episodeNumber: string;
  /** Blank = use the AI's suggested title. */
  title: string;
  /** One sponsor read per line, used word for word. */
  sponsors: string;
  nextWeek: string;
}

export const EMPTY_DETAILS: EpisodeDetails = { episodeNumber: "", title: "", sponsors: "", nextWeek: "" };

/** "Ep 386 - Pete.m4a", "episode_386.wav" → "386". */
export function episodeNumberFromFileName(name: string): string {
  // Not \b: "_" counts as a word character, so "episode_12_final" would miss.
  return name.match(/(?<![a-z])ep(?:isode)?[\s._#-]*(\d{1,5})(?!\d)/i)?.[1] ?? "";
}

// ---------------------------------------------------------------------------
// Outputs (as checked by code; see src/shared/verify.ts)

export interface Quote {
  speaker: string;
  text: string;
  /** Seconds; taken from the transcript, not from the AI. */
  time: number;
}

export interface SourcedFact {
  fact: string;
  /** Web pages that support it. Empty = not confirmed. */
  sources: string[];
}

export interface GuestResearch {
  guestName: string;
  /** False when the lookup couldn't be sure it found the right person. */
  identified: boolean;
  facts: SourcedFact[];
  links: { label: string; url: string }[];
  /** True when the provider doesn't return its search sources (Kimi, Qwen). */
  sourcesUnavailable: boolean;
}

export interface NotesContent {
  titleSuggestion: string;
  summary: string;
  aboutGuest: string;
  timestamps: { time: number; label: string }[];
  topics: { title: string; points: string[] }[];
  quotes: Quote[];
  rapidFire: { question: string; answer: string }[];
  takeaways: string[];
  resources: string[];
}

export interface ReferenceContent {
  topics: string[];
  /** At most five. */
  keywords: string[];
  highNotes: string[];
  quotes: Quote[];
  frameworks: { name: string; description: string }[];
}

/** What code dropped from the AI's draft, shown to the reviewer. */
export interface WritingChecks {
  quotesDropped: string[];
  timestampsDropped: number;
  linksDropped: number;
}

/** Saved as `episodes/<id>/writing.json`. */
export interface WritingResult {
  version: 1;
  provider: string;
  model: string;
  /** Voice preset used (src/shared/voices.ts); missing on notes from before voices existed. */
  voice?: string;
  generatedAt: string;
  details: EpisodeDetails;
  host: string[];
  guest: string | null;
  runtimeSec: number;
  notes: NotesContent;
  reference: ReferenceContent;
  research: GuestResearch | null;
  checks: WritingChecks;
}

// ---------------------------------------------------------------------------
// Templates

export const SECTIONS = {
  header: "Show and episode title",
  meta: "Runtime, host and guest",
  summary: "Episode summary",
  aboutGuest: "About the guest",
  timestamps: "Timestamps",
  topics: "Key topics and talking points",
  quotes: "Memorable quotes",
  rapidFire: "Rapid-fire round",
  takeaways: "Takeaways",
  resources: "Resources mentioned",
  connectGuest: "Connect with the guest",
  connectShow: "Connect with the show",
  sponsors: "Sponsor spots",
  signOff: "Sign-off and next week",
} as const;

export type SectionId = keyof typeof SECTIONS;
export const SECTION_IDS = Object.keys(SECTIONS) as SectionId[];
export const isSectionId = (s: string): s is SectionId => s in SECTIONS;

export const TEMPLATES: { id: string; name: string; sections: SectionId[] }[] = [
  { id: "full", name: "Full", sections: SECTION_IDS },
  {
    id: "standard",
    name: "Standard",
    sections: ["header", "meta", "summary", "aboutGuest", "timestamps", "topics", "quotes", "takeaways", "connectGuest", "connectShow", "signOff"],
  },
  { id: "minimal", name: "Minimal", sections: ["header", "summary", "timestamps", "connectGuest", "connectShow"] },
];

/** The sections for a template setting; "custom" uses the list from Settings. */
export function templateSections(template: string, custom: string[]): SectionId[] {
  if (template === "custom") return custom.filter(isSectionId);
  return (TEMPLATES.find((t) => t.id === template) ?? TEMPLATES[0]!).sections;
}

// ---------------------------------------------------------------------------
// Document model

export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** Hex "RRGGBB"; used by DOCX only (confidence colors in transcripts). */
  color?: string;
}

export type Block =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; runs: Run[] }
  | { type: "list"; ordered: boolean; items: Run[][] }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "quote"; text: string; attribution: string }
  | { type: "rule" };

const p = (...runs: (Run | string)[]): Block => ({
  type: "paragraph",
  runs: runs.map((r) => (typeof r === "string" ? { text: r } : r)),
});
const bold = (text: string): Run => ({ text, bold: true });

export interface ShowProfileLike {
  name: string;
  website: string;
  email: string;
  signOff: string;
}

/** Build the show notes from a checked result, in the template's section order. */
export function buildShowNotes(result: WritingResult, show: ShowProfileLike, sections: SectionId[]): Block[] {
  const { notes, details, research } = result;
  const title = details.title.trim() || notes.titleSuggestion;
  const guest = result.guest;
  const out: Block[] = [];
  const section = (heading: string, blocks: Block[]) => {
    if (!blocks.length) return;
    if (out.length) out.push({ type: "rule" });
    out.push({ type: "heading", level: 3, text: heading }, ...blocks);
  };

  for (const id of sections) {
    switch (id) {
      case "header": {
        if (show.name) out.push({ type: "heading", level: 1, text: show.name });
        const ep = details.episodeNumber.trim();
        out.push({ type: "heading", level: 2, text: ep ? `Episode ${ep}: ${title}` : title });
        break;
      }
      case "meta": {
        const lines: Block[] = [];
        const minutes = Math.max(1, Math.round(result.runtimeSec / 60));
        if (result.runtimeSec > 0) lines.push(p(bold("Runtime: "), `~${minutes} minute${minutes === 1 ? "" : "s"}`));
        if (result.host.length) lines.push(p(bold(result.host.length > 1 ? "Hosts: " : "Host: "), result.host.join(", ")));
        if (guest) lines.push(p(bold("Guest: "), guest));
        out.push(...lines);
        break;
      }
      case "summary":
        section("Episode Summary", notes.summary ? [p(notes.summary)] : []);
        break;
      case "aboutGuest":
        section("About the Guest", notes.aboutGuest ? [p(notes.aboutGuest)] : []);
        break;
      case "timestamps":
        if (notes.timestamps.length) {
          section("Timestamps", [
            { type: "table", header: ["Time", "Segment"], rows: notes.timestamps.map((t) => [formatTimestamp(t.time), t.label]) },
          ]);
        }
        break;
      case "topics":
        section(
          "Key Topics and Talking Points",
          notes.topics.flatMap((t, i) => [
            p(bold(`${i + 1}. ${t.title}`)),
            ...(t.points.length ? [{ type: "list", ordered: false, items: t.points.map((x) => [{ text: x }]) } as Block] : []),
          ]),
        );
        break;
      case "quotes":
        section(
          "Memorable Quotes",
          notes.quotes.map((q) => ({ type: "quote", text: q.text, attribution: q.speaker }) as Block),
        );
        break;
      case "rapidFire":
        if (notes.rapidFire.length) {
          section("Rapid-Fire Round", [
            { type: "list", ordered: false, items: notes.rapidFire.map((r) => [bold(`${r.question}: `), { text: r.answer }]) },
          ]);
        }
        break;
      case "takeaways":
        if (notes.takeaways.length) {
          section("Takeaways", [{ type: "list", ordered: true, items: notes.takeaways.map((t) => [{ text: t }]) }]);
        }
        break;
      case "resources":
        if (notes.resources.length) {
          section("Resources Mentioned", [{ type: "list", ordered: false, items: notes.resources.map((r) => [{ text: r }]) }]);
        }
        break;
      case "connectGuest": {
        const links = research?.links ?? [];
        if (guest && links.length) {
          section(`Connect with ${guest}`, [
            { type: "list", ordered: false, items: links.map((l) => [bold(`${l.label}: `), { text: l.url }]) },
          ]);
        }
        break;
      }
      case "connectShow": {
        const items: Run[][] = [];
        if (show.website) items.push([bold("Website: "), { text: show.website }]);
        if (show.email) items.push([bold("Email: "), { text: show.email }]);
        if (items.length) section("Connect with the Show", [{ type: "list", ordered: false, items }]);
        break;
      }
      case "sponsors": {
        const reads = details.sponsors.split("\n").map((s) => s.trim()).filter(Boolean);
        if (reads.length) section("Sponsors", [{ type: "list", ordered: false, items: reads.map((r) => [{ text: r }]) }]);
        break;
      }
      case "signOff": {
        const text = [show.signOff.trim(), details.nextWeek.trim() && `Next week: ${details.nextWeek.trim()}`]
          .filter(Boolean)
          .join(" ");
        if (text) {
          out.push({ type: "rule" }, { type: "paragraph", runs: [{ text, italic: true }] });
        }
        break;
      }
    }
  }
  return out;
}

/** The per-episode reference file for reusing the content later (courses, classes). */
export function buildReference(result: WritingResult, show: ShowProfileLike): Block[] {
  const { reference, research, details, notes } = result;
  const title = details.title.trim() || notes.titleSuggestion;
  const ep = details.episodeNumber.trim();
  const out: Block[] = [
    { type: "heading", level: 1, text: `Reference: ${ep ? `Episode ${ep}: ` : ""}${title}` },
  ];
  if (show.name || result.guest) {
    out.push(p([show.name, result.guest && `with ${result.guest}`].filter(Boolean).join(" ")));
  }
  const list = (heading: string, items: Run[][], ordered = false) => {
    if (items.length) out.push({ type: "heading", level: 2, text: heading }, { type: "list", ordered, items });
  };
  list("Topics", reference.topics.map((t) => [{ text: t }]));
  if (reference.keywords.length) out.push({ type: "heading", level: 2, text: "Keywords" }, p(reference.keywords.join(", ")));
  list("High Notes", reference.highNotes.map((h) => [{ text: h }]));
  if (reference.quotes.length) {
    out.push(
      { type: "heading", level: 2, text: "Quotes" },
      { type: "table", header: ["Time", "Speaker", "Quote"], rows: reference.quotes.map((q) => [formatTimestamp(q.time), q.speaker, q.text]) },
    );
  }
  list("Frameworks and Concepts", reference.frameworks.map((f) => [bold(`${f.name}: `), { text: f.description }]));

  if (research) {
    const facts = research.facts.map((f): Run[] => [
      { text: f.fact },
      f.sources.length ? { text: ` (${f.sources.join(", ")})`, italic: true } : { text: " (unconfirmed)", italic: true },
    ]);
    out.push({ type: "heading", level: 2, text: "Guest Research" });
    if (!research.identified) out.push(p({ text: `Couldn't confirm which ${research.guestName} this is; nothing below was used in the show notes.`, italic: true }));
    else if (research.sourcesUnavailable) out.push(p({ text: "This provider doesn't return its sources, so these facts are unconfirmed.", italic: true }));
    if (facts.length) out.push({ type: "list", ordered: false, items: facts });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plain renderers

const runsToMarkdown = (runs: Run[]) =>
  runs.map((r) => (r.bold ? `**${r.text.trim()}**${r.text.endsWith(" ") ? " " : ""}` : r.italic ? `*${r.text}*` : r.text)).join("");

export function toMarkdown(blocks: Block[]): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case "heading":
          return `${"#".repeat(b.level)} ${b.text}`;
        case "paragraph":
          return runsToMarkdown(b.runs);
        case "list":
          return b.items.map((item, i) => `${b.ordered ? `${i + 1}.` : "-"} ${runsToMarkdown(item)}`).join("\n");
        case "table":
          return [`| ${b.header.join(" | ")} |`, `|${b.header.map(() => "---").join("|")}|`, ...b.rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
        case "quote":
          return `> "${b.text}"\n> — ${b.attribution}`;
        case "rule":
          return "---";
      }
    })
    .join("\n\n");
}

export function toPlainText(blocks: Block[]): string {
  const runs = (rs: Run[]) => rs.map((r) => r.text).join("");
  return blocks
    .map((b) => {
      switch (b.type) {
        case "heading":
          return b.level === 1 ? b.text.toUpperCase() : b.text;
        case "paragraph":
          return runs(b.runs);
        case "list":
          return b.items.map((item, i) => `${b.ordered ? `${i + 1}.` : "•"} ${runs(item)}`).join("\n");
        case "table":
          return b.rows.map((r) => r.join("  ")).join("\n");
        case "quote":
          return `“${b.text}”\n  — ${b.attribution}`;
        case "rule":
          return "";
      }
    })
    .filter((s, i, all) => !(s === "" && all[i - 1] === ""))
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
