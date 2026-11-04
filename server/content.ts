// Co-create content watcher: the file is the source of truth, so watch it and
// tell clients to refetch; plus a per-turn snapshot ring for "what changed".
// Harness-agnostic — keyed off `SessionInfo.content` only.

import { watch, readFileSync, statSync, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { SessionManager } from "./sessions/manager.js";

const DEBOUNCE_MS = 150;
const MAX_SNAPSHOTS = 20;
// Same cap as the editor's text read; a bigger file isn't previewable anyway.
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

/** The file as it was when a turn began (so the latest one = before the last turn). */
export interface ContentSnapshot {
  at: number;
  version: string;
  text: string;
}

export interface ContentWatch {
  snapshots(sessionId: string): ContentSnapshot[];
  detach(): void;
}

interface Watched {
  watcher: FSWatcher | null;
  sessions: Set<string>;
  timer?: NodeJS.Timeout;
  version: string;
}

/** mtime+size: cheap, and changes on every write we care about. */
export function fileVersion(file: string): string {
  try {
    const s = statSync(file);
    return `${Math.round(s.mtimeMs)}-${s.size}`;
  } catch {
    return "missing";
  }
}

function readSnapshot(file: string): ContentSnapshot | null {
  try {
    if (statSync(file).size > MAX_SNAPSHOT_BYTES) return null;
    return { at: Date.now(), version: fileVersion(file), text: readFileSync(file, "utf8") };
  } catch {
    return null;
  }
}

export function attachContentWatch(
  manager: SessionManager,
  notify: (sessionId: string, version: string) => void,
): ContentWatch {
  const byFile = new Map<string, Watched>();
  const fileOf = new Map<string, string>();
  const snaps = new Map<string, ContentSnapshot[]>();

  const fire = (file: string) => {
    const w = byFile.get(file);
    if (!w) return;
    const version = fileVersion(file);
    if (version === w.version) return;
    w.version = version;
    for (const id of w.sessions) notify(id, version);
  };

  const add = (sessionId: string, file: string) => {
    fileOf.set(sessionId, file);
    let w = byFile.get(file);
    if (!w) {
      w = { watcher: null, sessions: new Set(), version: fileVersion(file) };
      const entry = w;
      // Watch the DIR, not the file: an atomic `mv` replace swaps the inode and
      // a file watch would go deaf after the first such write.
      try {
        entry.watcher = watch(dirname(file), (_ev, name) => {
          if (name && name.toString() !== basename(file)) return;
          clearTimeout(entry.timer);
          entry.timer = setTimeout(() => fire(file), DEBOUNCE_MS);
        });
        entry.watcher.on("error", () => entry.watcher?.close());
      } catch {
        // Dir gone/unwatchable: the pane still loads, it just won't live-update.
      }
      byFile.set(file, w);
    }
    w.sessions.add(sessionId);
  };

  const drop = (sessionId: string) => {
    const file = fileOf.get(sessionId);
    fileOf.delete(sessionId);
    snaps.delete(sessionId);
    const w = file ? byFile.get(file) : undefined;
    if (!w || !file) return;
    w.sessions.delete(sessionId);
    if (w.sessions.size) return;
    clearTimeout(w.timer);
    w.watcher?.close();
    byFile.delete(file);
  };

  const snapshot = (sessionId: string) => {
    const file = fileOf.get(sessionId);
    const snap = file ? readSnapshot(file) : null;
    if (!snap) return;
    const ring = snaps.get(sessionId) ?? [];
    if (ring.at(-1)?.text === snap.text) return;
    ring.push(snap);
    if (ring.length > MAX_SNAPSHOTS) ring.shift();
    snaps.set(sessionId, ring);
  };

  const unsub = manager.subscribe({
    onStarted(info) {
      if (!info.content) return;
      add(info.id, join(info.folder, info.content.path));
    },
    onOutput() {},
    onExit() {},
    onRemoved: drop,
    onChatEvent(sessionId, event) {
      // Sync read on the prompt itself, before the agent can have touched it.
      if (event.type === "user-message" && event.message.role !== "system")
        snapshot(sessionId);
    },
  });

  return {
    snapshots: (id) => snaps.get(id) ?? [],
    detach() {
      unsub();
      for (const id of [...fileOf.keys()]) drop(id);
    },
  };
}
