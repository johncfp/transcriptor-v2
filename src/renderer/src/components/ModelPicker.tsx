import { useEffect, useState } from "react";
import { EFFORTS, EFFORT_LABELS, PROVIDERS, providerById, type Effort, type ModelOption } from "../../../shared/providers";
import type { ModelChoice } from "../../../shared/settings";

const cleanError = (err: unknown) =>
  String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** "Other…" in the model list: type a model name instead (not for Claude, whose list is complete). */
const OTHER = ":other";

type ModelList = { state: "loading" } | { state: "ready"; models: ModelOption[] } | { state: "error"; message: string };

/**
 * Provider, model, effort and (for Kimi and Qwen) API address rows for a
 * writing step. `defaultModel` is what a blank model means for this step;
 * `purpose` finishes "… can't …" when a Claude model lacks what the step needs.
 */
export function ModelPicker({
  value,
  onChange,
  defaultModel: defaultFor,
  purpose,
}: {
  value: ModelChoice;
  onChange: (next: ModelChoice) => void;
  defaultModel?: (provider: string) => string;
  purpose: string;
}) {
  const provider = providerById(value.provider);
  const defaultModel = defaultFor ? defaultFor(value.provider) : (provider?.defaultModel ?? "");
  const [model, setModel] = useState(value.model);
  const [baseUrl, setBaseUrl] = useState(value.baseUrl);
  const [typing, setTyping] = useState(false);
  const [list, setList] = useState<ModelList>({ state: "loading" });
  const [reload, setReload] = useState(0);
  const [problem, setProblem] = useState("");
  useEffect(() => setModel(value.model), [value.model]);
  useEffect(() => setBaseUrl(value.baseUrl), [value.baseUrl]);

  // The provider's live model list, so new models show up without an app update.
  useEffect(() => {
    let live = true;
    setList({ state: "loading" });
    window.api.listModels(value.provider).then(
      (models) => live && setList({ state: "ready", models }),
      (err) => live && setList({ state: "error", message: cleanError(err) }),
    );
    return () => {
      live = false;
    };
  }, [value.provider, reload]);

  const all = list.state === "ready" ? list.models : [];
  const models = all.filter((m) => m.usable);
  const listed = (id: string) => models.some((m) => m.id === id);
  const current = value.model || defaultModel;
  // Levels the chosen model takes, when its provider says; otherwise all of them.
  const efforts: readonly Effort[] = all.find((m) => m.id === current)?.efforts ?? EFFORTS;
  const showList = list.state === "ready" && models.length > 0 && !typing;
  // Claude lists every model the key can use, so there's nothing else to type.
  const canType = value.provider !== "anthropic";

  /** Why a model name can't be used, or "" if it can (or the list couldn't be loaded to check). */
  const whyNot = (id: string): string => {
    if (!id || list.state !== "ready") return "";
    const found = all.find((m) => m.id === id);
    if (!found) return `${provider?.label ?? "The provider"} doesn't list a model called “${id}”.`;
    if (!found.usable && value.provider === "anthropic") {
      return `${found.label} can't ${purpose}: it doesn't have the thinking and structured output needed.`;
    }
    return "";
  };
  const savedProblem = whyNot(value.model);
  const commitTyped = () => {
    const next = model.trim();
    if (next === value.model) return;
    const why = whyNot(next);
    setProblem(why);
    if (why) return;
    chooseModel(next);
    setTyping(false);
  };

  const chooseModel = (next: string) => {
    const nextEfforts = models.find((m) => m.id === (next || defaultModel))?.efforts;
    // A level the new model doesn't take goes back to Auto.
    const effort = value.effort && nextEfforts && !nextEfforts.includes(value.effort) ? "" : value.effort;
    onChange({ ...value, model: next, effort });
  };

  return (
    <>
      <div className="row">
        <div className="row-label">
          <span>Writing provider</span>
          <span className="hint">Add its key on the API keys tab.</span>
        </div>
        <select
          className="input select"
          aria-label="Writing provider"
          value={value.provider}
          onChange={(e) => {
            setTyping(false);
            setProblem("");
            onChange({ ...value, provider: e.target.value, model: "", baseUrl: "", effort: "" });
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
          <span className={`hint${list.state === "error" || problem || savedProblem ? " error" : ""}`}>
            {problem || savedProblem
              ? `${problem || savedProblem} Choose one from the list${canType ? " or check the name" : ""}.`
              : list.state === "loading"
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
              value={value.model === "" ? "" : listed(value.model) ? value.model : `custom:${value.model}`}
              onChange={(e) => {
                setProblem("");
                if (e.target.value === OTHER) setTyping(true);
                else chooseModel(e.target.value.replace(/^custom:/, ""));
              }}
            >
              <option value="">Default ({models.find((m) => m.id === defaultModel)?.label ?? defaultModel})</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label === m.id ? m.id : `${m.label} (${m.id})`}
                </option>
              ))}
              {value.model && !listed(value.model) && (
                <option value={`custom:${value.model}`}>
                  {value.model}
                  {savedProblem ? " (not available)" : ""}
                </option>
              )}
              {canType && <option value={OTHER}>Other…</option>}
            </select>
          ) : (
            <input
              className="input"
              aria-label="Model"
              value={model}
              placeholder={defaultModel}
              // Nothing to check a typed name against until the list has loaded (or failed to).
              disabled={list.state === "loading"}
              onChange={(e) => {
                setModel(e.target.value);
                setProblem("");
              }}
              onBlur={commitTyped}
              onKeyDown={(e) => e.key === "Enter" && commitTyped()}
            />
          )}
          {typing && models.length > 0 ? (
            <button
              className="button ghost"
              onClick={() => {
                // Keep any "doesn't list" message: the typed name wasn't saved.
                setTyping(false);
                setModel(value.model);
              }}
            >
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
              value={value.effort}
              onChange={(e) => onChange({ ...value, effort: e.target.value as "" | Effort })}
            >
              <option value="">Auto</option>
              {EFFORTS.filter((e) => efforts.includes(e) || e === value.effort).map((e) => (
                <option key={e} value={e}>
                  {EFFORT_LABELS[e]}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
      {(value.provider === "qwen" || value.provider === "moonshot") && (
        <div className="row">
          <div className="row-label">
            <span>API address</span>
            <span className="hint">
              {value.provider === "qwen"
                ? "Qwen's address depends on your Alibaba Cloud region and workspace. Blank uses the international endpoint."
                : "Blank uses Kimi's standard endpoint."}
            </span>
          </div>
          <input
            className="input"
            value={baseUrl}
            placeholder="https://…/v1"
            onChange={(e) => setBaseUrl(e.target.value)}
            onBlur={() => baseUrl !== value.baseUrl && onChange({ ...value, baseUrl: baseUrl.trim() })}
          />
        </div>
      )}
    </>
  );
}
