import { clampThresholds, DEFAULT_CONFIDENCE_THRESHOLDS } from "../../../shared/confidence";
import type { Settings, SettingsPatch } from "../../../shared/settings";
import { Section } from "./Section";

const pct = (n: number) => `${Math.round(n * 100)}%`;

/**
 * Where a word gets a low- or medium-confidence color, as in Transcriptor 1.
 * The two sliders stay ordered so the medium band can't invert.
 */
export function ConfidenceBandsSection({ settings, update }: { settings: Settings; update: (p: SettingsPatch) => void }) {
  const { lowMax, mediumMax } = clampThresholds(settings.confidence);
  const isDefault =
    lowMax === DEFAULT_CONFIDENCE_THRESHOLDS.lowMax && mediumMax === DEFAULT_CONFIDENCE_THRESHOLDS.mediumMax;

  return (
    <Section
      title="Confidence bands"
      intro="Where a word gets a low- or medium-confidence color, in review and in the exported Word transcript. ElevenLabs reports a confidence for every word."
    >
      <Slider
        label="Low below"
        tone="conf-low"
        value={lowMax}
        onChange={(v) => update({ confidence: { lowMax: v, mediumMax: Math.max(v, mediumMax) } })}
      />
      <Slider
        label="High at or above"
        tone="conf-medium"
        value={mediumMax}
        onChange={(v) => update({ confidence: { lowMax: Math.min(v, lowMax), mediumMax: v } })}
      />
      <p className="hint band-summary">
        <span className="conf-low">{pct(lowMax)}</span>–<span className="conf-medium">{pct(mediumMax)}</span> is tagged
        medium; anything higher is trusted with no color.
        {!isDefault && (
          <button className="button ghost reset" onClick={() => update({ confidence: { ...DEFAULT_CONFIDENCE_THRESHOLDS } })}>
            Reset
          </button>
        )}
      </p>
    </Section>
  );
}

function Slider(props: { label: string; tone: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="slider">
      <span className="slider-head">
        <span>{props.label}</span>
        <span className={`slider-value ${props.tone}`}>{pct(props.value)}</span>
      </span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(props.value * 100)}
        onChange={(e) => props.onChange(Number(e.target.value) / 100)}
      />
    </label>
  );
}
