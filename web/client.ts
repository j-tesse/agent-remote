import type {
  ChatAction,
  ChatImageRef,
  ChatState,
  ClientMessage,
  FolderInfo,
  ServerMessage,
  SessionInfo,
  ContentPointer,
} from "../shared/protocol";
import { applyChatEvent, emptyChatState } from "../shared/chat";

type SessionsListener = (sessions: SessionInfo[]) => void;
type FoldersListener = (folders: FolderInfo[], home: string) => void;
type ChatListener = (state: ChatState) => void;
type OutputListener = (data: string) => void;
type ResetListener = () => void;
// Ctrl modifier state: off, armed for one keystroke, or locked (caps-lock
// style) until turned off.
export type CtrlMode = "off" | "once" | "lock";
type CtrlListener = (mode: CtrlMode) => void;

// Fold a Ctrl modifier into a key's byte sequence, so a sticky on-screen Ctrl
// can combine with the next keystroke (from the keyboard or an on-screen key).
function applyCtrl(data: string): string {
  // Ctrl+<letter/@[\]^_> -> the corresponding C0 control code (e.g. c -> 0x03).
  if (data.length === 1) {
    const code = data.toUpperCase().charCodeAt(0);
    if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code & 0x1f);
    return data;
  }
  // Ctrl+arrow -> CSI with the Ctrl modifier (1;5A..D).
  const arrow = /^\x1b\[([ABCD])$/.exec(data);
  if (arrow) return `\x1b[1;5${arrow[1]}`;
  return data;
}

interface OutputSubscriber {
  onData: OutputListener;
  onReset: ResetListener;
}

// Single WebSocket multiplexing every session. Output is buffered per session so
// a late-mounting terminal (tab switch / reconnect) replays without losing or
// duplicating bytes.
export class Client {
  private ws?: WebSocket;
  private shouldReconnect = false;
  private sessions: SessionInfo[] = [];
  private folders: FolderInfo[] = [];
  /** Server-side $HOME, for displaying paths as `~/…` (display only). */
  private home = "";
  private buffers = new Map<string, string>();
  private chatStates = new Map<string, ChatState>();
  private sessionsListeners = new Set<SessionsListener>();
  private foldersListeners = new Set<FoldersListener>();
  private outputListeners = new Map<string, Set<OutputSubscriber>>();
  private chatListeners = new Map<string, Set<ChatListener>>();
  private contentListeners = new Map<string, Set<(version: string) => void>>();
  // Sticky Ctrl: armed by the on-screen Ctrl key, applied to subsequent input.
  private ctrlMode: CtrlMode = "off";
  private ctrlListeners = new Set<CtrlListener>();

  connect(): void {
    this.shouldReconnect = true;
    // Idempotent: a second socket (e.g. StrictMode double-invoke) would handle
    // every message twice and duplicate terminal bytes.
    if (this.ws) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onmessage = (e) => this.handle(JSON.parse(e.data) as ServerMessage);
    ws.onclose = () => {
      // Ignore a stale socket's close once a newer one has superseded it.
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (this.shouldReconnect) setTimeout(() => this.connect(), 1000);
    };
  }

  disconnect(): void {
    this.shouldReconnect = false;
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
  }

  private handle(msg: ServerMessage): void {
    switch (msg.type) {
      case "sessions":
        // Fresh connection (incl. reconnect): drop stale buffers and reset
        // terminals before the server replays scrollback, so replay rebuilds
        // rather than duplicates. Chat states are resent as snapshots next.
        this.buffers.clear();
        this.chatStates.clear();
        for (const set of this.outputListeners.values())
          set.forEach((sub) => sub.onReset());
        this.sessions = msg.sessions;
        this.emitSessions();
        break;
      case "started":
        if (!this.sessions.some((s) => s.id === msg.session.id)) {
          const slot = msg.replaces
            ? this.sessions.findIndex((s) => s.id === msg.replaces)
            : -1;
          // In place of the replaced tab; its `removed` follows and cleans up.
          this.sessions =
            slot < 0
              ? [...this.sessions, msg.session]
              : this.sessions.map((s, i) => (i === slot ? msg.session : s));
          this.emitSessions();
        }
        break;
      case "output": {
        const prev = this.buffers.get(msg.sessionId) ?? "";
        this.buffers.set(msg.sessionId, prev + msg.data);
        this.outputListeners
          .get(msg.sessionId)
          ?.forEach((sub) => sub.onData(msg.data));
        break;
      }
      case "exit":
        this.sessions = this.sessions.map((s) =>
          s.id === msg.sessionId
            ? {
                ...s,
                status: "exited" as const,
                exitCode: msg.exitCode,
                stopped: msg.stopped,
              }
            : s,
        );
        this.emitSessions();
        break;
      case "removed":
        this.sessions = this.sessions.filter((s) => s.id !== msg.sessionId);
        this.buffers.delete(msg.sessionId);
        this.chatStates.delete(msg.sessionId);
        this.emitSessions();
        break;
      case "hidden":
        // Chat state kept: the parent's inline view still renders it.
        this.sessions = this.sessions.map((s) =>
          s.id === msg.sessionId ? { ...s, hidden: true } : s,
        );
        this.emitSessions();
        break;
      case "chatState":
        this.chatStates.set(msg.sessionId, msg.state);
        this.emitChat(msg.sessionId, msg.state);
        break;
      case "chatEvent": {
        const prev = this.chatStates.get(msg.sessionId) ?? emptyChatState();
        const next = applyChatEvent(prev, msg.event);
        this.chatStates.set(msg.sessionId, next);
        this.emitChat(msg.sessionId, next);
        break;
      }
      case "sessionEvent": {
        // Keep the session's live state in sync: cwd + running command.
        const ev = msg.event;
        const patch: Partial<SessionInfo> | null =
          ev.type === "cwd"
            ? { cwd: ev.cwd }
            : ev.type === "command-start"
              ? { currentCommand: ev.command.trim() || null }
              : ev.type === "command-end"
                ? { currentCommand: null }
                : null;
        if (patch) {
          this.sessions = this.sessions.map((s) =>
            s.id === msg.sessionId ? { ...s, ...patch } : s,
          );
          this.emitSessions();
        }
        break;
      }
      case "folders":
        this.folders = msg.folders;
        this.home = msg.home;
        this.emitFolders();
        break;
      case "content":
        for (const cb of this.contentListeners.get(msg.sessionId) ?? []) cb(msg.version);
        break;
      case "error":
        console.error("agent-remote backend error:", msg.message);
        break;
    }
  }

  // --- outgoing ------------------------------------------------------------

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  start(
    harnessId: string,
    cwd?: string,
    opts: { resume?: string; replaces?: string; content?: ContentPointer } = {},
  ): void {
    this.send({ type: "start", harnessId, cwd, ...opts });
  }
  input(sessionId: string, data: string): void {
    if (this.ctrlMode !== "off") {
      data = applyCtrl(data);
      // One-shot consumes itself; lock stays armed for the next key.
      if (this.ctrlMode === "once") this.setCtrl("off");
    }
    this.send({ type: "input", sessionId, data });
  }
  // Cycle the Ctrl modifier: off -> one-shot -> locked -> off.
  cycleCtrl(): void {
    this.setCtrl(
      this.ctrlMode === "off" ? "once" : this.ctrlMode === "once" ? "lock" : "off",
    );
  }
  private setCtrl(mode: CtrlMode): void {
    if (this.ctrlMode === mode) return;
    this.ctrlMode = mode;
    for (const cb of this.ctrlListeners) cb(mode);
  }
  resize(sessionId: string, cols: number, rows: number): void {
    this.send({ type: "resize", sessionId, cols, rows });
  }
  stop(sessionId: string): void {
    this.send({ type: "stop", sessionId });
  }
  chatAction(sessionId: string, action: ChatAction): void {
    this.send({ type: "chatAction", sessionId, action });
  }
  /** Upload an image over REST (cookie-authed). Returns the reference to attach
   * to a prompt; the raw bytes stay server-side and are streamed to the agent
   * at send time. */
  async uploadImage(file: File): Promise<ChatImageRef> {
    const qs = file.name ? `?name=${encodeURIComponent(file.name)}` : "";
    const res = await fetch(`/api/upload${qs}`, {
      method: "POST",
      headers: { "content-type": file.type },
      body: file,
      credentials: "same-origin",
    });
    if (!res.ok) {
      const msg = await res
        .json()
        .then((b) => (b as { message?: string }).message)
        .catch(() => undefined);
      throw new Error(msg ?? `Upload failed (${res.status})`);
    }
    return (await res.json()) as ChatImageRef;
  }
  remove(sessionId: string): void {
    this.send({ type: "remove", sessionId });
  }
  addFolder(path: string): void {
    this.send({ type: "addFolder", path });
  }
  removeFolder(path: string): void {
    this.send({ type: "removeFolder", path });
  }

  // --- subscriptions -------------------------------------------------------

  onSessions(cb: SessionsListener): () => void {
    this.sessionsListeners.add(cb);
    cb(this.sessions);
    return () => this.sessionsListeners.delete(cb);
  }

  onFolders(cb: FoldersListener): () => void {
    this.foldersListeners.add(cb);
    cb(this.folders, this.home);
    return () => this.foldersListeners.delete(cb);
  }

  /** A co-create session's content changed on disk (refetch it). */
  onContent(sessionId: string, cb: (version: string) => void): () => void {
    let set = this.contentListeners.get(sessionId);
    if (!set) this.contentListeners.set(sessionId, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  }

  onCtrl(cb: CtrlListener): () => void {
    this.ctrlListeners.add(cb);
    cb(this.ctrlMode);
    return () => this.ctrlListeners.delete(cb);
  }

  /**
   * Subscribe to a session's output. Returns buffered scrollback + unsubscribe;
   * read + register happen synchronously so no bytes drop or double. `onReset`
   * fires before a reconnect replay so the terminal can clear itself first.
   */
  subscribeOutput(
    sessionId: string,
    onData: OutputListener,
    onReset: ResetListener,
  ): { initial: string; unsubscribe: () => void } {
    const initial = this.buffers.get(sessionId) ?? "";
    let set = this.outputListeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.outputListeners.set(sessionId, set);
    }
    const sub: OutputSubscriber = { onData, onReset };
    set.add(sub);
    return {
      initial,
      unsubscribe: () => set!.delete(sub),
    };
  }

  /**
   * Subscribe to a chat session's state. Same synchronous contract as
   * `subscribeOutput`. Snapshots and live events both arrive as full states.
   */
  subscribeChat(
    sessionId: string,
    cb: ChatListener,
  ): { initial: ChatState; unsubscribe: () => void } {
    const initial = this.chatStates.get(sessionId) ?? emptyChatState();
    let set = this.chatListeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.chatListeners.set(sessionId, set);
    }
    set.add(cb);
    return {
      initial,
      unsubscribe: () => set!.delete(cb),
    };
  }

  private emitChat(sessionId: string, state: ChatState): void {
    this.chatListeners.get(sessionId)?.forEach((cb) => cb(state));
  }

  private emitSessions(): void {
    for (const cb of this.sessionsListeners) cb(this.sessions);
  }

  private emitFolders(): void {
    for (const cb of this.foldersListeners) cb(this.folders, this.home);
  }
}
