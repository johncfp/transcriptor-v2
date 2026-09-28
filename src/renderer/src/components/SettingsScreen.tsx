import { useEffect, useState, type ReactNode } from "react";
import type { Settings, SettingsPatch } from "../../../shared/settings";
import { ApiKeysSection } from "./ApiKeysSection";
import { Section } from "./Section";

export function SettingsScreen() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [defaultFolder, setDefaultFolder] = useState("");

  useEffect(() => {
    void window.api.getSettings().then(setSettings);
    void window.api.defaultOutputFolder().then(setDefaultFolder);
  }, []);

  if (!settings) return null;

  const update = (patch: SettingsPatch) => {
    void window.api.updateSettings(patch).then(setSettings);
  };
  const { general, processing, output, show } = settings;

  return (
    <>
      <h1>Settings</h1>

      <Section title="General">
        <Toggle
          label="Start at login"
          hint="Transcriptor 2 opens quietly in the tray when you sign in."
          checked={general.startAtLogin}
          onChange={(v) => update({ general: { startAtLogin: v } })}
        />
        <Toggle
          label="Keep running when the window is closed"
          hint="Closing the window hides it to the tray so work in progress keeps going. Quit from the tray icon."
          checked={general.closeToTray}
          onChange={(v) => update({ general: { closeToTray: v } })}
        />
      </Section>

      <Section title="Processing">
        <Choice
          label="When a new file arrives"
          value={processing.intake}
          options={[
            { value: "approve", label: "Ask me before processing" },
            { value: "auto", label: "Start processing right away" },
          ]}
          onChange={(v) => update({ processing: { intake: v } })}
        />
        <Toggle
          label="Review the transcript before writing show notes"
          hint="Pause after transcription to fix speaker names and misheard words."
          checked={processing.reviewStep}
          onChange={(v) => update({ processing: { reviewStep: v } })}
        />
        <Toggle
          label="Remove false starts and repetitions"
          hint={`Filler words ("um", "uh") are always removed. This also cuts restarts like "I was, we went". Words are only ever removed, never changed.`}
          checked={processing.removeFalseStarts}
          onChange={(v) => update({ processing: { removeFalseStarts: v } })}
        />
      </Section>

      <Section title="Output">
        <Row label="Save files to" hint={output.folder ? undefined : "Default folder"}>
          <div className="folder">
            <code className="folder-path" title={output.folder || defaultFolder}>
              {output.folder || defaultFolder}
            </code>
            <button
              className="button"
              onClick={async () => {
                const picked = await window.api.pickFolder();
                if (picked) update({ output: { folder: picked } });
              }}
            >
              Choose…
            </button>
            {output.folder && (
              <button className="button ghost" onClick={() => update({ output: { folder: "" } })}>
                Use default
              </button>
            )}
          </div>
        </Row>
        <Row label="Formats" hint="Used as the default for each episode. You can change them per episode.">
          <div className="checks">
            <Check
              label="Word (.docx)"
              checked={output.formats.docx}
              onChange={(v) => update({ output: { formats: { ...output.formats, docx: v } } })}
            />
            <Check
              label="Plain text (.txt)"
              checked={output.formats.txt}
              onChange={(v) => update({ output: { formats: { ...output.formats, txt: v } } })}
            />
            <Check label="Google Doc (not set up yet)" checked={false} disabled onChange={() => {}} />
          </div>
        </Row>
      </Section>

      <Section
        title="Show profile"
        intro="Filled in once and used in every episode's show notes. Anything left blank is left out."
      >
        <TextField label="Show name" value={show.name} onCommit={(v) => update({ show: { name: v } })} />
        <TextField
          label="Host names"
          hint="Separate multiple hosts with commas. Also used to name speakers."
          value={show.hosts.join(", ")}
          onCommit={(v) =>
            update({
              show: {
                hosts: v
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              },
            })
          }
        />
        <TextField label="Website" value={show.website} onCommit={(v) => update({ show: { website: v } })} />
        <TextField label="Contact email" value={show.email} onCommit={(v) => update({ show: { email: v } })} />
        <TextField
          label="Sign-off line"
          hint="Closes the show notes, e.g. “Thanks for listening to …”"
          value={show.signOff}
          onCommit={(v) => update({ show: { signOff: v } })}
        />
      </Section>

      <ApiKeysSection />
    </>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="row">
      <div className="row-label">
        <span>{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </div>
      <div className="row-control">{children}</div>
    </div>
  );
}

function Toggle(props: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="row toggle-row">
      <div className="row-label">
        <span>{props.label}</span>
        {props.hint && <span className="hint">{props.hint}</span>}
      </div>
      <input
        type="checkbox"
        role="switch"
        className="switch"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
      />
    </label>
  );
}

function Check(props: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={`check${props.disabled ? " disabled" : ""}`}>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      {props.label}
    </label>
  );
}

function Choice<T extends string>(props: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <Row label={props.label}>
      <div className="segmented" role="radiogroup" aria-label={props.label}>
        {props.options.map((o) => (
          <button
            key={o.value}
            role="radio"
            aria-checked={props.value === o.value}
            className="segment"
            onClick={() => props.onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </Row>
  );
}

/** Saves when the field loses focus or Enter is pressed, not on every keystroke. */
function TextField(props: { label: string; hint?: string; value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = () => {
    if (draft !== props.value) props.onCommit(draft.trim());
  };
  return (
    <Row label={props.label} hint={props.hint}>
      <input
        className="input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
    </Row>
  );
}
