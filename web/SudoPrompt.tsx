import { useEffect, useState } from "react";
import type { SudoPrompt } from "../shared/protocol";
import { fetchSudoStatus } from "./auth";

/** "Fill sudo password?" over a terminal sitting at a local sudo prompt. The
 * server types the stored password; it never reaches the browser. */
export function SudoPromptDialog({
  prompt,
  command,
  onFill,
  onCancel,
  onOpenSettings,
}: {
  prompt: SudoPrompt;
  command: string | null;
  onFill: () => void;
  onCancel: () => void;
  onOpenSettings: () => void;
}) {
  // Re-checked per prompt: it may have been set/removed on another device.
  const [stored, setStored] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    fetchSudoStatus()
      .then((r) => live && setStored(r.ok && !!r.set))
      .catch(() => live && setStored(false));
    return () => {
      live = false;
    };
  }, [prompt.id]);

  // Window-level so it works whatever holds focus (xterm usually does).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      else if (e.key === "Enter" && stored && !prompt.retry) onFill();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [stored, prompt.retry, onFill, onCancel]);

  return (
    <div className="resume-overlay" onClick={onCancel}>
      <div
        className="resume-dialog sudo-dialog"
        role="dialog"
        aria-label="Fill sudo password"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="resume-dialog-head">Fill sudo password?</div>
        <div className="sudo-dialog-body">
          {command && (
            <code className="sudo-dialog-command" title={command}>
              {command}
            </code>
          )}
          {prompt.retry && (
            <p className="login-error">
              The stored password was rejected. Fill it again only if you're sure it's right.
            </p>
          )}
          {stored === false && (
            <p className="sudo-dialog-note">
              No sudo password is stored.{" "}
              <button type="button" className="sudo-dialog-link" onClick={onOpenSettings}>
                Set one in Settings
              </button>
              , or cancel and type it in the terminal.
            </p>
          )}
        </div>
        <div className="sudo-dialog-actions">
          <button type="button" className="settings-logout" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="login-submit"
            disabled={!stored}
            autoFocus
            onClick={onFill}
          >
            Fill
          </button>
        </div>
      </div>
    </div>
  );
}
