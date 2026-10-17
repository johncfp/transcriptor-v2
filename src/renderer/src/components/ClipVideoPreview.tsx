import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ClipContext, SocialClip } from "../../../shared/clips";
import type { Settings } from "../../../shared/settings";
import { clipCaptionWords, isPlaceholderName, MOTION, SHAPES, type ShapeId } from "../../../shared/video";
import { audioSeconds, drawFrame, makeScene, stillTime, type FrameScene } from "../video/drawFrame";
import { loadVideoFont } from "../video/fonts";
import { Section } from "./Section";

const loadImage = (src: string) =>
  new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });

/**
 * One clip as its video will look, drawn by the export's own code. While the
 * clip plays, frames follow the audio; otherwise it shows a still from partway in.
 */
export function ClipVideoPreview(props: {
  jobId: string;
  clip: SocialClip;
  ctx: ClipContext;
  settings: Settings;
  audioRef: RefObject<HTMLAudioElement | null>;
  playing: boolean;
}) {
  const { clip, settings } = props;
  const video = settings.video;
  const firstShape = SHAPES.find((s) => video.shapes[s.id])?.id ?? "vertical";
  const [shape, setShape] = useState<ShapeId>(firstShape);
  const spec = SHAPES.find((s) => s.id === shape)!;
  const canvas = useRef<HTMLCanvasElement>(null);
  const [logo, setLogo] = useState<HTMLImageElement | null>(null);
  const [background, setBackground] = useState<HTMLImageElement | null>(null);
  const [fontReady, setFontReady] = useState(false);
  const [levels, setLevels] = useState<number[]>([]);

  useEffect(() => {
    setFontReady(false);
    void loadVideoFont(video.font).then(() => setFontReady(true));
  }, [video.font]);
  useEffect(() => {
    let live = true;
    const name = settings.output.branding.logo;
    if (name) void window.api.logoPreview(name).then(async (p) => live && setLogo(p ? await loadImage(p) : null));
    return () => {
      live = false;
    };
  }, [settings.output.branding.logo]);
  useEffect(() => {
    let live = true;
    const name = video.backgroundType === "image" ? video.backgroundImage : "";
    if (!name) setBackground(null);
    else void window.api.backgroundPreview(name).then(async (p) => live && setBackground(p ? await loadImage(p) : null));
    return () => {
      live = false;
    };
  }, [video.backgroundType, video.backgroundImage]);

  // The waveform: the clip's loudness per frame, measured in the main process. Waits a
  // moment after a trim so nudging the edges doesn't cut the clip over and over.
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void window.api.clipLevels(props.jobId, clip.start, clip.end).then((l) => live && setLevels(l));
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [props.jobId, clip.start, clip.end]);

  const words = useMemo(() => clipCaptionWords(props.ctx.turns, clip), [props.ctx, clip]);
  const unnamed = useMemo(() => [...new Set(words.map((w) => w.speaker).filter(isPlaceholderName))], [words]);
  const scene = useMemo<FrameScene | null>(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!fontReady || !ctx) return null;
    return makeScene(ctx, {
      width: spec.width / 2,
      height: spec.height / 2,
      style: video,
      showName: settings.show.name,
      website: settings.show.website,
      hosts: settings.show.hosts,
      quote: clip.quote ?? null,
      keywords: clip.keywords ?? [],
      logo,
      background,
      levels,
      words,
    });
    // `shape` re-creates the canvas, so the scene follows it.
  }, [fontReady, spec, video, settings.show.name, settings.show.website, settings.show.hosts, clip.quote, clip.keywords, logo, background, levels, words, shape]);

  // A still partway in when not playing; frames following the audio while it plays.
  // When a clip plays to its end, the outro card follows (on the clock, as the audio
  // has stopped), then the still.
  const wasPlaying = useRef(false);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!scene || !ctx) return;
    const audio = props.audioRef.current;
    const still = () => drawFrame(ctx, scene, stillTime(scene));
    const ended = wasPlaying.current && !props.playing && !!audio && audio.currentTime >= clip.end - 0.15;
    wasPlaying.current = props.playing;
    if (ended && scene.outro) {
      const from = audioSeconds(scene), began = performance.now();
      let frame = 0;
      const tick = () => {
        const t = from + (performance.now() - began) / 1000;
        if (t >= from + MOTION.outroSec) return still();
        drawFrame(ctx, scene, t);
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(frame);
    }
    if (!props.playing || !audio) {
      still();
      return;
    }
    let frame = 0;
    const draw = () => drawFrame(ctx, scene, Math.max(0, audio.currentTime - clip.start));
    const tick = () => {
      draw();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    // Animation frames stop while the window is covered; the media clock keeps the preview in step.
    audio.addEventListener("timeupdate", draw);
    return () => {
      cancelAnimationFrame(frame);
      audio.removeEventListener("timeupdate", draw);
    };
  }, [scene, props.playing, props.audioRef, clip.start, clip.end]);

  return (
    <Section title="Video preview" intro={`“${clip.title}”, as its video will look. Play the clip to watch it move.`}>
      <div className="segmented" role="radiogroup" aria-label="Clip preview shape">
        {SHAPES.map((s) => (
          <button key={s.id} role="radio" aria-checked={shape === s.id} className="segment" onClick={() => setShape(s.id)}>
            {s.label}
          </button>
        ))}
      </div>
      <canvas
        ref={canvas}
        key={shape}
        aria-label="Clip video preview"
        className={`video-canvas ${shape} clip-preview`}
        width={spec.width / 2}
        height={spec.height / 2}
      />
      {!video.enabled && <p className="hint">Video clips are off, so exports are audio only. Turn them on in Settings › Social.</p>}
      {video.enabled && !video.shapes[shape] && <p className="hint">This shape isn't chosen in Settings, so it won't be exported.</p>}
      {video.motion.nameCards && unnamed.length > 0 && (
        <p className="hint">
          {unnamed.join(" and ")} {unnamed.length > 1 ? "aren't" : "isn't"} named in review, so the video shows no name card for them.
        </p>
      )}
    </Section>
  );
}
