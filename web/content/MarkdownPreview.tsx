import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Client } from "../client";
import type { ContentPointer } from "../../shared/content";
import { resolveContentLink } from "../../shared/content";
import { renderMarkdown, renderTextDiff } from "../../shared/render";
import { relativeTime } from "../time";

interface SnapshotMeta {
  at: number;
  version: string;
}

const q = encodeURIComponent;

/** Rendered, read-only view of a co-create markdown file: live-refetched on the
 * server's change notice, with a diff against the file as it was at a prompt. */
export function MarkdownPreview({
  client,
  sessionId,
  folder,
  pointer,
}: {
  client: Client;
  sessionId: string;
  folder: string;
  pointer: ContentPointer;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [snaps, setSnaps] = useState<SnapshotMeta[]>([]);
  // Index into `snaps` diffed against; null = the latest (before your last prompt).
  const [baseIdx, setBaseIdx] = useState<number | null>(null);
  const [baseText, setBaseText] = useState<string | null>(null);
  const [mode, setMode] = useState<"preview" | "changes">("preview");
  const docRef = useRef<HTMLDivElement>(null);
  // Drops a stale response that lands after a newer one.
  const seq = useRef(0);

  const refresh = useCallback(() => {
    const n = ++seq.current;
    fetch(`/api/file?cwd=${q(folder)}&path=${q(pointer.path)}`)
      .then(async (r) => {
        const body = (await r.json()) as { content?: string; message?: string };
        if (n !== seq.current) return;
        if (r.ok) {
          setText(body.content ?? "");
          setError(null);
        } else setError(body.message ?? "Couldn't read the file.");
      })
      .catch(() => n === seq.current && setError("Couldn't read the file."));
    fetch(`/api/content/snapshots?session=${q(sessionId)}`)
      .then((r) => (r.ok ? (r.json() as Promise<SnapshotMeta[]>) : []))
      .then((list) => n === seq.current && setSnaps(list))
      .catch(() => {});
  }, [folder, pointer.path, sessionId]);

  useEffect(() => {
    refresh();
    return client.onContent(sessionId, () => refresh());
  }, [client, sessionId, refresh]);

  const base = baseIdx ?? snaps.length - 1;
  const baseVersion = snaps[base]?.version;
  useEffect(() => {
    if (base < 0) return setBaseText(null);
    let live = true;
    fetch(`/api/content/snapshots?session=${q(sessionId)}&i=${base}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ text: string }>) : null))
      .then((s) => live && setBaseText(s?.text ?? null))
      .catch(() => {});
    return () => {
      live = false;
    };
    // The version, not the index: a ring shift keeps the index but swaps the snapshot.
  }, [sessionId, base, baseVersion]);

  const html = useMemo(() => (text === null ? "" : renderMarkdown(text)), [text]);
  const diff = useMemo(
    () => (text !== null && baseText !== null ? renderTextDiff(baseText, text) : null),
    [text, baseText],
  );
  const changed = !!diff && diff.added + diff.removed > 0;

  // Relative images load from the folder; links never navigate the app itself.
  useLayoutEffect(() => {
    const root = docRef.current;
    if (!root || mode !== "preview") return;
    for (const img of root.querySelectorAll("img")) {
      const rel = resolveContentLink(pointer.path, img.getAttribute("src") ?? "");
      if (rel) img.src = `/api/media?cwd=${q(folder)}&path=${q(rel)}`;
    }
    for (const a of root.querySelectorAll("a")) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
  }, [html, mode, folder, pointer.path]);

  const onDocClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    const href = a?.getAttribute("href") ?? "";
    // In-document anchors and folder-relative links have nowhere to go here.
    if (a && (href.startsWith("#") || resolveContentLink(pointer.path, href) !== null))
      e.preventDefault();
  };

  return (
    <div className="cocreate-preview">
      <div className="cocreate-preview-head">
        <span className="cocreate-preview-path" title={pointer.path}>
          {pointer.path}
        </span>
        {changed && (
          <span className="cocreate-badge" title="Changed since the selected prompt">
            <span className="diff-add">+{diff!.added}</span>
            <span className="diff-del">−{diff!.removed}</span>
          </span>
        )}
        <div className="cocreate-modes" role="tablist">
          {(["preview", "changes"] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              className={`cocreate-mode ${mode === m ? "active" : ""}`}
              onClick={() => setMode(m)}
            >
              {m === "preview" ? "Preview" : "Changes"}
            </button>
          ))}
        </div>
      </div>
      {mode === "changes" && snaps.length > 0 && (
        <div className="cocreate-base">
          <span>Since</span>
          <select
            className="cocreate-base-select"
            value={base}
            onChange={(e) => {
              const i = Number(e.target.value);
              setBaseIdx(i === snaps.length - 1 ? null : i);
            }}
          >
            {snaps
              .map((s, i) => (
                <option key={s.version + i} value={i}>
                  {i === snaps.length - 1 ? "your last prompt" : `an earlier prompt · ${relativeTime(s.at)}`}
                </option>
              ))
              .reverse()}
          </select>
        </div>
      )}
      <div className="cocreate-preview-body">
        {error ? (
          <div className="empty-state">{error}</div>
        ) : text === null ? (
          <div className="empty-state">Loading…</div>
        ) : mode === "changes" ? (
          !snaps.length ? (
            <div className="empty-state">Nothing to compare yet — changes show after your first prompt.</div>
          ) : !changed ? (
            <div className="empty-state">No changes since then.</div>
          ) : (
            <div className="cocreate-diff" dangerouslySetInnerHTML={{ __html: diff!.html }} />
          )
        ) : !text.trim() ? (
          <div className="empty-state">Empty document — ask the agent to write something.</div>
        ) : (
          <div
            ref={docRef}
            className="chat-md cocreate-doc"
            onClick={onDocClick}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>
    </div>
  );
}
