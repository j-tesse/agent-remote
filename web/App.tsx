import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  AssistantSettings,
  ContinuityNewSession,
  FolderInfo,
  HarnessInfo,
  ResumableSession,
  SessionInfo,
  ViewState,
} from "../shared/protocol";
import {
  ALLOW_EVERYTHING,
  AUTO_DELAY_MAX_SCALE,
  AUTO_DELAY_TYPICAL_SEC,
  assistantNeedsLlm,
  deriveAssistantEnabled,
  isAllowEverything,
} from "../shared/chat";
import { Client, type CtrlMode } from "./client";
import { TerminalView } from "./TerminalView";
// Lazy-loaded: pulls in CodeMirror + language packs only once a file-edit tab
// is opened, keeping the initial (terminal-first) bundle small.
const FileEditor = lazy(() =>
  import("./FileEditor").then((m) => ({ default: m.FileEditor })),
);
// Lazy-loaded: pulls in the markdown renderer only once a chat session exists.
const ChatView = lazy(() =>
  import("./ChatView").then((m) => ({ default: m.ChatView })),
);
// Dev colour-scheme tool; lazy so it costs nothing unless #theme is in the URL.
const ThemeEditor = lazy(() => import("./ThemeEditor"));
// Host telemetry page; lazy since it's a side trip, and unmounting it is what
// stops its poll (and so the server's sampler).
const SystemState = lazy(() => import("./SystemState"));
import { useThemeEditorOpen } from "./theme";
import { CommandBuilder } from "./CommandBuilder";
import { FolderPicker } from "./FolderPicker";
import { Login } from "./Login";
import { fetchMe, logout } from "./auth";
import { SettingsButton, SettingsPage } from "./Settings";
import { displayPath, folderName } from "./paths";
import { relativeTime } from "./time";

// Client-only "file edit" tab: lives alongside PTY sessions but is backed by
// /api/files, not a harness — tracked here in the UI, never by the manager.
interface EditorTab {
  id: string;
  folder: string;
  /** Base name of the currently open file, for the tab subtitle; null in the
   * file-picker step. */
  file: string | null;
}

// Per-chat-session AI-assistant mode. The BACKEND owns this (it lives in the
// session's ChatState and the server acts even with no browser open); the UI
// just reads it from ChatState and writes it back via `set-assistant`.
// Must match `emptyChatState()`: every capability starts off (so the derived
// master switch starts off too), with their sub-options pre-set to what a user
// who ticks one usually wants — blanket-accept permissions, auto-merge for PRs.
type Page = "system" | "settings";
const pageFromHash = (): Page | null =>
  window.location.hash === "#system"
    ? "system"
    : window.location.hash === "#settings"
      ? "settings"
      : null;

const DEFAULT_ASSISTANT: AssistantSettings = {
  enabled: false,
  permissions: { enabled: false, instructions: ALLOW_EVERYTHING },
  questions: { enabled: false, instructions: "", onlyIfSure: false },
  autoPr: { enabled: false, instructions: "", autoMerge: true },
  continuity: { enabled: false, instructions: "", newSession: "after-pr" },
};

/** The checklist sections of the assistant dialog. */
type SectionKey = "permissions" | "questions" | "autoPr" | "continuity";

// Tracks the on-screen keyboard via the visual viewport. `height` is the
// visible height the app is pinned to while the keyboard is up. `open` stays
// false on desktop, so keyboard-gated UI never shows there.
function useKeyboard(): { open: boolean; height: number } {
  const [state, setState] = useState({ open: false, height: 0 });
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    // Largest height seen = no-keyboard height; works whether the keyboard
    // shrinks the visual or the layout viewport.
    let maxHeight = Math.max(vv.height, window.innerHeight);
    const onChange = () => {
      maxHeight = Math.max(maxHeight, vv.height);
      const open = maxHeight - vv.height > 120;
      setState({ open, height: Math.round(vv.height) });
    };
    onChange();
    vv.addEventListener("resize", onChange);
    vv.addEventListener("scroll", onChange);
    return () => {
      vv.removeEventListener("resize", onChange);
      vv.removeEventListener("scroll", onChange);
    };
  }, []);
  return state;
}

// Material Design `keyboard_arrow_*` icon paths (24x24 viewBox). Drawn with
// `currentColor` so they inherit the button's text/accent color.
const ARROW_PATHS = {
  up: "M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z",
  down: "M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z",
  left: "M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6z",
  right: "M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z",
} as const;

// Material icons used on the group toggle: a d-pad (positional keys) and a
// keyboard (everything else).
const NAV_ICON =
  "M10 9h4V6h3l-5-5-5 5h3v3zm-1 1H6V7l-5 5 5 5v-3h3v-4zm14 2l-5-5v3h-3v4h3v3l5-5zm-9 3h-4v3H8l5 5 5-5h-3v-3z";
const KEYBOARD_ICON =
  "M20 5H4c-1.1 0-1.99.9-1.99 2L2 17c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-9 3h2v2h-2V8zm0 3h2v2h-2v-2zM8 8h2v2H8V8zm0 3h2v2H8v-2zm-1 2H5v-2h2v2zm0-3H5V8h2v2zm9 7H8v-2h8v2zm0-4h-2v-2h2v2zm0-3h-2V8h2v2zm3 3h-2v-2h2v2zm0-3h-2V8h2v2z";
// Material `select_all` (dashed marquee): toggles touch text-selection mode.
const SELECT_ICON =
  "M3 5h2V3c-1.1 0-2 .9-2 2zm0 8h2v-2H3v2zm4 8h2v-2H7v2zM3 9h2V7H3v2zm10-6h-2v2h2V3zm6 0v2h2c0-1.1-.9-2-2-2zM5 21v-2H3c0 1.1.9 2 2 2zm-2-4h2v-2H3v2zM9 3H7v2h2V3zm2 18h2v-2h-2v2zm8-8h2v-2h-2v2zm0 8c1.1 0 2-.9 2-2h-2v2zm0-12h2V7h-2v2zm0 8h2v-2h-2v2zm-4 4h2v-2h-2v2zm0-16h2V3h-2v2z";
const EDIT_ICON =
  "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z";
// Terminal prompt chevron + underline bar.
const TERMINAL_ICON = "M6.4 16L5 14.6l3.6-3.6L5 7.4 6.4 6l5 5-5 5zM13 16v-2h6v2h-6z";
// Sparkles — stands in for an AI coding agent.
const SPARKLE_ICON =
  "M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 15z";
// The Greek letter π (bar + two legs).
const PI_ICON = "M4 5h16v3H4zM6.5 8h3v11h-3zM14.5 8h3v11h-3z";
// Material `smart_toy` (robot head) — the optional LLM UI assistant.
const ROBOT_ICON =
  "M20 9V7c0-1.1-.9-2-2-2h-3c0-1.66-1.34-3-3-3S9 3.34 9 5H6c-1.1 0-2 .9-2 2v2c-1.66 0-3 1.34-3 3s1.34 3 3 3v4c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-4c1.66 0 3-1.34 3-3s-1.34-3-3-3zM7.5 11.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5S9.83 13 9 13s-1.5-.67-1.5-1.5zM16 17H8v-2h8v2zm-1-4c-.83 0-1.5-.67-1.5-1.5S14.17 10 15 10s1.5.67 1.5 1.5S15.83 13 15 13z";

// Material `desktop_windows` (monitor + stand) — for the local agent harness.
const COMPUTER_ICON =
  "M20 3H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h5v2H7v2h10v-2h-2v-2h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 13H4V5h16v11z";

// Per-harness glyphs, keyed by adapter id. Unknown harnesses fall back to a
// first-letter badge, so new adapters still render without a UI change.
const HARNESS_ICONS: Record<string, string> = {
  claude: SPARKLE_ICON,
  "claude-local": COMPUTER_ICON,
  pi: PI_ICON,
  terminal: TERMINAL_ICON,
};

// The one harness pulled out as a direct button on mobile (rest fold into [+]).
const QUICK_HARNESS_ID = "terminal";

function Icon({ path }: { path: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      <path d={path} />
    </svg>
  );
}

function Arrow({ dir }: { dir: keyof typeof ARROW_PATHS }) {
  return <Icon path={ARROW_PATHS[dir]} />;
}

// A harness's icon, or a first-letter badge when it has no registered glyph.
function HarnessGlyph({ id, name }: { id: string; name: string }) {
  const path = HARNESS_ICONS[id];
  return path ? (
    <Icon path={path} />
  ) : (
    <span className="harness-letter">{name[0]}</span>
  );
}

// Keys a mobile keyboard lacks but terminals need, split into two groups
// (arrows / everything else). Plain key sends `seq`; `toggle` (Ctrl) arms a
// sticky modifier applied to the next keystroke.
type KeyDef = { label: ReactNode; aria: string; seq?: string; toggle?: boolean };

type KeyGroup = "keys" | "arrows";

const KEY_GROUPS: Record<KeyGroup, KeyDef[]> = {
  keys: [
    { label: "Esc", aria: "Escape", seq: "\x1b" },
    { label: "Tab", aria: "Tab", seq: "\t" },
    { label: "Ctrl", aria: "Control", toggle: true },
    { label: "⏎", aria: "Newline", seq: "\n" },
    { label: "/", aria: "Slash", seq: "/" },
    { label: "`", aria: "Backtick", seq: "`" },
  ],
  arrows: [
    { label: <Arrow dir="up" />, aria: "Up arrow", seq: "\x1b[A" },
    { label: <Arrow dir="down" />, aria: "Down arrow", seq: "\x1b[B" },
    { label: <Arrow dir="left" />, aria: "Left arrow", seq: "\x1b[D" },
    { label: <Arrow dir="right" />, aria: "Right arrow", seq: "\x1b[C" },
    { label: "Home", aria: "Home", seq: "\x1b[H" },
    { label: "End", aria: "End", seq: "\x1b[F" },
  ],
};

// Shift+Tab (CSI Z, "back-tab") — mode/permission cycle in Claude & pi. Shown
// after Tab only while an agent is running (meaningless at a shell prompt).
const SHIFT_TAB_KEY: KeyDef = { label: "⇧Tab", aria: "Shift Tab", seq: "\x1b[Z" };

// AI coding-agent harnesses; their sessions always want Shift+Tab even when idle.
const AGENT_HARNESS_IDS = new Set(["claude", "claude-local", "pi"]);

// True when a live command line is an agent CLI (e.g. `claude`/`pi` launched
// from a Terminal session, where only the running command reveals the agent).
function isAgentCommand(command: string | null): boolean {
  if (!command) return false;
  const bin = command.trim().split(/\s+/)[0]?.split("/").pop() ?? "";
  return AGENT_HARNESS_IDS.has(bin);
}

// Session-row subtitle. A session that has `cd`'d away still lives in its launch
// folder's tabs, so name where it actually is instead of a bare "running".
function sessionMeta(s: SessionInfo, home: string): string {
  // A session we killed ourselves exits non-zero by definition (SIGTERM); an
  // exit code there would read as a failure.
  if (s.status === "exited")
    return s.stopped ? "closed" : `exited (${s.exitCode ?? "?"})`;
  if (s.currentCommand) return s.currentCommand;
  return s.cwd === s.folder ? "running" : displayPath(s.cwd, home);
}

export function App() {
  // Auth gate: undefined = still checking, null = logged out, string = username.
  const [user, setUser] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    fetchMe().then(setUser);
  }, []);

  if (user === undefined) return <div className="app loading" />;
  if (user === null) {
    return <Login onAuthed={() => fetchMe().then(setUser)} />;
  }
  return <Workspace username={user} onLogout={() => setUser(null)} />;
}

function Workspace({
  username,
  onLogout,
}: {
  username: string;
  onLogout: () => void;
}) {
  const themeEditorOpen = useThemeEditorOpen();
  const client = useMemo(() => new Client(), []);
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>([]);
  // Listed sessions only; hidden (soft-removed nested) ones are in `heldIds`.
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  // Every session the client still holds, incl. hidden — for inline views.
  const [heldIds, setHeldIds] = useState<ReadonlySet<string>>(() => new Set());
  // Client-only file-editor tabs (see EditorTab).
  const [editors, setEditors] = useState<EditorTab[]>([]);
  const [folders, setFolders] = useState<FolderInfo[]>([]);
  // Server-side $HOME, so stored absolute paths can be shown as `~/…`.
  const [home, setHome] = useState("");
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  // Which session is shown for each folder.
  const [activeSession, setActiveSession] = useState<Record<string, string>>({});
  // Server-persisted last view, applied once on load (see the restore effect):
  // until then nothing else may pick a default folder, and nothing is saved.
  const storedView = useRef<ViewState | null>(null);
  const [viewRestored, setViewRestored] = useState(false);
  const [viewFetched, setViewFetched] = useState(false);
  // First WS snapshots have landed — the restore needs them to validate its ids.
  const [snapshotSeen, setSnapshotSeen] = useState(false);
  // Resumable (closed) chat sessions for the active folder, from /api/resumable.
  const [resumable, setResumable] = useState<ResumableSession[]>([]);
  // Resume-session picker dialog (opened from the chat header's Resume button).
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  // AI-assistant settings of the active chat session, mirrored from its
  // backend-owned ChatState (null when the active tab isn't a chat session).
  const [activeAssistant, setActiveAssistant] =
    useState<AssistantSettings | null>(null);
  // Health of the optional LLM endpoint (polled), for the assistant button color.
  const [llmAvailable, setLlmAvailable] = useState(false);
  // AI-assistant config dialog + its working draft.
  const [assistantDialogOpen, setAssistantDialogOpen] = useState(false);
  const [assistantDraft, setAssistantDraft] =
    useState<AssistantSettings>(DEFAULT_ASSISTANT);
  // Pending debounced push of the instruction textareas (see pushAssistant).
  const assistantPush = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  // Narrow viewport: collapse the inline new-session buttons into the [+] menu.
  const [isNarrow, setIsNarrow] = useState(
    () => window.matchMedia("(max-width: 640px)").matches
  );
  // Off-canvas sidebar drawer (mobile only; ignored on desktop via CSS).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Folder-independent pages (System state, Settings). Hash-gated like the
  // theme editor (this app has no router), so a reload keeps it — deliberately
  // NOT in the server-persisted ViewState, which would hide the folder you were
  // working in on other devices.
  const [page, setPage] = useState<Page | null>(() => pageFromHash());
  const systemOpen = page === "system";
  const keyboard = useKeyboard();
  const [ctrlMode, setCtrlMode] = useState<CtrlMode>("off");
  const [keyGroup, setKeyGroup] = useState<KeyGroup>("keys");
  // Touch text-selection mode, applied to the active terminal.
  const [selectMode, setSelectMode] = useState(false);
  // Command-builder dialog (opened from the ./ key-bar button).
  const [builderOpen, setBuilderOpen] = useState(false);
  const knownIds = useRef<Set<string>>(new Set());
  // Set on add: the stored path is the server's to normalize, not ours to guess.
  const pendingFolderSelect = useRef(false);
  const addMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    client.connect();
    fetch("/api/harnesses")
      .then((r) => r.json())
      .then(setHarnesses)
      .catch(() => setHarnesses([]));
    // onSessions/onFolders replay their current value *synchronously* on
    // subscribe (empty at mount) — only a later call is a message off the wire.
    // The server sends `folders` before `sessions`, so that one means both
    // snapshots landed; treating the replay as the snapshot restored the view
    // against an empty folder list, i.e. never.
    let replaying = true;
    const offSessions = client.onSessions((next) => {
      setSessions(next.filter((s) => !s.hidden));
      setHeldIds(new Set(next.map((s) => s.id)));
      if (!replaying) setSnapshotSeen(true);
    });
    fetch("/api/view")
      .then((r) => (r.ok ? r.json() : null))
      .then((v: ViewState | null) => {
        storedView.current = v;
      })
      .catch(() => {})
      .finally(() => setViewFetched(true));
    const offFolders = client.onFolders((next, serverHome) => {
      setFolders(next);
      setHome(serverHome);
    });
    const offCtrl = client.onCtrl(setCtrlMode);
    replaying = false;
    return () => {
      offSessions();
      offFolders();
      offCtrl();
      client.disconnect();
    };
  }, [client]);

  // Poll the optional LLM endpoint's health (best-effort; drives the assistant
  // button color and gates evaluation). Failure just means "unavailable".
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      fetch("/api/llm-status")
        .then((r) => (r.ok ? r.json() : { available: false }))
        .then((s: { available?: boolean }) => {
          if (!cancelled) setLlmAvailable(!!s.available);
        })
        .catch(() => {
          if (!cancelled) setLlmAvailable(false);
        });
    };
    check();
    const t = setInterval(check, 20000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // Auto-select newly created sessions: focus their folder and make them active.
  // Nested sessions (auto-PR agent) are skipped: watched inline, opened on demand.
  useEffect(() => {
    let created: SessionInfo | null = null;
    for (const s of sessions) {
      if (!knownIds.current.has(s.id)) {
        knownIds.current.add(s.id);
        // Agent-spawned tabs too: they'd yank focus from the session you're watching.
        if (!s.parentId && !s.spawnedBy) created = s;
      }
    }
    if (created) {
      const folder = created.folder;
      setActiveFolder(folder);
      setActiveSession((prev) => ({ ...prev, [folder]: created!.id }));
    }
  }, [sessions]);

  // Drop active-tab pins whose tab no longer exists (a session was closed, or an
  // editor tab was closed), so the per-folder fallback can pick another tab.
  useEffect(() => {
    setActiveSession((prev) => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const [folder, id] of Object.entries(prev)) {
        if (sessions.some((s) => s.id === id) || editors.some((e) => e.id === id))
          next[folder] = id;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [sessions, editors]);

  // Adopt the server's stored path for a folder we just added (see submitNewFolder).
  useEffect(() => {
    if (!pendingFolderSelect.current || folders.length === 0) return;
    pendingFolderSelect.current = false;
    setActiveFolder(folders[0].path);
  }, [folders]);

  // Restore the server-persisted view, once, on load. Runs after the snapshots
  // so ids can be validated, and after the auto-select-new-session effect above
  // (which treats the whole first batch as new) so it wins over it.
  useEffect(() => {
    if (viewRestored || !viewFetched || !snapshotSeen) return;
    setViewRestored(true);
    const view = storedView.current;
    const folder = view?.folder;
    if (!folder || !folders.some((f) => f.path === folder)) return;
    setActiveFolder(folder);
    // A stale id (session closed, or a client-only editor tab) just falls back.
    if (view.sessionId && sessions.some((s) => s.id === view.sessionId)) {
      setActiveSession((prev) => ({ ...prev, [folder]: view.sessionId! }));
    }
  }, [viewRestored, viewFetched, snapshotSeen, folders, sessions]);

  // Default to the most-recent folder once folders arrive — but never before
  // the restore ran, or it would race the stored folder.
  useEffect(() => {
    if (viewRestored && activeFolder === null && folders.length > 0) {
      setActiveFolder(folders[0].path);
    }
  }, [folders, activeFolder, viewRestored]);

  // Refetched on folder change and when the live session set changes (closing a
  // session makes it resumable, resuming one hides it).
  const refreshResumable = useCallback(() => {
    if (activeFolder === null) {
      setResumable([]);
      return;
    }
    fetch(`/api/resumable?cwd=${encodeURIComponent(activeFolder)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setResumable)
      .catch(() => setResumable([]));
  }, [activeFolder]);
  useEffect(() => {
    refreshResumable();
  }, [refreshResumable, sessions]);
  // A folder switch invalidates the (per-folder) resume list; close the dialog.
  useEffect(() => {
    setResumeDialogOpen(false);
  }, [activeFolder]);
  // The assistant dialog is scoped to the active session; close it on a switch.
  useEffect(() => {
    setAssistantDialogOpen(false);
  }, [activeFolder]);

  const forgetResumable = (key: string) => {
    void fetch(`/api/resumable?key=${encodeURIComponent(key)}`, {
      method: "DELETE",
    }).finally(refreshResumable);
  };

  // Close the add-session dropdown on an outside click.
  useEffect(() => {
    if (!addMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setAddMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [addMenuOpen]);

  // Track the 640px breakpoint (matches the CSS media queries) to switch the
  // new-session buttons between inline (wide) and the [+] menu (narrow).
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const on = () => setIsNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  // Keep the URL in step so a reload lands back where you were. replaceState
  // (not pushState): the page is a toggle, not a history entry, and it must not
  // fire hashchange back at useThemeEditorOpen.
  useEffect(() => {
    const want = page ? `#${page}` : "";
    if (window.location.hash === "#theme") return; // theme editor owns the hash
    if (window.location.hash === want) return;
    window.history.replaceState(null, "", want || window.location.pathname);
  }, [page]);

  const openFolder = (path: string) => {
    // Viewing doesn't reorder the list — recency is driven by input activity
    // (server bumps the folder on keystrokes).
    setActiveFolder(path);
    setSelectorOpen(false);
    setSidebarOpen(false);
    // Picking a folder leaves the system/settings page: one way in, one way out.
    setPage(null);
  };

  const submitNewFolder = (path: string) => {
    if (!path) return;
    client.addFolder(path);
    // The server normalizes the path (`~` expansion, trailing slash), so never
    // guess it here — select what it actually stored, which an add sorts first.
    pendingFolderSelect.current = true;
    setFolderPickerOpen(false);
    setSidebarOpen(false);
  };

  const removeFolderAt = (path: string) => {
    client.removeFolder(path);
    // If we just removed the open folder, fall back to another one so the
    // main pane doesn't point at a folder that's no longer listed.
    setActiveFolder((cur) =>
      cur === path
        ? (folders.find((f) => f.path !== path)?.path ?? null)
        : cur,
    );
  };

  const handleLogout = async () => {
    await logout();
    client.disconnect();
    onLogout();
  };

  // By launch folder, never live `cwd` — a `cd` must not re-parent a session
  // into another folder's tabs (or out of every folder, hiding it entirely).
  const sessionsInFolder = sessions.filter((s) => s.folder === activeFolder);
  const editorsInFolder = editors.filter((e) => e.folder === activeFolder);
  const tabCount = sessionsInFolder.length + editorsInFolder.length;
  // The pin is only honoured if it names a tab of *this* folder — terminals are
  // all mounted at once and shown purely on an id match, so a foreign pin would
  // paint another folder's session over an empty tab list.
  const pinned = activeFolder !== null ? activeSession[activeFolder] : undefined;
  const pinnedHere =
    pinned !== undefined &&
    (sessionsInFolder.some((s) => s.id === pinned) ||
      editorsInFolder.some((e) => e.id === pinned));
  const activeSessionId =
    activeFolder !== null
      ? ((pinnedHere ? pinned : undefined) ??
        editorsInFolder[editorsInFolder.length - 1]?.id ??
        sessionsInFolder[sessionsInFolder.length - 1]?.id ??
        null)
      : null;
  const activeSessionObj = sessionsInFolder.find((s) => s.id === activeSessionId);
  const activeExited = activeSessionObj?.status === "exited";

  // Jumping to a session named by an AI-mode note (auto-PR's `/pr` tab). Its own
  // launch folder is authoritative — the note's origin is normally in the same
  // one, but pinning a tab under the wrong folder key would hide it.
  const sessionIds = useMemo(
    () => new Set(sessions.map((s) => s.id)),
    [sessions],
  );
  const openSession = useCallback(
    (id: string) => {
      const target = sessions.find((s) => s.id === id);
      if (!target) return;
      setActiveFolder(target.folder);
      setActiveSession((prev) => ({ ...prev, [target.folder]: id }));
    },
    [sessions],
  );

  // Persist the view for the *next* page load (any device). Debounced, and never
  // before the restore, or the initial default would overwrite what we stored.
  useEffect(() => {
    if (!viewRestored) return;
    const t = setTimeout(() => {
      void fetch("/api/view", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          folder: activeFolder,
          sessionId: activeSessionId,
        } satisfies ViewState),
      }).catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [viewRestored, activeFolder, activeSessionId]);

  const activeIsEditor = editorsInFolder.some((e) => e.id === activeSessionId);
  // Chat sessions have their own composer; terminal-only UI (key-bar, select
  // mode, command builder) is gated off for them.
  const activeIsChat = activeSessionObj?.ui === "chat";
  // /resume should only offer sessions from the same harness as the active
  // chat tab — resuming a claude session in pi (or vice-versa) is nonsense.
  const resumableForActive = activeSessionObj
    ? resumable.filter((r) => r.harnessId === activeSessionObj.harnessId)
    : resumable;
  // Mirror the active chat session's backend-owned assistant settings so the
  // header button/dialog reflect what the server will actually do (and update
  // live when another client or the backend changes it).
  useEffect(() => {
    if (!activeIsChat || activeSessionId === null) {
      setActiveAssistant(null);
      return;
    }
    const { initial, unsubscribe } = client.subscribeChat(
      activeSessionId,
      (s) => setActiveAssistant(s.assistant),
    );
    setActiveAssistant(initial.assistant);
    return unsubscribe;
  }, [client, activeSessionId, activeIsChat]);

  const assistantEnabled = !!activeAssistant?.enabled;
  const needsLlm = assistantNeedsLlm(activeAssistant ?? DEFAULT_ASSISTANT);

  // The dialog has no Save button — every change applies at once. Checkboxes
  // push immediately; the instruction textareas debounce so a keystroke isn't a
  // round trip. While the dialog is open `assistantDraft` stays authoritative,
  // so an echo can't fight the caret.
  const pushAssistant = useCallback(
    (next: AssistantSettings, debounce = false) => {
      if (activeSessionId === null) return;
      if (assistantPush.current) clearTimeout(assistantPush.current);
      assistantPush.current = null;
      const send = () =>
        client.chatAction(activeSessionId, {
          type: "set-assistant",
          // Recomputed server-side too; sending it keeps the local read honest
          // until the broadcast lands.
          settings: { ...next, enabled: deriveAssistantEnabled(next) },
        });
      if (!debounce) return send();
      assistantPush.current = setTimeout(send, 300);
    },
    [client, activeSessionId],
  );

  /** Flush a pending debounced push (dialog close, "Run now"). */
  const flushAssistant = useCallback(() => {
    if (!assistantPush.current) return;
    clearTimeout(assistantPush.current);
    assistantPush.current = null;
    pushAssistant(assistantDraft);
  }, [pushAssistant, assistantDraft]);

  const closeAssistantDialog = useCallback(() => {
    flushAssistant();
    setAssistantDialogOpen(false);
  }, [flushAssistant]);

  // The button always opens the dialog: with several capabilities, editing them
  // (and "Run now") must stay reachable while the assistant is already on.
  // Turning everything off is now unticking the boxes.
  const onAssistantButton = () => {
    if (activeSessionId === null) return;
    const cur = activeAssistant ?? DEFAULT_ASSISTANT;
    // Opening must never change a setting — seed the draft verbatim.
    setAssistantDraft(cur);
    setAssistantDialogOpen(true);
  };

  /** Patch one capability and apply it: at once for checkboxes, debounced for
   * the free-text boxes. */
  function patchSection<K extends SectionKey>(
    key: K,
    patch: Partial<AssistantSettings[K]>,
    debounce = false,
  ) {
    const next = {
      ...assistantDraft,
      [key]: { ...assistantDraft[key], ...patch },
    };
    setAssistantDraft(next);
    pushAssistant(next, debounce);
  }

  const assistantSection = (
    key: SectionKey,
    label: string,
    body: ReactNode,
    action?: ReactNode,
  ) => {
    const on = assistantDraft[key].enabled;
    return (
      <div className="assistant-section" data-on={on}>
        {/* Sections never collapse — the head is a plain label for its box. */}
        <div className="assistant-section-head">
          <label className="assistant-section-toggle">
            <input
              type="checkbox"
              checked={on}
              onChange={(e) => patchSection(key, { enabled: e.target.checked })}
            />
            <span className="assistant-section-label">{label}</span>
          </label>
          {action}
        </div>
        <div className="assistant-section-body">{body}</div>
      </div>
    );
  };

  // Shown as the typical wait (100% = 5s), stored as a factor on the curve.
  const permissionsTypicalWait =
    (assistantDraft.permissions.delayScale ?? 1) * AUTO_DELAY_TYPICAL_SEC;

  /** A sub-option checkbox, right-aligned in the instructions row. */
  const assistantOption = (
    text: string,
    checked: boolean,
    onChange: (v: boolean) => void,
    title?: string,
  ) => (
    <label className="assistant-opt" title={title}>
      {text}
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );

  /** The instructions box shared by every section. */
  const assistantInstructions = (
    key: SectionKey,
    placeholder: string,
    extra?: ReactNode,
    label = "Instructions (optional)",
  ) => (
    <div className="assistant-field">
      <div className="assistant-field-head">
        <label
          className="assistant-field-label"
          htmlFor={`assistant-instructions-${key}`}
        >
          {label}
        </label>
        {extra && <div className="assistant-field-extra">{extra}</div>}
      </div>
      <textarea
        id={`assistant-instructions-${key}`}
        className="assistant-instructions"
        rows={2}
        placeholder={placeholder}
        value={assistantDraft[key].instructions}
        onChange={(e) =>
          patchSection(key, { instructions: e.target.value }, true)
        }
      />
    </div>
  );

  // Show the Shift+Tab key when the active session is an agent — either a
  // claude/pi harness, or a Terminal session currently running one of them.
  const agentRunning =
    !!activeSessionObj &&
    (AGENT_HARNESS_IDS.has(activeSessionObj.harnessId) ||
      isAgentCommand(activeSessionObj.currentCommand));

  // Open a new file-editor tab in the active folder and focus it.
  const openEditor = () => {
    if (activeFolder === null) return;
    const id =
      crypto.randomUUID?.() ?? `editor-${Date.now()}-${Math.random()}`;
    setEditors((prev) => [...prev, { id, folder: activeFolder, file: null }]);
    setActiveSession((prev) => ({ ...prev, [activeFolder]: id }));
    setAddMenuOpen(false);
  };

  const closeEditor = (id: string) => {
    setEditors((prev) => prev.filter((e) => e.id !== id));
  };

  // Idempotent so FileEditor calling it every render can't loop re-renders.
  const setEditorFile = useCallback((id: string, file: string | null) => {
    setEditors((prev) => {
      const cur = prev.find((e) => e.id === id);
      if (!cur || cur.file === file) return prev;
      return prev.map((e) => (e.id === id ? { ...e, file } : e));
    });
  }, []);

  // Selection mode is per active terminal; reset it when the active one changes.
  useEffect(() => {
    setSelectMode(false);
    setBuilderOpen(false);
  }, [activeSessionId]);

  // Exited session: Enter/Escape = the "Close session" button (desktop).
  useEffect(() => {
    if (!activeExited || activeSessionId === null) return;
    if (
      builderOpen ||
      resumeDialogOpen ||
      assistantDialogOpen ||
      selectorOpen ||
      folderPickerOpen
    )
      return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== "Escape") return;
      e.preventDefault();
      client.remove(activeSessionId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    client,
    activeExited,
    activeSessionId,
    builderOpen,
    resumeDialogOpen,
    assistantDialogOpen,
    selectorOpen,
    folderPickerOpen,
  ]);

  return (
    <div
      className="app"
      // Pin to the visual-viewport height while the keyboard is up so content
      // can't pan under it (dvh alone doesn't shrink for the keyboard).
      style={keyboard.open ? { height: keyboard.height } : undefined}
    >
      <button
        className="menu-toggle"
        onClick={() => setSidebarOpen(true)}
        aria-label="Open menu"
      >
        ☰
      </button>
      {sidebarOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="sidebar-header">
          <h1>agent-remote</h1>
          <SettingsButton
            active={page === "settings"}
            onOpen={() => {
              setPage("settings");
              setSidebarOpen(false);
            }}
          />
        </div>

        {/* Above Folders: it's about the box, not about any one project. */}
        <nav className="sidebar-nav">
          <div className={`folder-item ${systemOpen ? "active" : ""}`}>
            <button
              className="folder-item-open"
              onClick={() => {
                setPage("system");
                // As openFolder: on mobile the drawer covers what we opened.
                setSidebarOpen(false);
              }}
            >
              <span className="folder-name">System state</span>
              <span className="folder-path">CPU · GPU · LLM · Docker</span>
            </button>
          </div>
        </nav>

        <section className="folder-list">
          <div className="folder-list-head">
            <label className="field-label">Folders</label>
            <button
              className="add-folder-button"
              onClick={() => setFolderPickerOpen(true)}
            >
              + Add
            </button>
          </div>
          {folders.length === 0 && (
            <p className="muted">No folders yet. Add one with “+ Add”.</p>
          )}
          {folders.map((f) => (
            <div
              key={f.path}
              // `activeFolder` deliberately survives opening the system page
              // (its subtree stays mounted so scrollback/unsaved edits live),
              // so the highlight has to exclude it explicitly — otherwise the
              // sidebar shows two active rows at once.
              className={`folder-item ${
                f.path === activeFolder && !page ? "active" : ""
              }`}
            >
              <button
                className="folder-item-open"
                onClick={() => openFolder(f.path)}
                title={f.path}
              >
                <span className="folder-name">{folderName(f.path, home)}</span>
                <span className="folder-path">{displayPath(f.path, home)}</span>
              </button>
              <button
                className="folder-remove"
                onClick={() => removeFolderAt(f.path)}
                title="Remove folder from sidebar"
                aria-label={`Remove ${folderName(f.path, home)}`}
              >
                ×
              </button>
            </div>
          ))}
        </section>
      </aside>

      <main className="main">
        {/* Hidden, never unmounted, while the system page is up: xterm
            scrollback, chat scroll position and unsaved editor buffers all
            live in these components. */}
        <div
          className="main-view"
          style={page ? { display: "none" } : undefined}
        >
        {activeFolder === null ? (
          <div className="empty-state">
            Add or select a folder to get started.
          </div>
        ) : (
          <>
            <div className="folder-header">
              <span className="folder-header-path" title={activeFolder}>
                {displayPath(activeFolder, home)}
              </span>
              <div className="header-actions">
                {/* Resume lives in ChatView's `/` slash-command menu as
                    `/resume` (mirrors the CLI), not a header button. */}
                {/* xterm select mode applies to terminal tabs only. */}
                {!activeIsChat && (
                  <button
                    className={`header-icon-button ${selectMode ? "active" : ""}`}
                    onClick={() => setSelectMode((m) => !m)}
                    aria-pressed={selectMode}
                    title="Select text"
                  >
                    <Icon path={SELECT_ICON} />
                  </button>
                )}
                {/* Optional LLM assistant: enabled → accent; enabled but the
                    endpoint is down → red; off → neutral. Chat sessions only. */}
                {activeIsChat && (
                  <button
                    className={`header-icon-button assistant-button ${
                      assistantEnabled
                        ? llmAvailable || !needsLlm
                          ? "active"
                          : "unavailable"
                        : ""
                    }`}
                    onClick={onAssistantButton}
                    aria-pressed={assistantEnabled}
                    title={
                      assistantEnabled
                        ? !needsLlm
                          ? "AI assistant on — needs no LLM"
                          : llmAvailable
                            ? "AI assistant on"
                            : "AI assistant on, but the LLM is unavailable"
                        : "AI assistant"
                    }
                  >
                    <Icon path={ROBOT_ICON} />
                  </button>
                )}
                {!isNarrow ? (
                  // Wide: every option inline as an icon button, no [+] menu.
                  <>
                    {harnesses.filter((h) => h.id !== QUICK_HARNESS_ID).map((h) => (
                      <button
                        key={h.id}
                        className="header-icon-button"
                        onClick={() => client.start(h.id, activeFolder)}
                        title={`New ${h.name} session`}
                        aria-label={`New ${h.name} session`}
                      >
                        <HarnessGlyph id={h.id} name={h.name} />
                      </button>
                    ))}
                    <button
                      className="header-icon-button"
                      onClick={openEditor}
                      title="Files"
                      aria-label="Files"
                    >
                      <Icon path={EDIT_ICON} />
                    </button>
                    {harnesses
                      .filter((h) => h.id === QUICK_HARNESS_ID)
                      .map((h) => (
                        <button
                          key={h.id}
                          className="header-icon-button"
                          onClick={() => client.start(h.id, activeFolder)}
                          title={`New ${h.name} session`}
                          aria-label={`New ${h.name} session`}
                        >
                          <HarnessGlyph id={h.id} name={h.name} />
                        </button>
                      ))}
                  </>
                ) : (
                  // Narrow: [+] holds the coding agents + Files; Terminal is
                  // pulled out as its own direct button (order: [+] then T).
                  <>
                    <div className="add-session" ref={addMenuRef}>
                      <button
                        className="add-session-button"
                        onClick={() => setAddMenuOpen((o) => !o)}
                        title="New session"
                      >
                        +
                      </button>
                      {addMenuOpen && (
                        <div className="add-session-menu">
                          {harnesses.filter((h) => h.id !== QUICK_HARNESS_ID)
                            .length === 0 && (
                            <div className="add-session-empty">
                              No harnesses enabled.
                            </div>
                          )}
                          {harnesses
                            .filter((h) => h.id !== QUICK_HARNESS_ID)
                            .map((h) => (
                              <button
                                key={h.id}
                                className="add-session-option"
                                onClick={() => {
                                  client.start(h.id, activeFolder);
                                  setAddMenuOpen(false);
                                }}
                              >
                                <HarnessGlyph id={h.id} name={h.name} />
                                {h.name}
                              </button>
                            ))}
                          {/* Not a harness: a client-only file-editor tab. */}
                          <button className="add-session-option" onClick={openEditor}>
                            <Icon path={EDIT_ICON} />
                            Files
                          </button>
                        </div>
                      )}
                    </div>
                    {harnesses
                      .filter((h) => h.id === QUICK_HARNESS_ID)
                      .map((h) => (
                        <button
                          key={h.id}
                          className="header-icon-button"
                          onClick={() => client.start(h.id, activeFolder)}
                          title={`New ${h.name} session`}
                          aria-label={`New ${h.name} session`}
                        >
                          <HarnessGlyph id={h.id} name={h.name} />
                        </button>
                      ))}
                  </>
                )}
              </div>
            </div>

            <div className="session-selector">
              <button
                className="session-selector-header"
                onClick={() => setSelectorOpen((o) => !o)}
              >
                <span className="caret">{selectorOpen ? "▾" : "▸"}</span>
                {tabCount} {tabCount === 1 ? "session" : "sessions"}
              </button>
              {selectorOpen && (
                <div className="session-list">
                  {tabCount === 0 && (
                    <p className="muted">No sessions yet. Use + to add one.</p>
                  )}
                  {sessionsInFolder.map((s) => (
                    <button
                      key={s.id}
                      className={`session-item ${s.id === activeSessionId ? "active" : ""}`}
                      onClick={() => {
                        setActiveSession((prev) => ({
                          ...prev,
                          [activeFolder]: s.id,
                        }));
                        setSelectorOpen(false);
                      }}
                    >
                      <span
                        className={`status-dot ${s.status} ${
                          s.currentCommand ? "busy" : ""
                        }`}
                      />
                      <span className="session-name" title={s.harnessName}>
                        <HarnessGlyph id={s.harnessId} name={s.harnessName} />
                      </span>
                      <span
                        className="session-meta"
                        title={s.currentCommand ?? displayPath(s.cwd, home)}
                      >
                        {sessionMeta(s, home)}
                      </span>
                      <span
                        className="session-close"
                        role="button"
                        aria-label="Close session"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          client.remove(s.id);
                        }}
                      >
                        ×
                      </span>
                    </button>
                  ))}
                  {editorsInFolder.map((e) => (
                    <button
                      key={e.id}
                      className={`session-item ${e.id === activeSessionId ? "active" : ""}`}
                      onClick={() => {
                        setActiveSession((prev) => ({
                          ...prev,
                          [activeFolder]: e.id,
                        }));
                        setSelectorOpen(false);
                      }}
                    >
                      <span className="status-dot editor" />
                      <span className="session-name" title="Files">
                        <Icon path={EDIT_ICON} />
                      </span>
                      <span className="session-meta" title={e.file ?? ""}>
                        {e.file ?? "no file"}
                      </span>
                      <span
                        className="session-close"
                        role="button"
                        aria-label="Close file editor"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          closeEditor(e.id);
                        }}
                      >
                        ×
                      </span>
                    </button>
                  ))}
                  {tabCount > 2 && (
                    <div className="session-bulk">
                      <button
                        disabled={!sessionsInFolder.some((s) => s.status === "exited")}
                        onClick={() => {
                          for (const s of sessionsInFolder)
                            if (s.status === "exited") client.remove(s.id);
                        }}
                      >
                        Close finished
                      </button>
                      <button
                        onClick={() => {
                          const live = sessionsInFolder.filter(
                            (s) => s.status !== "exited",
                          ).length;
                          // Kills running agents + drops editor buffers: confirm first.
                          if (
                            (live > 0 || editorsInFolder.length > 0) &&
                            !window.confirm(
                              `Close all ${tabCount} sessions in this folder?` +
                                (live > 0 ? ` ${live} still running.` : ""),
                            )
                          )
                            return;
                          for (const s of sessionsInFolder) client.remove(s.id);
                          for (const e of editorsInFolder) closeEditor(e.id);
                          setSelectorOpen(false);
                        }}
                      >
                        Close all
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="session-content">
              {tabCount === 0 && (
                <div className="empty-state">
                  No sessions in this folder. Use + to start one.
                </div>
              )}
              {/* All sessions stay mounted for scrollback; only the active is shown. */}
              {sessions
                .filter((s) => s.ui !== "chat")
                .map((s) => (
                  <TerminalView
                    key={s.id}
                    client={client}
                    sessionId={s.id}
                    active={s.id === activeSessionId}
                    exited={s.status === "exited"}
                    selectMode={s.id === activeSessionId && selectMode}
                    onEnterSelect={() => setSelectMode(true)}
                    onExitSelect={() => setSelectMode(false)}
                  />
                ))}
              {sessions.some((s) => s.ui === "chat") && (
                <Suspense fallback={<div className="empty-state">Loading chat…</div>}>
                  {sessions
                    .filter((s) => s.ui === "chat")
                    .map((s) => (
                      <ChatView
                        key={s.id}
                        client={client}
                        sessionId={s.id}
                        active={s.id === activeSessionId}
                        exited={s.status === "exited"}
                        canResume={
                          resumable.some((r) => r.harnessId === s.harnessId)
                        }
                        onResume={() => setResumeDialogOpen(true)}
                        keyboardOpen={keyboard.open}
                        knownSessions={sessionIds}
                        heldSessions={heldIds}
                        onOpenSession={openSession}
                      />
                    ))}
                </Suspense>
              )}
              {/* Editor tabs stay mounted so unsaved edits survive tab switches. */}
              {editors.length > 0 && (
                <Suspense fallback={<div className="empty-state">Loading editor…</div>}>
                  {editors.map((e) => (
                    <FileEditor
                      key={e.id}
                      cwd={e.folder}
                      active={e.id === activeSessionId}
                      onOpenFileChange={(name) => setEditorFile(e.id, name)}
                    />
                  ))}
                </Suspense>
              )}
            </div>

            {/* Exited sessions can't take input: swap the key-bar for a close control. */}
            {activeExited && (
              <div className="close-session-bar">
                <button
                  className="close-session-button"
                  onClick={() => client.remove(activeSessionId!)}
                >
                  Close session
                </button>
              </div>
            )}

            {activeSessionId !== null &&
              keyboard.open &&
              !activeExited &&
              !activeIsEditor &&
              !activeIsChat && (
              <div className="key-bar">
                <button
                  className="key-button key-bar-toggle"
                  aria-label={
                    keyGroup === "keys" ? "Show arrow keys" : "Show other keys"
                  }
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() =>
                    setKeyGroup((g) => (g === "keys" ? "arrows" : "keys"))
                  }
                >
                  <Icon path={keyGroup === "keys" ? NAV_ICON : KEYBOARD_ICON} />
                </button>
                <button
                  className="key-button key-bar-toggle"
                  aria-label="Build a command"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setBuilderOpen(true)}
                >
                  ./
                </button>
                <div className="key-group">
                  {(keyGroup === "keys" && agentRunning
                    ? KEY_GROUPS.keys.flatMap((k) =>
                        k.aria === "Tab" ? [k, SHIFT_TAB_KEY] : [k],
                      )
                    : KEY_GROUPS[keyGroup]
                  ).map((k) => (
                    <button
                      key={k.aria}
                      className={`key-button ${
                        k.toggle && ctrlMode !== "off" ? `armed ${ctrlMode}` : ""
                      }`}
                      aria-label={k.aria}
                      aria-pressed={k.toggle ? ctrlMode !== "off" : undefined}
                      // Keep focus on the terminal so the mobile keyboard stays up.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() =>
                        k.toggle
                          ? client.cycleCtrl()
                          : client.input(activeSessionId, k.seq!)
                      }
                    >
                      {k.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {builderOpen && activeSessionId !== null && (
              <CommandBuilder
                client={client}
                sessionId={activeSessionId}
                cwd={activeFolder}
                onClose={() => setBuilderOpen(false)}
              />
            )}

            {resumeDialogOpen && activeFolder !== null && (
              <div
                className="resume-overlay"
                onClick={() => setResumeDialogOpen(false)}
              >
                <div
                  className="resume-dialog"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="resume-dialog-head">
                    <span>Resume session</span>
                    <button
                      className="resume-dialog-close"
                      aria-label="Close"
                      onClick={() => setResumeDialogOpen(false)}
                    >
                      ×
                    </button>
                  </div>
                  <div className="resume-dialog-body">
                    {resumableForActive.length === 0 ? (
                      <div className="resume-empty">
                        No sessions to resume in this folder.
                      </div>
                    ) : (
                      resumableForActive.map((r) => (
                        <div key={r.resumeKey} className="resume-item">
                          <button
                            className="resume-item-open"
                            title={`Resume ${r.harnessName} session`}
                            onClick={() => {
                              client.start(
                                r.harnessId,
                                activeFolder,
                                r.resumeKey,
                                // Server closes it only if still empty.
                                activeSessionId ?? undefined,
                              );
                              setResumeDialogOpen(false);
                            }}
                          >
                            <HarnessGlyph
                              id={r.harnessId}
                              name={r.harnessName}
                            />
                            <span className="resume-item-title">
                              {r.title || r.harnessName}
                            </span>
                            <span className="resume-item-time">
                              {relativeTime(r.updatedAt)}
                            </span>
                          </button>
                          <span
                            className="session-close"
                            role="button"
                            aria-label="Forget session"
                            title="Forget this session"
                            onClick={() => forgetResumable(r.resumeKey)}
                          >
                            ×
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}

            {assistantDialogOpen && activeIsChat && (
              <div className="resume-overlay" onClick={closeAssistantDialog}>
                <div
                  className="resume-dialog assistant-dialog"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="resume-dialog-head">
                    <span>AI assistant</span>
                    <button
                      className="resume-dialog-close"
                      aria-label="Close"
                      onClick={closeAssistantDialog}
                    >
                      ×
                    </button>
                  </div>
                  {/* No Save button — every change applies immediately. */}
                  <div className="resume-dialog-body assistant-dialog-body">
                    {!llmAvailable && assistantNeedsLlm(assistantDraft) && (
                      <div className="assistant-warning">
                        The LLM endpoint is currently unavailable. You can still
                        enable this — it will start acting once the endpoint is
                        reachable.
                      </div>
                    )}
                    {assistantSection(
                      "permissions",
                      "Permissions assistant",
                      assistantInstructions(
                        "permissions",
                        "e.g. only allow bash calls for git tooling",
                        <>
                          {/* Scales the whole grace-window curve; shown as the
                              typical card's wait. Debounced: a drag fires per
                              step. */}
                          <label
                            className="assistant-opt"
                            title="How long a typical auto-accept waits for you to step in — small requests wait less, big ones more. 0s applies at once."
                          >
                            wait
                            <input
                              type="range"
                              className="assistant-range"
                              min={0}
                              max={AUTO_DELAY_TYPICAL_SEC * AUTO_DELAY_MAX_SCALE}
                              step={0.5}
                              value={permissionsTypicalWait}
                              onChange={(e) =>
                                patchSection(
                                  "permissions",
                                  {
                                    delayScale:
                                      Number(e.target.value) /
                                      AUTO_DELAY_TYPICAL_SEC,
                                  },
                                  true,
                                )
                              }
                            />
                            <span className="assistant-range-value">
                              {permissionsTypicalWait}s
                            </span>
                          </label>
                          {/* Shortcut for the blanket-accept instruction; ticking
                              it just writes the phrase, so typing it works too. */}
                          {assistantOption(
                            "allow everything",
                            isAllowEverything(
                              assistantDraft.permissions.instructions,
                            ),
                            (v) =>
                              patchSection("permissions", {
                                instructions: v ? ALLOW_EVERYTHING : "",
                              }),
                            "Accept every permission request without consulting the LLM",
                          )}
                        </>,
                      ),
                    )}
                    {assistantSection(
                      "questions",
                      "Questions assistant",
                      assistantInstructions(
                        "questions",
                        "e.g. always prefer the option that adds tests",
                        assistantOption(
                          "only if sure",
                          assistantDraft.questions.onlyIfSure,
                          (v) => patchSection("questions", { onlyIfSure: v }),
                          "Leave the question for you unless the answer is clear",
                        ),
                      ),
                    )}
                    {assistantSection(
                      "autoPr",
                      "Auto PR",
                      assistantInstructions(
                        "autoPr",
                        "e.g. target the develop branch, prefix the title with the ticket id",
                        assistantOption(
                          "auto merge",
                          assistantDraft.autoPr.autoMerge,
                          (v) => patchSection("autoPr", { autoMerge: v }),
                          "Squash-merge the PR and return to the main branch",
                        ),
                      ),
                      <button
                        className="assistant-run"
                        onClick={() => {
                          if (activeSessionId === null) return;
                          // Flush first: the backend runs against the SAVED
                          // settings, so a just-typed instruction would be lost.
                          flushAssistant();
                          client.chatAction(activeSessionId, {
                            type: "run-auto-pr",
                          });
                          setAssistantDialogOpen(false);
                        }}
                      >
                        Run now
                      </button>,
                    )}
                    {assistantSection(
                      "continuity",
                      "Continuity mode",
                      assistantInstructions(
                        "continuity",
                        "e.g. pick the next task from TODO.md, plan it thoroughly, then implement it",
                        <label className="assistant-opt">
                          new session
                          <span className="assistant-select">
                            <select
                              value={assistantDraft.continuity.newSession}
                              onChange={(e) =>
                                patchSection("continuity", {
                                  newSession: e.target
                                    .value as ContinuityNewSession,
                                })
                              }
                            >
                              <option value="never">never</option>
                              <option value="after-pr">after PR</option>
                              <option value="always">always</option>
                            </select>
                          </span>
                        </label>,
                        "Prompt instructions",
                      ),
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
        </div>
        {systemOpen && (
          <Suspense fallback={<div className="empty-state">Loading…</div>}>
            <SystemState />
          </Suspense>
        )}
        {page === "settings" && (
          <SettingsPage username={username} onLogout={handleLogout} />
        )}
      </main>
      {/* App-level, not inside <main>: adding a folder must work with none open. */}
      {folderPickerOpen && (
        <FolderPicker
          home={home}
          onAdd={submitNewFolder}
          onClose={() => setFolderPickerOpen(false)}
        />
      )}
      {themeEditorOpen && (
        <Suspense fallback={null}>
          <ThemeEditor />
        </Suspense>
      )}
    </div>
  );
}
