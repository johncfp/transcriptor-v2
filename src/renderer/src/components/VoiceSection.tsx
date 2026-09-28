import type { Settings, SettingsPatch } from "../../../shared/settings";
import { VOICES, VOICE_IDS } from "../../../shared/voices";
import { Section } from "./Section";

/** The show-notes voice preset, with the exact instruction it adds. */
export function VoiceSection({ settings, update }: { settings: Settings; update: (p: SettingsPatch) => void }) {
  const current = settings.writing.voice;
  return (
    <Section
      title="Show notes voice"
      intro="How the show notes and reference file read. Every voice follows the same accuracy rules: quotes word for word, nothing added that isn't in the episode."
    >
      <div className="voice-options" role="radiogroup" aria-label="Show notes voice">
        {VOICE_IDS.map((id) => (
          <label key={id} className={`voice-option${current === id ? " selected" : ""}`}>
            <input
              type="radio"
              name="voice"
              checked={current === id}
              onChange={() => update({ writing: { ...settings.writing, voice: id } })}
            />
            <span>
              <strong>{VOICES[id].label}</strong>
              <span className="hint">{VOICES[id].description}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="hint">Instruction added for the {VOICES[current].label} voice:</p>
      <blockquote className="voice-prompt">{VOICES[current].prompt}</blockquote>
      <p className="hint">Applies to notes written from now on. Rewrite an episode's notes to use a different voice.</p>
    </Section>
  );
}
