import { useEffect, useState } from "react";
import { PROVIDERS, providerById } from "../../../shared/providers";
import type { Settings, SettingsPatch } from "../../../shared/settings";
import { SECTIONS, SECTION_IDS, TEMPLATES, templateSections, type SectionId } from "../../../shared/showNotes";
import { Section } from "./Section";

const cleanError = (err: unknown) =>
  String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

export function ShowNotesSettings({ settings, update }: { settings: Settings; update: (p: SettingsPatch) => void }) {
  const { writing, template } = settings;
  const [model, setModel] = useState(writing.model);
  const [baseUrl, setBaseUrl] = useState(writing.baseUrl);
  const [message, setMessage] = useState("");
  useEffect(() => setModel(writing.model), [writing.model]);
  useEffect(() => setBaseUrl(writing.baseUrl), [writing.baseUrl]);

  const sections = templateSections(template, settings.customSections);
  const custom = template === "custom";
  const setCustom = (next: SectionId[]) => update({ template: "custom", customSections: next });

  const move = (id: SectionId, by: -1 | 1) => {
    const list = [...sections];
    const i = list.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j]!, list[i]!];
    setCustom(list);
  };

  return (
    <Section
      title="Show notes"
      intro="Written from the reviewed transcript. Guest details are checked with a web search, and quotes are checked word for word against the transcript."
    >
      <div className="row">
        <div className="row-label">
          <span>Writing provider</span>
          <span className="hint">Add its key under API keys below.</span>
        </div>
        <select
          className="input select"
          value={writing.provider}
          onChange={(e) => update({ writing: { ...writing, provider: e.target.value, model: "", baseUrl: "" } })}
        >
          {PROVIDERS.filter((p) => p.role === "writing").map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <div className="row-label">
          <span>Model</span>
          <span className="hint">Leave blank for the default.</span>
        </div>
        <input
          className="input"
          value={model}
          placeholder={providerById(writing.provider)?.defaultModel ?? ""}
          onChange={(e) => setModel(e.target.value)}
          onBlur={() => model !== writing.model && update({ writing: { ...writing, model: model.trim() } })}
        />
      </div>
      {(writing.provider === "qwen" || writing.provider === "moonshot") && (
        <div className="row">
          <div className="row-label">
            <span>API address</span>
            <span className="hint">
              {writing.provider === "qwen"
                ? "Qwen's address depends on your Alibaba Cloud region and workspace. Blank uses the international endpoint."
                : "Blank uses Kimi's standard endpoint."}
            </span>
          </div>
          <input
            className="input"
            value={baseUrl}
            placeholder="https://…/v1"
            onChange={(e) => setBaseUrl(e.target.value)}
            onBlur={() => baseUrl !== writing.baseUrl && update({ writing: { ...writing, baseUrl: baseUrl.trim() } })}
          />
        </div>
      )}
      {(writing.provider === "qwen" || writing.provider === "moonshot") && (
        <p className="hint warn">
          This provider doesn't return the pages its web search used, so guest details it finds can't be confirmed and
          are left out of the notes. Claude or GPT can confirm them.
        </p>
      )}

      <div className="row">
        <div className="row-label">
          <span>Template</span>
          <span className="hint">Which sections the show notes have, in order.</span>
        </div>
        <div className="segmented" role="radiogroup" aria-label="Template">
          {[...TEMPLATES, { id: "custom", name: "Custom" }].map((t) => (
            <button
              key={t.id}
              role="radio"
              className="segment"
              aria-checked={template === t.id}
              onClick={() =>
                t.id === "custom"
                  ? setCustom(settings.customSections.length ? templateSections("custom", settings.customSections) : sections)
                  : update({ template: t.id })
              }
            >
              {t.name}
            </button>
          ))}
        </div>
      </div>

      <ul className="section-list" aria-label="Sections">
        {(custom ? [...sections, ...SECTION_IDS.filter((id) => !sections.includes(id))] : sections).map((id) => {
          const on = sections.includes(id);
          return (
            <li key={id} className={on ? "" : "off"}>
              {custom ? (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => setCustom(e.target.checked ? [...sections, id] : sections.filter((s) => s !== id))}
                  />
                  {SECTIONS[id]}
                </label>
              ) : (
                <span>{SECTIONS[id]}</span>
              )}
              {custom && on && (
                <span className="section-moves">
                  <button className="button ghost" aria-label={`Move ${SECTIONS[id]} up`} onClick={() => move(id, -1)}>
                    ↑
                  </button>
                  <button className="button ghost" aria-label={`Move ${SECTIONS[id]} down`} onClick={() => move(id, 1)}>
                    ↓
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {!custom && <p className="hint">Choose Custom to switch sections on or off and reorder them.</p>}

      <div className="key-form template-files">
        <button
          className="button"
          onClick={async () => {
            setMessage("");
            try {
              const imported = await window.api.importTemplate();
              if (imported) {
                setCustom(imported);
                setMessage("Template imported.");
              }
            } catch (err) {
              setMessage(cleanError(err));
            }
          }}
        >
          Import template…
        </button>
        <button
          className="button"
          onClick={async () => {
            setMessage("");
            if (await window.api.exportTemplate(sections)) setMessage("Template saved. Share the file with your team.");
          }}
        >
          Export template…
        </button>
        {message && <span className="hint">{message}</span>}
      </div>
    </Section>
  );
}
