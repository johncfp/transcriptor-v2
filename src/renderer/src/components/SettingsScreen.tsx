import { useEffect, useState, type MutableRefObject, type ReactNode } from "react";
import {
  DEFAULT_EPISODE_COLORS,
  mergeSettings,
  SPEAKER_FORMATS,
  THEMES,
  WINDOW_STARTS,
  type EpisodeColors,
  type Settings,
  type SettingsPatch,
  type SpeakerFormat,
} from "../../../shared/settings";
import { ApiKeysSection } from "./ApiKeysSection";
import { Section } from "./Section";
import { ShowNotesSettings, ShowNotesTemplateSection } from "./ShowNotesSettings";
import { SocialVoiceSection, VoiceSection } from "./VoiceSection";
import { SocialSettings } from "./SocialSettings";
import { VideoSettings } from "./VideoSettings";
import { BrandingSection } from "./BrandingSection";
import { FolderWatchSection } from "./FolderWatchSection";
import { ConfidenceBandsSection } from "./ConfidenceBandsSection";

const TABS = [
  { id: "general", label: "General" },
  { id: "output", label: "Output" },
  { id: "notes", label: "Show notes" },
  { id: "social", label: "Social" },
  { id: "drive", label: "Drive" },
  { id: "keys", label: "API keys & voice" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const TAB_KEY = "settings.tab";
function savedTab(): TabId {
  try {
    const t = localStorage.getItem(TAB_KEY);
    return TABS.some((x) => x.id === t) ? (t as TabId) : "general";
  } catch {
    return "general";
  }
}

/** What the app needs from Settings to stop someone leaving with unsaved changes. */
export interface SettingsGuard {
  dirty: boolean;
  save: () => Promise<void>;
  discard: () => void;
}

/**
 * Settings are edited as a draft and written when Save is pressed. API keys
 * are the exception: each has its own Save, straight to the keychain.
 */
export function SettingsScreen({ guard }: { guard: MutableRefObject<SettingsGuard | null> }) {
  const [tab, setTab] = useState<TabId>(savedTab);
  const chooseTab = (t: TabId) => {
    setTab(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      // Remembering the tab is a convenience; fine without it.
    }
  };
  const [saved, setSaved] = useState<Settings | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null); // the draft
  const [defaultFolder, setDefaultFolder] = useState("");
  const [version, setVersion] = useState("");
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    void window.api.getSettings().then((s) => {
      setSaved(s);
      setSettings(s);
    });
    void window.api.defaultOutputFolder().then(setDefaultFolder);
    void window.api.appVersion().then(setVersion);
  }, []);

  const dirty = saved !== null && settings !== null && JSON.stringify(saved) !== JSON.stringify(settings);
  const save = async () => {
    if (!settings) return;
    const next = await window.api.updateSettings(settings);
    setSaved(next);
    setSettings(next);
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 2000);
  };
  const discard = () => setSettings(saved);
  guard.current = { dirty, save, discard };

  // Ctrl/Cmd+S saves; closing or quitting with changes asks first (see will-prevent-unload in main).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void guard.current?.save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [guard]);
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty]);

  if (!settings) return null;

  const update = (patch: SettingsPatch) => setSettings((d) => (d ? mergeSettings(d, patch) : d));
  const { general, processing, output, show } = settings;

  return (
    <>
      <div className="page-head settings-head">
        <h1>Settings</h1>
        <div className="head-actions">
          {dirty && <span className="unsaved">Unsaved changes</span>}
          {justSaved && !dirty && <span className="hint">Saved</span>}
          {dirty && (
            <button className="button ghost" onClick={discard}>
              Discard
            </button>
          )}
          <button className="button primary" disabled={!dirty} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
      <div className="tabs" role="tablist" aria-label="Settings">
        {TABS.map((t) => (
          <button key={t.id} role="tab" className="tab" aria-selected={tab === t.id} onClick={() => chooseTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="settings-grid">
        {tab === "general" && (
          <>
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
              <Choice
                label="Window at startup"
                hint="Full screen hides the title bar and taskbar; F11 or Esc leaves it, and F11 brings it back."
                value={general.startWindow}
                options={WINDOW_STARTS.map((w) => ({ value: w.id, label: w.label }))}
                onChange={(v) => update({ general: { startWindow: v } })}
              />
              <Choice
                label="Appearance"
                value={general.theme}
                options={THEMES.map((t) => ({ value: t.id, label: t.label }))}
                onChange={(v) => update({ general: { theme: v } })}
              />
              <EpisodeColorRows colors={general.episodeColors} onChange={(c) => update({ general: { episodeColors: c } })} />
              <Row label="Version" hint="Updates install automatically on Windows; on Mac the sidebar offers a download.">
                <span className="version">Transcriptor 2 v{version}</span>
              </Row>
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
                label="Remove repetitions and false starts"
                hint={`Filler words ("um", "uh") are always removed. This also has ElevenLabs drop false starts ("I was, we went") while transcribing, which can't be reviewed or undone, and hides repeated words ("the the") and cut-off words ("th-"), which you can check in review. Applies to episodes transcribed after you turn it on.`}
                checked={processing.removeFalseStarts}
                onChange={(v) => update({ processing: { removeFalseStarts: v } })}
              />
            </Section>
          </>
        )}

        {tab === "output" && (
          <>
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
                    label="PDF (.pdf)"
                    checked={output.formats.pdf}
                    onChange={(v) => update({ output: { formats: { ...output.formats, pdf: v } } })}
                  />
                  <Check
                    label="Plain text (.txt)"
                    checked={output.formats.txt}
                    onChange={(v) => update({ output: { formats: { ...output.formats, txt: v } } })}
                  />
                  <Check label="Google Doc (not set up yet)" checked={false} disabled onChange={() => {}} />
                </div>
              </Row>
              <Row
                label="Subtitles"
                hint="Subtitle files of the reviewed transcript, timed to the episode's audio, saved with the documents. SRT suits most video editors and players; WebVTT suits YouTube and the web."
              >
                <div className="checks">
                  <Check
                    label="SubRip (.srt)"
                    checked={output.subtitles.srt}
                    onChange={(v) => update({ output: { subtitles: { ...output.subtitles, srt: v } } })}
                  />
                  <Check
                    label="WebVTT (.vtt)"
                    checked={output.subtitles.vtt}
                    onChange={(v) => update({ output: { subtitles: { ...output.subtitles, vtt: v } } })}
                  />
                </div>
              </Row>
              <Toggle
                label="Export automatically when show notes are ready"
                hint="Saves the transcript, show notes and reference file in a folder for the episode. You can also export from the episode at any time."
                checked={output.autoExport}
                onChange={(v) => update({ output: { autoExport: v } })}
              />
              <Row label="Speaker format" hint="How each speaker's turn is laid out in the exported transcript.">
                <select
                  className="input select"
                  value={output.speakerFormat}
                  onChange={(e) => update({ output: { speakerFormat: e.target.value as SpeakerFormat } })}
                  aria-label="Speaker format"
                >
                  {SPEAKER_FORMATS.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </Row>
              <Toggle
                label="Timestamps in the exported transcript"
                hint="Adds each turn's start time, placed to suit the speaker format."
                checked={output.transcriptTimestamps}
                onChange={(v) => update({ output: { transcriptTimestamps: v } })}
              />
              <Toggle
                label="Color low-confidence words in the exported transcript"
                hint="Red for low and orange for medium confidence, in the Word file, so words worth checking stand out. PDF and plain text have no color."
                checked={output.colorConfidence}
                onChange={(v) => update({ output: { colorConfidence: v } })}
              />
            </Section>

            <BrandingSection settings={settings} update={update} />
            <ConfidenceBandsSection settings={settings} update={update} />
          </>
        )}

        {tab === "notes" && (
          <>
            <Section
              className="col-left"
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

            <ShowNotesTemplateSection settings={settings} update={update} />
            <ShowNotesSettings settings={settings} update={update} />
          </>
        )}

        {tab === "social" && (
          <>
            <SocialSettings settings={settings} update={update} />
            <VideoSettings settings={settings} update={update} />
            <SocialVoiceSection settings={settings} update={update} />
          </>
        )}

        {tab === "drive" && <FolderWatchSection settings={settings} update={update} />}

        {tab === "keys" && (
          <>
            <ApiKeysSection />
            <VoiceSection settings={settings} update={update} />
          </>
        )}
      </div>
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
  hint?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <Row label={props.label} hint={props.hint}>
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

const STAGES: { key: keyof EpisodeColors; label: string; hint: string }[] = [
  { key: "fresh", label: "New episodes", hint: "From upload until the transcript is reviewed." },
  { key: "reviewed", label: "Reviewed", hint: "Ready for show notes, or being written." },
  { key: "notesReady", label: "Show notes ready", hint: "Notes written; ready to export or already exported." },
];

/** The colors that mark each stage in the Episodes list. */
function EpisodeColorRows({ colors, onChange }: { colors: EpisodeColors; onChange: (c: EpisodeColors) => void }) {
  const isDefault = STAGES.every((s) => colors[s.key].toLowerCase() === DEFAULT_EPISODE_COLORS[s.key]);
  return (
    <div className="row episode-colors">
      <div className="row-label">
        <span>Episode colors</span>
        <span className="hint">Marks each episode's stage in the Episodes list.</span>
        {!isDefault && (
          <button className="button ghost reset-colors" onClick={() => onChange({ ...DEFAULT_EPISODE_COLORS })}>
            Reset to defaults
          </button>
        )}
      </div>
      <div className="color-rows">
        {STAGES.map((stage) => (
          <label key={stage.key} className="color-row" title={stage.hint}>
            <input
              type="color"
              value={colors[stage.key]}
              onChange={(e) => onChange({ ...colors, [stage.key]: e.target.value })}
              aria-label={`${stage.label} color`}
            />
            <span>{stage.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
