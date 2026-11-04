import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DirListing, FileEntry, HarnessInfo } from "../shared/protocol";
import {
  CONTENT_TYPES,
  matchesType,
  validatePointer,
  type ContentMediaType,
  type ContentPointer,
} from "../shared/content";
import { matchEntries, splitTyped } from "./folderPath";

interface Listing {
  entries?: FileEntry[];
  error?: string;
}

// Picks a co-create session's harness + content file. Same idiom as the
// FolderPicker: the text field (relative to the folder) is the source of
// truth, the tree a view of it; a missing file is created on start.
export function ContentPicker({
  folder,
  harnesses,
  onStart,
  onClose,
}: {
  folder: string;
  harnesses: HarnessInfo[];
  onStart: (harnessId: string, content: ContentPointer) => void;
  onClose: () => void;
}) {
  const [harnessId, setHarnessId] = useState(harnesses[0]?.id ?? "");
  const [mediaType, setMediaType] = useState<ContentMediaType>("markdown");
  const type = CONTENT_TYPES[mediaType];
  const [text, setText] = useState(type.defaultName);
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [highlight, setHighlight] = useState(0);
  const inFlight = useRef<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedRow = useRef<HTMLDivElement>(null);

  const { dir, partial } = splitTyped(text.replace(/^\.?\/+/, ""));
  const dirKey = dir.replace(/\/+$/, "");

  const load = useCallback(
    (path: string) => {
      if (inFlight.current.has(path)) return;
      inFlight.current.add(path);
      fetch(`/api/files?cwd=${encodeURIComponent(folder)}&path=${encodeURIComponent(path)}`)
        .then(async (r) => {
          const body = (await r.json()) as DirListing & { message?: string };
          setListings((prev) => ({
            ...prev,
            [path]: r.ok ? { entries: body.entries } : { error: body.message || "Not readable." },
          }));
        })
        .catch(() => setListings((prev) => ({ ...prev, [path]: { error: "Not readable." } })));
    },
    [folder],
  );

  // Typed path drives the tree: load + expand root → typed directory.
  const chain = useMemo(() => {
    const segs = dirKey ? dirKey.split("/") : [];
    return ["", ...segs.map((_, i) => segs.slice(0, i + 1).join("/"))];
  }, [dirKey]);
  useEffect(() => {
    for (const p of chain) if (!listings[p]) load(p);
    setExpanded((prev) =>
      chain.every((p) => prev.has(p)) ? prev : new Set([...prev, ...chain]),
    );
  }, [chain, listings, load]);

  // Only dirs and files of this media type are worth showing.
  const visible = useCallback(
    (entries: FileEntry[]) =>
      entries.filter((e) => e.type === "dir" || matchesType(mediaType, e.name)),
    [mediaType],
  );
  const siblings = visible(listings[dirKey]?.entries ?? []);
  const candidates = useMemo(() => matchEntries(siblings, partial), [siblings, partial]);
  const selected = candidates[Math.min(highlight, candidates.length - 1)] ?? null;
  useEffect(() => setHighlight(0), [dirKey, partial]);
  useEffect(() => selectedRow.current?.scrollIntoView({ block: "nearest" }), [selected?.path]);
  useEffect(() => inputRef.current?.focus(), []);

  const pointer = validatePointer({ mediaType, path: text });
  const dirListing = listings[dirKey];
  // Missing is only knowable once the parent is listed (or proven absent).
  const missing =
    !!pointer &&
    (!!dirListing?.error ||
      (!!dirListing?.entries &&
        !dirListing.entries.some((e) => e.type === "file" && e.name === partial)));
  const canStart = !!pointer && !!harnessId;

  const complete = (entry: FileEntry) => {
    setText(entry.type === "dir" ? `${entry.path}/` : entry.path);
    inputRef.current?.focus();
  };
  const submit = () => {
    if (canStart) onStart(harnessId, pointer!);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return onClose();
    if (e.key === "Enter") {
      // An unfinished name with a match completes (like Tab); otherwise start.
      if (selected && (selected.type === "dir" || !pointer)) return complete(selected);
      return submit();
    }
    if (e.key === "Tab") {
      if (!selected) return;
      e.preventDefault();
      return complete(selected);
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const n = candidates.length;
    if (n === 0) return;
    const step = e.key === "ArrowDown" ? 1 : -1;
    setHighlight((h) => (Math.min(h, n - 1) + step + n) % n);
  };

  const toggle = (path: string) => {
    if (!listings[path]) load(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  // Plain recursive function, not a nested component (would remount per keystroke).
  const rows = (path: string, depth: number) => {
    const listing = listings[path];
    if (!listing) return <div className="picker-note" style={indent(depth)}>Loading…</div>;
    if (listing.error)
      return <div className="picker-note" style={indent(depth)}>{listing.error}</div>;
    const entries = visible(listing.entries!);
    if (entries.length === 0)
      return <div className="picker-note" style={indent(depth)}>No {type.label} files</div>;
    return entries.map((entry) => {
      const isDir = entry.type === "dir";
      const open = isDir && expanded.has(entry.path);
      const isSelected = selected?.path === entry.path;
      return (
        <div key={entry.path}>
          <div
            className={`picker-row ${isSelected ? "selected" : ""} ${
              entry.path === pointer?.path ? "current" : ""
            }`}
            ref={isSelected ? selectedRow : undefined}
          >
            {isDir ? (
              <button
                className="picker-caret"
                style={indent(depth)}
                aria-label={open ? "Collapse" : "Expand"}
                onClick={() => toggle(entry.path)}
              >
                {open ? "▾" : "▸"}
              </button>
            ) : (
              // Invisible caret keeps file names aligned with folder names.
              <span className="picker-caret" style={{ ...indent(depth), visibility: "hidden" }}>
                ▸
              </span>
            )}
            <button className="picker-name" onClick={() => complete(entry)} title={entry.path}>
              {isDir ? `${entry.name}/` : entry.name}
            </button>
          </div>
          {open && rows(entry.path, depth + 1)}
        </div>
      );
    });
  };

  return (
    <div className="resume-overlay" onClick={onClose}>
      <div className="resume-dialog folder-picker" onClick={(e) => e.stopPropagation()}>
        <div className="resume-dialog-head">
          <span>Co-create</span>
          <button className="resume-dialog-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="cocreate-picker-opts">
          <div className="cocreate-harnesses" role="radiogroup" aria-label="Agent">
            {harnesses.map((h) => (
              <button
                key={h.id}
                role="radio"
                aria-checked={h.id === harnessId}
                className={`cocreate-harness ${h.id === harnessId ? "active" : ""}`}
                onClick={() => setHarnessId(h.id)}
              >
                {h.name}
              </button>
            ))}
          </div>
          <select
            className="cocreate-type"
            aria-label="Content type"
            value={mediaType}
            onChange={(e) => setMediaType(e.target.value as ContentMediaType)}
          >
            {Object.entries(CONTENT_TYPES).map(([id, t]) => (
              <option key={id} value={id}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="picker-input-row">
          <input
            ref={inputRef}
            className="cwd-input"
            placeholder={type.defaultName}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button className="picker-add" disabled={!canStart} onClick={submit}>
            {missing ? "Create" : "Open"}
          </button>
        </div>
        <div className="resume-dialog-body picker-tree">{rows("", 0)}</div>
        {(missing || (text.trim() && !pointer)) && (
          <div className="picker-status">
            {!pointer
              ? `Pick a ${type.extensions.join(" / ")} file inside this folder.`
              : "No such file — it will be created."}
          </div>
        )}
      </div>
    </div>
  );
}

const indent = (depth: number) => ({ paddingLeft: `${4 + depth * 14}px` });
