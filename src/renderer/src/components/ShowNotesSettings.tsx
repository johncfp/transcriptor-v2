import { useEffect, useState } from "react";
import { EFFORTS, EFFORT_LABELS, PROVIDERS, providerById, type Effort, type ModelOption } from "../../../shared/providers";
import type { Settings, SettingsPatch } from "../../../shared/settings";
import { SECTIONS, SECTION_IDS, TEMPLATES, templateSections, type SectionId } from "../../../shared/showNotes";
import { Section } from "./Section";

const cleanError = (err: unknown) =>
  String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** "Other…" in the model list: type a model name instead. */
const OTHER = ":other";

type ModelList = { state: "loading" } | { state: "ready"; models: ModelOption[] } | { state: "error"; message: string };

/** Which provider, model and effort level write the notes. */
export function ShowNotesSettings({ settings, update }: { settings: Settings; update: (p: SettingsPatch) => void }) {
  const { writing } = settings;
  const provider = providerById(writing.provider);
  const defaultModel = provider?.defaultModel ?? "";
  const [model, setModel] = useState(writing.model);
  const [baseUrl, setBaseUrl] = useState(writing.baseUrl);
  const [typing, setTyping] = useState(false);
  const [list, setList] = useState<ModelList>({ state: "loading" });
  const [reload, setReload] = useState(0);
  useEffect(() => setModel(writing.model), [writing.model]);
  useEffect(() => setBaseUrl(writing.baseUrl), [writing.baseUrl]);

  // The provider's live model list, so new models show up without an app update.
  useEffect(() => {
    let live = true;
    setList({ state: "loading" });
    window.api.listModels(writing.provider).then(
      (models) => live && setList({ state: "ready", models }),
      (err) => live && setList({ state: "error", message: cleanError(err) }),
    );
    return () => {
      live = false;
    };
  }, [writing.provider, reload]);

  const models = list.state === "ready" ? list.models : [];
  const listed = (id: string) => models.some((m) => m.id === id);
  const current = writing.model || defaultModel;
  // Levels the chosen model takes, when its provider says; otherwise all of them.
  const efforts: readonly Effort[] = models.find((m) => m.id === current)?.efforts ?? EFFORTS;
  const showList = list.state === "ready" && models.length > 0 && !typing;

  const chooseModel = (next: string) => {
    const nextEfforts = models.find((m) => m.id === (next || defaultModel))?.efforts;
    // A level the new model doesn't take goes back to Auto.
    const effort = writing.effort && nextEfforts && !nextEfforts.includes(writing.effort) ? "" : writing.effort;
    update({ writing: { ...writing, model: next, effort } });
  };

  return (
    <Section
      title="Show notes"
      intro="Written from the reviewed transcript. Guest details are checked with a web search, and quotes are checked word for word against the transcript."
    >
      <div className="row">
        <div className="row-label">
          <span>Writing provider</span>
          <span className="hint">Add its key on the API keys tab.</span>
        </div>
        <select
          className="input select"
          value={writing.provider}
          onChange={(e) => {
            setTyping(false);
            update({ writing: { ...writing, provider: e.target.value, model: "", baseUrl: "", effort: "" } });
          }}
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
          <span className={`hint${list.state === "error" ? " error" : ""}`}>
            {list.state === "loading"
              ? `Loading ${provider?.label ?? ""}'s models…`
              : list.state === "error"
                ? `${list.message} You can still type a model name.`
                : showList
                  ? `Listed live from ${provider?.label ?? "the provider"}, so new models appear here.`
                  : "Type the model's name, as the provider writes it. Blank uses the default."}
          </span>
        </div>
        <div className="row-control model-control">
          {showList ? (
            <select
              className="input select"
              aria-label="Model"
              value={writing.model === "" ? "" : listed(writing.model) ? writing.model : `custom:${writing.model}`}
              onChange={(e) => (e.target.value === OTHER ? setTyping(true) : chooseModel(e.target.value.replace(/^custom:/, "")))}
            >
              <option value="">
                Default ({models.find((m) => m.id === defaultModel)?.label ?? defaultModel})
              </option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label === m.id ? m.id : `${m.label} (${m.id})`}
                </option>
              ))}
              {writing.model && !listed(writing.model) && <option value={`custom:${writing.model}`}>{writing.model}</option>}
              <option value={OTHER}>Other…</option>
            </select>
          ) : (
            <input
              className="input"
              aria-label="Model"
              value={model}
              placeholder={defaultModel}
              onChange={(e) => setModel(e.target.value)}
              onBlur={() => model.trim() !== writing.model && chooseModel(model.trim())}
              onKeyDown={(e) => e.key === "Enter" && model.trim() !== writing.model && chooseModel(model.trim())}
            />
          )}
          {typing && models.length > 0 ? (
            <button className="button ghost" onClick={() => setTyping(false)}>
              Show list
            </button>
          ) : list.state === "error" ? (
            <button className="button ghost" onClick={() => setReload((n) => n + 1)}>
              Try again
            </button>
          ) : null}
        </div>
      </div>
      {provider?.effort && (
        <div className="row">
          <div className="row-label">
            <span>Effort</span>
            <span className="hint">
              How much the model thinks before writing. Higher is more thorough but slower and costs more. Auto uses the
              model's own default.
            </span>
          </div>
          <div className="row-control">
            <select
              className="input select"
              aria-label="Effort"
              value={writing.effort}
              onChange={(e) => update({ writing: { ...writing, effort: e.target.value as "" | Effort } })}
            >
              <option value="">Auto</option>
              {EFFORTS.filter((e) => efforts.includes(e) || e === writing.effort).map((e) => (
                <option key={e} value={e}>
                  {EFFORT_LABELS[e]}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
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

    </Section>
  );
}

/** Which sections the show notes have, in order; custom templates can be shared as files. */
export function ShowNotesTemplateSection({ settings, update }: { settings: Settings; update: (p: SettingsPatch) => void }) {
  const { template } = settings;
  const [message, setMessage] = useState("");
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
    <Section title="Show notes template" intro="Which sections the show notes have, in order.">
      <div className="row">
        <div className="row-label">
          <span>Template</span>
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
        <button
          className="button ghost"
          onClick={async () => {
            setMessage("");
            if (await window.api.saveSampleTemplate()) setMessage("Sample saved. Edit its sections, then import it.");
          }}
        >
          Save sample template…
        </button>
        {message && <span className="hint">{message}</span>}
      </div>
    </Section>
  );
}
