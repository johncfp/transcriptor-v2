import { isSectionId, type SectionId } from "../shared/showNotes";

/**
 * A custom show-notes template as a file, so a team can share one format:
 * { "type": "transcriptor2-template", "version": 1, "sections": [...] }.
 */
export function templateFile(sections: unknown) {
  const valid = Array.isArray(sections) ? sections.filter((s): s is SectionId => typeof s === "string" && isSectionId(s)) : [];
  return { type: "transcriptor2-template", version: 1, sections: valid };
}

/** Parse a template file; throws a readable error if it isn't one. */
export function readTemplateFile(text: string): SectionId[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't a Transcriptor 2 template.");
  }
  const d = data as { type?: unknown; sections?: unknown };
  if (d?.type !== "transcriptor2-template" || !Array.isArray(d.sections)) {
    throw new Error("That file isn't a Transcriptor 2 template.");
  }
  const sections = d.sections.filter((s): s is SectionId => typeof s === "string" && isSectionId(s));
  if (!sections.length) throw new Error("That template has no sections this version knows about.");
  return [...new Set(sections)];
}
