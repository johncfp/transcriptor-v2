import { SECTIONS, SECTION_IDS, TEMPLATES, isSectionId, type SectionId } from "../shared/showNotes";

/**
 * A custom show-notes template as a file, so a team can share one format:
 * { "type": "transcriptor2-template", "version": 1, "sections": [...] }.
 */
export function templateFile(sections: unknown) {
  const valid = Array.isArray(sections) ? sections.filter((s): s is SectionId => typeof s === "string" && isSectionId(s)) : [];
  return { type: "transcriptor2-template", version: 1, sections: valid };
}

/**
 * A starting point for a custom template: the Standard sections, plus notes
 * and the full list of section ids. Import ignores the extra fields.
 */
export function sampleTemplateFile() {
  const standard = TEMPLATES.find((t) => t.id === "standard")!.sections;
  return {
    ...templateFile(standard),
    about:
      "Sample Transcriptor 2 show-notes template. Edit \"sections\": list the section ids you want, in the order you want them, " +
      "then use Import template… in Settings > Show notes. Ids not listed are left out. The other fields are notes and can be deleted.",
    availableSections: Object.fromEntries(SECTION_IDS.map((id) => [id, SECTIONS[id]])),
  };
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
