import type { Settings, SettingsPatch, VoiceChoice } from "../../../shared/settings";
import { CUSTOM_VOICE_MAX, SOCIAL_VOICES, VOICES, VOICE_IDS, type VoiceId } from "../../../shared/voices";
import { Section } from "./Section";

/** The show-notes voice: a preset, or the user's own instruction. */
export function VoiceSection({ settings, update }: { settings: Settings; update: (p: SettingsPatch) => void }) {
  const { writing } = settings;
  return (
    <VoicePicker
      title="Show notes voice"
      intro="How the show notes and reference file read. Every voice follows the same accuracy rules: quotes word for word, nothing added that isn't in the episode."
      name="voice"
      value={writing}
      onChange={(next) => update({ writing: { ...writing, ...next } })}
      describe={(id) => VOICES[id]}
      placeholder="e.g. Write like a friendly finance newsletter for small-business owners. Keep sentences short and lead with what the listener will learn."
      customHint="Describe tone, audience and emphasis. It's added after the accuracy rules, so it can't make the notes invent anything or change quotes."
      footer="Applies to notes written from now on. Rewrite an episode's notes to use a different voice."
    />
  );
}

/** The social captions' voice, chosen separately from the show notes'. */
export function SocialVoiceSection({ settings, update }: { settings: Settings; update: (p: SettingsPatch) => void }) {
  const { social } = settings;
  return (
    <VoicePicker
      className="col-left"
      title="Social voice"
      intro="How the clip captions read. Every voice follows the same accuracy rules: clip text word for word from the episode, nothing added that isn't in it."
      name="social-voice"
      value={social}
      onChange={(next) => update({ social: { ...social, ...next } })}
      describe={(id) => ({ label: VOICES[id].label, ...SOCIAL_VOICES[id] })}
      placeholder="e.g. Punchy and playful, for founders scrolling between meetings. Lead with the surprise, no more than two hashtags."
      customHint="Describe tone, audience and emphasis. It's added after the accuracy rules, so it can't make captions invent anything or change what was said."
      footer="Applies to clips suggested from now on."
    />
  );
}

function VoicePicker(props: {
  title: string;
  className?: string;
  intro: string;
  /** Radio group name; unique per picker. */
  name: string;
  value: VoiceChoice;
  onChange: (next: VoiceChoice) => void;
  describe: (id: Exclude<VoiceId, "custom">) => { label: string; description: string; prompt: string };
  placeholder: string;
  customHint: string;
  footer: string;
}) {
  const { value, onChange } = props;
  const current = value.voice;
  const customEmpty = !value.customVoice.trim();
  const preset = current === "custom" ? null : props.describe(current);

  return (
    <Section className={props.className} title={props.title} intro={props.intro}>
      <div className="voice-options" role="radiogroup" aria-label={props.title}>
        {VOICE_IDS.map((id) => (
          <label key={id} className={`voice-option${current === id ? " selected" : ""}`}>
            <input type="radio" name={props.name} checked={current === id} onChange={() => onChange({ ...value, voice: id })} />
            <span>
              <strong>{VOICES[id].label}</strong>
              <span className="hint">{id === "custom" ? VOICES.custom.description : props.describe(id).description}</span>
            </span>
          </label>
        ))}
      </div>

      {preset === null ? (
        <>
          <label className="field">
            <span>Your instruction</span>
            <textarea
              className="input"
              rows={6}
              maxLength={CUSTOM_VOICE_MAX}
              value={value.customVoice}
              placeholder={props.placeholder}
              onChange={(e) => onChange({ ...value, customVoice: e.target.value })}
            />
          </label>
          <p className="hint">
            {value.customVoice.length}/{CUSTOM_VOICE_MAX} characters.{" "}
            {customEmpty ? "While this is empty, the General voice is used." : props.customHint}
          </p>
        </>
      ) : (
        <>
          <p className="hint">Instruction added for the {preset.label} voice:</p>
          <blockquote className="voice-prompt">{preset.prompt}</blockquote>
        </>
      )}
      <p className="hint">{props.footer}</p>
    </Section>
  );
}
