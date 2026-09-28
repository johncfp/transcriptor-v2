import { useEffect, useRef } from "react";

/** Asked when leaving Settings with changes that haven't been saved. */
export function UnsavedDialog(props: { onSave: () => void; onDiscard: () => void; onCancel: () => void }) {
  const saveRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    saveRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onCancel()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="unsaved-title">
        <h2 id="unsaved-title">Save your settings?</h2>
        <p className="muted">You've changed settings that haven't been saved yet.</p>
        <div className="modal-actions">
          <button className="button ghost" onClick={props.onCancel}>
            Keep editing
          </button>
          <button className="button" onClick={props.onDiscard}>
            Discard changes
          </button>
          <button ref={saveRef} className="button primary" onClick={props.onSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
