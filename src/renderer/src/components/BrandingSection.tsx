import { useEffect, useState } from "react";
import type { Branding, Settings, SettingsPatch } from "../../../shared/settings";
import { Section } from "./Section";

const cleanError = (err: unknown) =>
  String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** Cover page, logo, header and footer for exported documents. */
export function BrandingSection({ settings, update }: { settings: Settings; update: (p: SettingsPatch) => void }) {
  const branding = settings.output.branding;
  const set = (patch: Partial<Branding>) => update({ output: { branding: { ...branding, ...patch } } });
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const [header, setHeader] = useState(branding.headerText);
  const [footer, setFooter] = useState(branding.footerText);
  useEffect(() => setHeader(branding.headerText), [branding.headerText]);
  useEffect(() => setFooter(branding.footerText), [branding.footerText]);

  useEffect(() => {
    let live = true;
    if (!branding.logo) setPreview("");
    else window.api.logoPreview(branding.logo).then((p) => live && setPreview(p ?? ""));
    return () => {
      live = false;
    };
  }, [branding.logo]);

  return (
    <Section
      title="Cover page, header and footer"
      intro="For Word and PDF exports of the transcript, show notes and reference file. Plain text gets the cover page as a few lines at the top."
    >
      <label className="row toggle-row">
        <div className="row-label">
          <span>Cover page</span>
          <span className="hint">Logo, show name, document, episode and export date on a page of its own.</span>
        </div>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={branding.coverPage}
          onChange={(e) => set({ coverPage: e.target.checked })}
        />
      </label>

      <div className="row">
        <div className="row-label">
          <span>Logo</span>
          <span className="hint">PNG or JPEG. A copy is kept with Transcriptor 2's settings.</span>
        </div>
        <div className="row-control logo-control">
          {preview && <img className="logo-preview" src={preview} alt="Logo preview" />}
          <button
            className="button"
            onClick={async () => {
              setError("");
              try {
                const picked = await window.api.pickLogo();
                if (picked) {
                  setPreview(picked.preview);
                  set({ logo: picked.name });
                }
              } catch (err) {
                setError(cleanError(err));
              }
            }}
          >
            {branding.logo ? "Change…" : "Choose…"}
          </button>
          {branding.logo && (
            <button className="button ghost" onClick={() => set({ logo: "" })}>
              Remove
            </button>
          )}
          {error && <span className="hint error">{error}</span>}
        </div>
      </div>

      <label className="row toggle-row">
        <div className="row-label">
          <span>Logo in the header</span>
          <span className="hint">Small, at the top left of each page. The cover page has no header or footer.</span>
        </div>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={branding.logoInHeader}
          disabled={!branding.logo}
          onChange={(e) => set({ logoInHeader: e.target.checked })}
        />
      </label>

      <div className="row">
        <div className="row-label">
          <span>Header text</span>
          <span className="hint">Top right of each page, e.g. the show name or “Confidential”.</span>
        </div>
        <input
          className="input"
          value={header}
          onChange={(e) => setHeader(e.target.value)}
          onBlur={() => header.trim() !== branding.headerText && set({ headerText: header.trim() })}
          onKeyDown={(e) => e.key === "Enter" && header.trim() !== branding.headerText && set({ headerText: header.trim() })}
        />
      </div>
      <div className="row">
        <div className="row-label">
          <span>Footer text</span>
          <span className="hint">Bottom left of each page, e.g. “© 2026 Your Company”.</span>
        </div>
        <input
          className="input"
          value={footer}
          onChange={(e) => setFooter(e.target.value)}
          onBlur={() => footer.trim() !== branding.footerText && set({ footerText: footer.trim() })}
          onKeyDown={(e) => e.key === "Enter" && footer.trim() !== branding.footerText && set({ footerText: footer.trim() })}
        />
      </div>

      <label className="row toggle-row">
        <div className="row-label">
          <span>Page numbers</span>
          <span className="hint">“Page 2 of 5” at the bottom right.</span>
        </div>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={branding.pageNumbers}
          onChange={(e) => set({ pageNumbers: e.target.checked })}
        />
      </label>
    </Section>
  );
}
