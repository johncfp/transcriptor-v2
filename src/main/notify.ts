import { Notification } from "electron";
import type { JobEvent } from "./jobQueue";

/**
 * Desktop notifications for queue events. Clicking one opens the window on
 * that episode. Skipped when the window is already in front, since the
 * user can see the change happen.
 */
export function notifyJobEvent(
  event: JobEvent,
  opts: { windowFocused: boolean; onClick: (jobId: string) => void },
): void {
  if (!Notification.isSupported()) return;
  // Approval requests always notify: nothing happens until someone answers.
  if (opts.windowFocused && event.type !== "awaiting-approval") return;

  const { job } = event;
  const content = {
    "awaiting-approval": {
      title: "New episode waiting",
      body: `${job.fileName} is ready to process. Open Transcriptor 2 to start it.`,
    },
    transcribed: {
      title: event.type === "transcribed" && event.needsReview ? "Transcript ready to review" : "Transcript ready",
      body: `${job.fileName} has been transcribed.`,
    },
    written: {
      title: "Show notes ready",
      body: `Show notes for ${job.fileName} are ready to check.`,
    },
    failed: {
      title: job.failedStep === "writing" ? "Show notes failed" : "Transcription failed",
      body: `${job.fileName}: ${job.error ?? "Something went wrong."}`,
    },
    "clips-ready": {
      title: "Social clips ready",
      body: job.social?.clipCount
        ? `${job.social.clipCount} ${job.social.clipCount === 1 ? "clip" : "clips"} for ${job.fileName} ready to review.`
        : `No clips for ${job.fileName} held up against the transcript. You can ask for new ones.`,
    },
    "clips-failed": {
      title: "Social clips failed",
      body: `${job.fileName}: ${job.social?.error ?? "Something went wrong."} The show notes are fine.`,
    },
  }[event.type];

  const n = new Notification({ ...content, silent: event.type === "transcribed" || event.type === "clips-ready" });
  n.on("click", () => opts.onClick(job.id));
  n.show();
}
