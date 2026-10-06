import { useEffect, useState } from "react";
import type { Settings, SettingsPatch } from "../../../shared/settings";
import { CLIP_COUNT_RANGE, CLIP_SECONDS_RANGE, PLATFORMS, clipLimits, socialDefaultModel, type ClipLimits } from "../../../shared/social";
import { ModelPicker } from "./ModelPicker";
import { Section } from "./Section";

/** Whether social clips are suggested, by which model, how many, how long and for which platforms. */
export function SocialSettings({ settings, update }: { settings: Settings; update: (p: SettingsPatch) => void }) {
  const { social } = settings;
  const setLimits = (patch: Partial<ClipLimits>) => update({ social: { ...social, ...clipLimits({ ...social, ...patch }) } });
  const noPlatform = !PLATFORMS.some((p) => social.platforms[p.id]);

  return (
    <Section
      className="col-left"
      title="Social clips"
      intro="After the show notes, a model picks short moments from the transcript and writes a caption for each platform. You review the clips before they're cut as WAV files and exported. The clip text and times come from the transcript, never the model."
    >
      <label className="row toggle-row">
        <div className="row-label">
          <span>Suggest social clips</span>
          <span className="hint">Adds one model call per episode, after the show notes.</span>
        </div>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={social.enabled}
          onChange={(e) => update({ social: { ...social, enabled: e.target.checked } })}
        />
      </label>
      <ModelPicker
        value={social}
        onChange={(next) => update({ social: { ...social, ...next } })}
        defaultModel={socialDefaultModel}
        purpose="suggest social clips"
      />
      <div className="row">
        <div className="row-label">
          <span>Clips per episode</span>
          <span className="hint">The model suggests between these, fewer if the episode doesn't have enough good moments.</span>
        </div>
        <div className="row-control range-control">
          <NumberField label="Fewest clips" value={social.minClips} range={CLIP_COUNT_RANGE} onCommit={(n) => setLimits({ minClips: n })} />
          <span>to</span>
          <NumberField label="Most clips" value={social.maxClips} range={CLIP_COUNT_RANGE} onCommit={(n) => setLimits({ maxClips: n })} />
        </div>
      </div>
      <div className="row">
        <div className="row-label">
          <span>Clip length</span>
          <span className="hint">In seconds. Clips start and end on whole words, so lengths are approximate.</span>
        </div>
        <div className="row-control range-control">
          <NumberField label="Shortest clip" value={social.minSeconds} range={CLIP_SECONDS_RANGE} onCommit={(n) => setLimits({ minSeconds: n })} />
          <span>to</span>
          <NumberField label="Longest clip" value={social.maxSeconds} range={CLIP_SECONDS_RANGE} onCommit={(n) => setLimits({ maxSeconds: n })} />
        </div>
      </div>
      <div className="row">
        <div className="row-label">
          <span>Captions for</span>
          <span className={`hint${noPlatform ? " warn" : ""}`}>
            {noPlatform ? "Choose at least one platform, or the clips get no captions." : "Each clip gets a caption for every platform chosen."}
          </span>
        </div>
        <div className="checks two-col">
          {PLATFORMS.map((p) => (
            <label key={p.id} className="check" title={p.hint}>
              <input
                type="checkbox"
                checked={social.platforms[p.id]}
                onChange={(e) => update({ social: { ...social, platforms: { ...social.platforms, [p.id]: e.target.checked } } })}
              />
              {p.label}
            </label>
          ))}
        </div>
      </div>
    </Section>
  );
}

/** A whole number in a range, saved when the field loses focus or Enter is pressed. */
function NumberField(props: { label: string; value: number; range: { min: number; max: number }; onCommit: (n: number) => void }) {
  const [draft, setDraft] = useState(String(props.value));
  useEffect(() => setDraft(String(props.value)), [props.value]);
  const commit = () => {
    const n = Number(draft);
    // Not a number: put the saved value back.
    if (draft.trim() === "" || !Number.isFinite(n)) return setDraft(String(props.value));
    const inRange = Math.min(props.range.max, Math.max(props.range.min, Math.round(n)));
    setDraft(String(inRange));
    if (inRange !== props.value) props.onCommit(inRange);
  };
  return (
    <input
      className="input number-input"
      type="number"
      aria-label={props.label}
      min={props.range.min}
      max={props.range.max}
      step={1}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}
