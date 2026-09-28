import { useEffect, useState } from "react";
import type { KeyStatus } from "../../../shared/api";
import { PROVIDERS, type ProviderInfo, type ProviderRole } from "../../../shared/providers";
import { Section } from "./Section";

const ROLE_TITLES: Record<ProviderRole, string> = {
  transcription: "Transcription",
  writing: "Show notes and research",
};

/** Electron wraps errors from the main process; show only the message. */
const cleanError = (err: unknown) =>
  String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

export function ApiKeysSection() {
  const [keys, setKeys] = useState<KeyStatus[]>([]);
  const [keychain, setKeychain] = useState(true);

  useEffect(() => {
    void window.api.listKeys().then(setKeys);
    void window.api.keychainAvailable().then(setKeychain);
  }, []);

  return (
    <Section
      title="API keys"
      intro={
        <>
          Each person uses their own keys. Keys are encrypted with this computer's keychain and never leave
          it except to call the provider they belong to.
        </>
      }
    >
      <div className="notice" role="note">
        <strong>Your content is sent to third parties.</strong> Transcriptor 2 doesn't process audio or text on
        this computer. When you use a provider below, the audio or transcript is sent to that company's servers and
        handled under their terms and data policies. Don't process recordings you don't have the right to share.
      </div>
      {!keychain && (
        <div className="notice error" role="alert">
          This computer's keychain isn't available, so keys can't be stored safely.
        </div>
      )}
      {(["transcription", "writing"] as const).map((role) => (
        <div key={role} className="key-group">
          <h3>{ROLE_TITLES[role]}</h3>
          {PROVIDERS.filter((p) => p.role === role).map((p) => (
            <KeyRow
              key={p.id}
              provider={p}
              status={keys.find((k) => k.providerId === p.id)}
              onChange={setKeys}
            />
          ))}
        </div>
      ))}
    </Section>
  );
}

function KeyRow(props: {
  provider: ProviderInfo;
  status: KeyStatus | undefined;
  onChange: (keys: KeyStatus[]) => void;
}) {
  const { provider, status } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");

  const save = async () => {
    setError("");
    try {
      props.onChange(await window.api.setKey(provider.id, draft));
      setDraft("");
      setEditing(false);
    } catch (err) {
      setError(cleanError(err));
    }
  };

  const remove = async () => {
    props.onChange(await window.api.deleteKey(provider.id));
  };

  return (
    <div className="key-row">
      <div className="row-label">
        <span>
          {provider.label}
          {status?.saved && <span className="badge">Saved · ends {status.hint}</span>}
        </span>
        <span className="hint">
          Sends {provider.sends} to {provider.company}.{" "}
          <a
            href={provider.keyUrl}
            onClick={(e) => {
              e.preventDefault();
              void window.api.openExternal(provider.keyUrl);
            }}
          >
            Get a key
          </a>
        </span>
        {error && <span className="hint error">{error}</span>}
      </div>
      <div className="row-control">
        {editing ? (
          <form
            className="key-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <input
              className="input"
              type="password"
              autoFocus
              placeholder="Paste API key"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label={`${provider.label} API key`}
            />
            <button className="button primary" type="submit" disabled={!draft.trim()}>
              Save
            </button>
            <button className="button ghost" type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <div className="key-form">
            <button className="button" onClick={() => setEditing(true)}>
              {status?.saved ? "Replace" : "Add key"}
            </button>
            {status?.saved && (
              <button className="button ghost" onClick={() => void remove()}>
                Remove
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
