import type { Settings, SettingsPatch } from "../../../shared/settings";
import { CUSTOM_VOICE_MAX, VOICES, VOICE_IDS } from "../../../shared/voices";
import { Section } from "./Section";

/** The show-notes voice: a preset, or the user's own instruction. */
export function VoiceSection({ settings, update }: { settings: Settings; update: (p: SettingsPatch) => void }) {
  const { writing } = settings;
  const current = writing.voice;
  const customEmpty = !writing.customVoice.trim();

  return (
    <Section
      title="Show notes voice"
      intro="How the show notes and reference file read. Every voice follows the same accuracy rules: quotes word for word, nothing added that isn't in the episode."
    >
      <div className="voice-options" role="radiogroup" aria-label="Show notes voice">
        {VOICE_IDS.map((id) => (
          <label key={id} className={`voice-option${current === id ? " selected" : ""}`}>
            <input type="radio" name="voice" checked={current === id} onChange={() => update({ writing: { ...writing, voice: id } })} />
            <span>
              <strong>{VOICES[id].label}</strong>
              <span className="hint">{VOICES[id].description}</span>
            </span>
          </label>
        ))}
      </div>

      {current === "custom" ? (
        <>
          <label className="field">
            <span>Your instruction</span>
            <textarea
              className="input"
              rows={6}
              maxLength={CUSTOM_VOICE_MAX}
              value={writing.customVoice}
              placeholder="e.g. Write like a friendly finance newsletter for small-business owners. Keep sentences short and lead with what the listener will learn."
              onChange={(e) => update({ writing: { ...writing, customVoice: e.target.value } })}
            />
          </label>
          <p className="hint">
            {writing.customVoice.length}/{CUSTOM_VOICE_MAX} characters.{" "}
            {customEmpty
              ? "While this is empty, the General voice is used."
              : "Describe tone, audience and emphasis. It's added after the accuracy rules, so it can't make the notes invent anything or change quotes."}
          </p>
        </>
      ) : (
        <>
          <p className="hint">Instruction added for the {VOICES[current].label} voice:</p>
          <blockquote className="voice-prompt">{VOICES[current].prompt}</blockquote>
        </>
      )}
      <p className="hint">Applies to notes written from now on. Rewrite an episode's notes to use a different voice.</p>
    </Section>
  );
}
