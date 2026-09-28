// Per-word recognition confidence: bucketing a 0–1 score into the bands the
// review screen colors and the exported transcript can color. Ported from
// Transcriptor 1 (same defaults and colors).

/** Confidence bands worth flagging. High confidence gets no tag (null). */
export type ConfidenceLevel = "low" | "medium";

/**
 * The two band boundaries: a word is `low` below `lowMax`, `medium` below
 * `mediumMax`, and trusted (untagged) at or above it.
 */
export interface ConfidenceThresholds {
  lowMax: number;
  mediumMax: number;
}

// Only near-certain words (≥ 0.96) are trusted silently; p ≈ 0.5 reads as
// genuinely shaky; the wide band between is worth a glance.
export const DEFAULT_CONFIDENCE_THRESHOLDS: ConfidenceThresholds = { lowMax: 0.5, mediumMax: 0.96 };

/** Word colors (hex, no #), as in Transcriptor 1: red-600 and orange-600. */
export const CONFIDENCE_COLORS: Record<ConfidenceLevel, string> = { low: "DC2626", medium: "EA580C" };

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Both in [0, 1] and ordered, so the medium band can't invert. */
export function clampThresholds(t: ConfidenceThresholds): ConfidenceThresholds {
  const lowMax = clamp01(t.lowMax);
  return { lowMax, mediumMax: Math.max(lowMax, clamp01(t.mediumMax)) };
}

export function confidenceLevel(
  confidence: number | undefined,
  thresholds: ConfidenceThresholds = DEFAULT_CONFIDENCE_THRESHOLDS,
): ConfidenceLevel | null {
  if (confidence === undefined || Number.isNaN(confidence)) return null;
  if (confidence < thresholds.lowMax) return "low";
  if (confidence < thresholds.mediumMax) return "medium";
  return null;
}
