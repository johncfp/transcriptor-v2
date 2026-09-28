import { useEffect, useMemo, useState } from "react";
import type { Job } from "../../../shared/jobs";
import { providerById } from "../../../shared/providers";
import type { Settings } from "../../../shared/settings";
import {
  buildReference,
  buildShowNotes,
  EMPTY_DETAILS,
  templateSections,
  toMarkdown,
  toPlainText,
  type EpisodeDetails,
  type WritingResult,
} from "../../../shared/showNotes";
import { DocView } from "./DocView";
import { ExportCard } from "./ExportCard";
import { Section } from "./Section";

type View = "notes" | "reference";

export function ShowNotesPanel({ job, settings }: { job: Job; settings: Settings }) {
  const [details, setDetails] = useState<EpisodeDetails>(EMPTY_DETAILS);
  const [result, setResult] = useState<WritingResult | null>(null);
  const [view, setView] = useState<View>("notes");
  const [copied, setCopied] = useState("");

  useEffect(() => {
    void window.api.getDetails(job.id).then((d) => d && setDetails(d));
  }, [job.id]);
  // Re-read the notes whenever the job finishes (or restarts) writing.
  useEffect(() => {
    void window.api.getWriting(job.id).then(setResult);
  }, [job.id, job.status]);

  const blocks = useMemo(() => {
    if (!result) return [];
    const r = { ...result, details }; // details edits show in the preview before rewriting
    return view === "notes"
      ? buildShowNotes(r, settings.show, templateSections(settings.template, settings.customSections))
      : buildReference(r, settings.show);
  }, [result, details, view, settings]);

  const writing = job.status === "writing";
  const canWrite = job.status === "ready" || job.status === "written" || (job.status === "failed" && job.failedStep === "writing");
  const writerLabel = providerById(settings.writing.provider)?.label ?? "the writing provider";
  const field = (key: keyof EpisodeDetails) => ({
    value: details[key],
    onChange: (e: { target: { value: string } }) => setDetails({ ...details, [key]: e.target.value }),
  });

  const copy = async (kind: "text" | "markdown") => {
    await navigator.clipboard.writeText(kind === "text" ? toPlainText(blocks) : toMarkdown(blocks));
    setCopied(kind);
    setTimeout(() => setCopied(""), 1500);
  };

  return (
    <div className="review-body">
      <aside className="review-side">
        <Section title="Episode details" intro="Anything left blank is left out of the notes.">
          <label className="field">
            <span>Episode number</span>
            <input className="input" {...field("episodeNumber")} placeholder="e.g. 386" />
          </label>
          <label className="field">
            <span>Title</span>
            <input className="input" {...field("title")} placeholder={result?.notes.titleSuggestion || "Suggested when the notes are written"} />
          </label>
          <label className="field">
            <span>Sponsor reads</span>
            <textarea className="input" rows={3} {...field("sponsors")} placeholder="One per line, used word for word" />
          </label>
          <label className="field">
            <span>Next week</span>
            <input className="input" {...field("nextWeek")} placeholder="A line about the next episode" />
          </label>
          <div className="notes-actions">
            {writing ? (
              <>
                <span className="hint">{job.stage ?? "Working"}…</span>
                <button className="button ghost" onClick={() => void window.api.cancelJob(job.id)}>
                  Cancel
                </button>
              </>
            ) : (
              <button
                className="button primary"
                disabled={!canWrite}
                onClick={() => void window.api.writeNotes(job.id, details)}
              >
                {result ? "Rewrite show notes" : "Write show notes"}
              </button>
            )}
          </div>
          {writing && job.stage !== "Waiting" && (
            <div className="progress indeterminate">
              <div className="progress-bar" />
            </div>
          )}
          {job.status === "needs-review" && <p className="hint">Mark the transcript as reviewed first.</p>}
          {job.status === "failed" && job.failedStep === "writing" && <p className="hint error">{job.error}</p>}
          <p className="hint">
            Sends the cleaned transcript to {writerLabel}, and looks the guest up on the web when there is one. Changes to
            the details above show in the preview straight away; rewrite to update the rest.
          </p>
        </Section>

        {job.status !== "needs-review" && <ExportCard job={job} settings={settings} hasNotes={result !== null} />}
        {result && <ChecksCard result={result} />}
        {result?.research && <ResearchCard result={result} />}
      </aside>

      <div className="review-main">
        <div className="notes-toolbar">
          <div className="segmented" role="radiogroup" aria-label="Document">
            <button role="radio" className="segment" aria-checked={view === "notes"} onClick={() => setView("notes")}>
              Show notes
            </button>
            <button role="radio" className="segment" aria-checked={view === "reference"} onClick={() => setView("reference")}>
              Reference file
            </button>
          </div>
          {result && (
            <div className="key-form">
              <button className="button" onClick={() => void copy("text")}>
                {copied === "text" ? "Copied" : "Copy text"}
              </button>
              <button className="button" onClick={() => void copy("markdown")}>
                {copied === "markdown" ? "Copied" : "Copy Markdown"}
              </button>
            </div>
          )}
        </div>
        {result ? (
          <DocView blocks={blocks} />
        ) : (
          <div className="empty">
            <p className="empty-title">No show notes yet</p>
            <p className="muted">
              {job.status === "needs-review"
                ? "Review the transcript, then write the notes here."
                : "Fill in the details on the left and choose Write show notes."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function ChecksCard({ result }: { result: WritingResult }) {
  const { checks } = result;
  const clean = !checks.quotesDropped.length && !checks.timestampsDropped && !checks.linksDropped;
  return (
    <Section title="Checks">
      <p className="hint">
        Written by {providerById(result.provider)?.label ?? result.provider} ({result.model}) on{" "}
        {new Date(result.generatedAt).toLocaleString()}.
      </p>
      {clean ? (
        <p>Every quote matched the transcript word for word, and every timestamp and link checked out.</p>
      ) : (
        <ul className="checks-list">
          {checks.quotesDropped.length > 0 && (
            <li>
              {checks.quotesDropped.length} quote{checks.quotesDropped.length === 1 ? "" : "s"} left out because the
              wording didn't match the transcript:
              <ul>
                {checks.quotesDropped.map((q, i) => (
                  <li key={i} className="muted">
                    “{q}”
                  </li>
                ))}
              </ul>
            </li>
          )}
          {checks.timestampsDropped > 0 && (
            <li>{checks.timestampsDropped} timestamp{checks.timestampsDropped === 1 ? "" : "s"} left out (outside the episode or unreadable).</li>
          )}
          {checks.linksDropped > 0 && (
            <li>
              {checks.linksDropped} guest link{checks.linksDropped === 1 ? "" : "s"} left out because the search didn't
              actually return {checks.linksDropped === 1 ? "that page" : "those pages"}.
            </li>
          )}
        </ul>
      )}
    </Section>
  );
}

function ResearchCard({ result }: { result: WritingResult }) {
  const research = result.research!;
  const confirmed = research.facts.filter((f) => f.sources.length);
  const unconfirmed = research.facts.filter((f) => !f.sources.length);
  return (
    <Section title={`Guest lookup: ${research.guestName}`}>
      {!research.identified && (
        <p className="hint warn">Couldn't be sure the search found the right person, so nothing from it was used.</p>
      )}
      {research.identified && research.sourcesUnavailable && (
        <p className="hint warn">This provider doesn't return its sources, so nothing it found could be confirmed or used.</p>
      )}
      {confirmed.length > 0 && (
        <>
          <p className="hint">Confirmed and used in the notes:</p>
          <ul className="checks-list">
            {confirmed.map((f, i) => (
              <li key={i}>
                {f.fact}{" "}
                {f.sources.map((s) => (
                  <a key={s} href={s} className="source" onClick={(e) => (e.preventDefault(), void window.api.openExternal(s))}>
                    {new URL(s).hostname.replace(/^www\./, "")}
                  </a>
                ))}
              </li>
            ))}
          </ul>
        </>
      )}
      {unconfirmed.length > 0 && (
        <>
          <p className="hint">Not confirmed, so left out:</p>
          <ul className="checks-list muted">
            {unconfirmed.map((f, i) => (
              <li key={i}>{f.fact}</li>
            ))}
          </ul>
        </>
      )}
      {research.identified && !research.facts.length && <p className="hint">The search didn't turn up anything to confirm.</p>}
    </Section>
  );
}
