import { useCallback, useEffect, useRef, useState } from "react";
import type { ContentViewProps } from "./index";
import { fetchPage, inlinePage } from "./learn/inline";
import { PhoneFrame } from "./learn/PhoneFrame";
import { scrollBootstrap, useScrollKeep } from "./learn/scrollKeep";
import { exportStandalone } from "./learn/exportHtml";

const PHONE_KEY = "agent-remote.learnPhone";

/** Live preview of a co-create learn page in a sandboxed iframe (opaque origin:
 * the page's own JS can never reach the app or its API). */
export function LearnPreview({ client, sessionId, folder, pointer }: ContentViewProps) {
  const [doc, setDoc] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phone, setPhone] = useState(() => localStorage.getItem(PHONE_KEY) !== "0");
  const [exporting, setExporting] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Drops a stale render that lands after a newer one.
  const seq = useRef(0);

  useScrollKeep(frameRef, sessionId);

  const refresh = useCallback(() => {
    const n = ++seq.current;
    fetchPage(folder, pointer.path)
      .then(async (html) => {
        if (n !== seq.current) return;
        setEmpty(!html.trim());
        const out = await inlinePage(html, folder, pointer, { bootstrap: scrollBootstrap() });
        if (n !== seq.current) return;
        setDoc(out);
        setError(null);
      })
      .catch((err: unknown) => n === seq.current && setError((err as Error).message));
  }, [folder, pointer]);

  useEffect(() => {
    refresh();
    return client.onContent(sessionId, () => refresh());
  }, [client, sessionId, refresh]);

  const togglePhone = () => {
    setPhone((p) => {
      localStorage.setItem(PHONE_KEY, p ? "0" : "1");
      return !p;
    });
  };
  const onExport = () => {
    setExporting(true);
    exportStandalone(folder, pointer)
      .catch((err: unknown) => setError((err as Error).message))
      .finally(() => setExporting(false));
  };

  return (
    <div className="cocreate-preview">
      <div className="cocreate-preview-head">
        <span className="cocreate-preview-path" title={pointer.path}>
          {pointer.path}
        </span>
        <div className="cocreate-modes">
          <button
            className={`cocreate-mode cocreate-learn-phone ${phone ? "active" : ""}`}
            aria-pressed={phone}
            title="Show in a phone frame"
            onClick={togglePhone}
          >
            Phone
          </button>
          <button
            className="cocreate-mode"
            disabled={exporting || doc === null}
            title="Download as one standalone .html file"
            onClick={onExport}
          >
            {exporting ? "Exporting…" : "Export"}
          </button>
        </div>
      </div>
      <div className="cocreate-preview-body cocreate-learn-body">
        {error ? (
          <div className="empty-state">{error}</div>
        ) : doc === null ? (
          <div className="empty-state">Loading…</div>
        ) : empty ? (
          <div className="empty-state">Empty page — ask the agent to build the lesson.</div>
        ) : (
          <PhoneFrame enabled={phone}>
            <iframe
              ref={frameRef}
              className="cocreate-learn-frame"
              title={pointer.path}
              // No allow-same-origin: page scripts run in an opaque origin.
              sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
              srcDoc={doc}
            />
          </PhoneFrame>
        )}
      </div>
    </div>
  );
}
