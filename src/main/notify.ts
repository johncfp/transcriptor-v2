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
    failed: {
      title: "Transcription failed",
      body: `${job.fileName}: ${job.error ?? "Something went wrong."}`,
    },
  }[event.type];

  const n = new Notification({ ...content, silent: event.type === "transcribed" });
  n.on("click", () => opts.onClick(job.id));
  n.show();
}
