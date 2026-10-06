import { useEffect, useState, type ReactNode } from "react";
import type { Settings, SettingsPatch, VideoSettings as Video } from "../../../shared/settings";
import { CAPTION_SIZES, CAPTION_STYLES, SHAPES, VIDEO_FONTS, videoFont } from "../../../shared/video";
import { Section } from "./Section";

const cleanError = (err: unknown) =>
  String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** How kept clips look as videos. Each clip's Clips tab shows a preview with these settings. */
export function VideoSettings({ settings, update }: { settings: Settings; update: (p: SettingsPatch) => void }) {
  const { video } = settings;
  const set = (patch: Partial<Video>) => update({ video: { ...video, ...patch } });
  const [bgPreview, setBgPreview] = useState<string | null>(null);
  const [bgError, setBgError] = useState("");
  const hasLogo = !!settings.output.branding.logo;
  const noShape = !SHAPES.some((s) => video.shapes[s.id]);

  useEffect(() => {
    let live = true;
    if (video.backgroundImage) void window.api.backgroundPreview(video.backgroundImage).then((p) => live && setBgPreview(p));
    else setBgPreview(null);
    return () => {
      live = false;
    };
  }, [video.backgroundImage]);

  return (
    <Section
      className="col-right-tall"
      title="Video clips"
      intro="Kept clips as MP4 videos: the clip's audio with its captions, in the shapes you choose. Exported next to the WAV files. To see how a clip will look, play it on its episode's Clips tab."
    >
      <label className="row toggle-row">
        <div className="row-label">
          <span>Make video clips</span>
          <span className="hint">Rendering takes about a third of each clip's length per shape.</span>
        </div>
        <input type="checkbox" role="switch" className="switch" checked={video.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
      </label>

      <Row label="Shapes" hint={noShape ? "Choose at least one shape." : undefined} warn={noShape}>
        <div className="checks">
          {SHAPES.map((s) => (
            <label key={s.id} className="check" title={s.hint}>
              <input type="checkbox" checked={video.shapes[s.id]} onChange={(e) => set({ shapes: { ...video.shapes, [s.id]: e.target.checked } })} />
              {s.label} <span className="hint">{s.hint}</span>
            </label>
          ))}
        </div>
      </Row>

      <Row label="Caption style" hint={CAPTION_STYLES.find((c) => c.id === video.captionStyle)?.hint}>
        <Segmented label="Caption style" value={video.captionStyle} options={CAPTION_STYLES} onChange={(captionStyle) => set({ captionStyle })} />
      </Row>

      <Row label="Font" hint={videoFont(video.font).hint}>
        <select className="input select" aria-label="Font" value={video.font} onChange={(e) => set({ font: e.target.value as Video["font"] })}>
          {VIDEO_FONTS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </Row>

      <Row label="Caption size">
        <Segmented label="Caption size" value={video.captionSize} options={CAPTION_SIZES} onChange={(captionSize) => set({ captionSize })} />
      </Row>

      <Row label="Brand colours" hint="The highlight marks the word being said, the speaker's name and the waveform.">
        <div className="color-rows">
          {(
            [
              ["background", "Background"],
              ["text", "Text"],
              ["highlight", "Highlight"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="color-row">
              <input
                type="color"
                aria-label={`${label} colour`}
                value={video.colors[key]}
                onChange={(e) => set({ colors: { ...video.colors, [key]: e.target.value } })}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </Row>

      <Row
        label="Background"
        hint={video.backgroundType === "image" ? "PNG or JPEG, cropped to fill each shape and darkened so captions stay readable." : "A gradient from the background colour."}
      >
        <div className="row-control background-control">
          <Segmented
            label="Background"
            value={video.backgroundType}
            options={[
              { id: "color", label: "Colour" },
              { id: "image", label: "Image" },
            ]}
            onChange={(backgroundType) => set({ backgroundType })}
          />
          {video.backgroundType === "image" && (
            <>
              {bgPreview && <img className="logo-preview" src={bgPreview} alt="Background image" />}
              <button
                className="button"
                onClick={async () => {
                  setBgError("");
                  try {
                    const picked = await window.api.pickBackground();
                    if (picked) {
                      set({ backgroundImage: picked.name });
                      setBgPreview(picked.preview);
                    }
                  } catch (err) {
                    setBgError(cleanError(err));
                  }
                }}
              >
                {video.backgroundImage ? "Change…" : "Choose image…"}
              </button>
            </>
          )}
        </div>
      </Row>
      {bgError && <p className="hint error">{bgError}</p>}
      {video.backgroundType === "image" && !video.backgroundImage && <p className="hint warn">No image chosen yet, so the colour is used.</p>}

      <Toggle label="Logo" hint={hasLogo ? "The logo from Output › Cover page, header and footer." : "Import a logo on the Output tab to show it."} checked={video.showLogo} onChange={(showLogo) => set({ showLogo })} />
      <Toggle label="Show name" hint="From the show profile." checked={video.showShowName} onChange={(showShowName) => set({ showShowName })} />
      <Toggle label="Speaker names" hint="Above the captions, as named in review." checked={video.showSpeakers} onChange={(showSpeakers) => set({ showSpeakers })} />
      <Toggle label="Waveform" hint="Moves with the audio." checked={video.waveform} onChange={(waveform) => set({ waveform })} />

    </Section>
  );
}

// ---------------------------------------------------------------------------

function Row({ label, hint, warn, children }: { label: string; hint?: string; warn?: boolean; children: ReactNode }) {
  return (
    <div className="row">
      <div className="row-label">
        <span>{label}</span>
        {hint && <span className={`hint${warn ? " warn" : ""}`}>{hint}</span>}
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
      <input type="checkbox" role="switch" className="switch" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
    </label>
  );
}

function Segmented<T extends string>(props: { label: string; value: T; options: readonly { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button key={o.id} role="radio" aria-checked={props.value === o.id} className="segment" onClick={() => props.onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
