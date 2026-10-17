import { randomUUID } from "node:crypto";
import {
  spawn as spawnPiped,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { spawn, type IPty } from "node-pty";
import type {
  ChatSession,
  ChatTranslator,
  HarnessAdapter,
  HostToolSet,
  SessionEventParser,
  SessionOptions,
} from "../adapters/types.js";
import type {
  AssistantDecision,
  AssistantTrace,
  AutoPrompt,
  ChatAction,
  ChatEvent,
  ChatState,
  SessionEvent,
  SessionInfo,
  SessionUi,
} from "../../shared/protocol.js";
import {
  applyChatEvent,
  deriveAssistantEnabled,
  emptyChatState,
  isEmptyChat,
} from "../../shared/chat.js";
import { normalizeFolder } from "../paths.js";

/** `start()` options: the adapter's own, plus manager-level flags adapters never see a use for. */
export interface StartOptions extends SessionOptions {
  /** Owning session id for a nested session (auto-PR); → `SessionInfo.parentId`. */
  parent?: string;
  /** Session this one supersedes (resume from a tab): closed iff it's an empty chat. */
  replaces?: string;
  /** Session whose agent started this one (host tool); → `SessionInfo.spawnedBy`. */
  spawnedBy?: string;
}

/** Builds the host tools for a new session (server/sessionTools.ts). */
export type HostToolFactory = (sessionId: string) => HostToolSet | undefined;

// Per-session scrollback retained for replay on (re)connect; bounded for memory.
const MAX_BUFFER = 200_000;

// Tail of a chat child's stderr, surfaced as an error notice if it dies.
const MAX_STDERR_TAIL = 2_000;

interface Session {
  info: SessionInfo;
  // --- terminal flavor (ui: "terminal") ---
  pty?: IPty;
  buffer: string;
  /** Present only for harnesses with shell integration; extracts events and
   * strips the integration markers from the output stream. */
  parser?: SessionEventParser;
  // --- chat flavor (ui: "chat") ---
  /** Translator-based chat (manager owns the piped child), e.g. pi. */
  child?: ChildProcessWithoutNullStreams;
  translator?: ChatTranslator;
  /** Session-based chat (adapter owns the process/SDK), e.g. claude. */
  chatSession?: ChatSession;
  chat?: ChatState;
  stderrTail?: string;
  /** Opaque harness-native handle for resuming this conversation later, once the
   * adapter has reported it (chat harnesses that support resume only). */
  resumeKey?: string;
}

/** Notified of session lifecycle and output. One listener per WS connection,
 * plus server-global listeners (e.g. the command recorder). */
export interface SessionListener {
  /** `replaced`: the session this one took the slot of; its onRemoved follows. */
  onStarted(info: SessionInfo, replaced?: string): void;
  onOutput(sessionId: string, data: string): void;
  onExit(sessionId: string, exitCode: number | null): void;
  /** A session was removed from the manager entirely (e.g. user closed an
   * exited session); it should be dropped from the UI. */
  onRemoved?(sessionId: string): void;
  /** A nested session was soft-removed (see `remove`): gone from the list, still held. */
  onHidden?(sessionId: string): void;
  /** A structured event observed inside the session (shell integration only). */
  onEvent?(sessionId: string, event: SessionEvent): void;
  /** A normalized chat event from a chat session (ui: "chat" only). */
  onChatEvent?(sessionId: string, event: ChatEvent): void;
  /** A chat action was performed (from a client OR the backend). For
   * harness-agnostic capabilities a client *asks* for rather than a state change
   * to fold — an inert ChatEvent would smuggle an RPC onto the state-sync bus. */
  onChatAction?(sessionId: string, action: ChatAction): void;
  /** The session reported its resume key (persist it so it can be resumed). */
  onResumable?(sessionId: string, key: string): void;
}

// Owns agent-subprocess lifecycle, harness-agnostically: asks an adapter only
// for the command line, then handles PTY, output fan-out, and teardown itself.
export class SessionManager {
  private sessions = new Map<string, Session>();
  private listeners = new Set<SessionListener>();

  private hostTools?: HostToolFactory;

  constructor(private adapters: Map<string, HarnessAdapter>) {}

  /** Install the host-tool factory; applies to sessions started afterwards. */
  setHostTools(factory: HostToolFactory): void {
    this.hostTools = factory;
  }

  /** Chat harnesses (id + name), e.g. for a spawn tool's harness enum. */
  chatHarnesses(): { id: string; name: string }[] {
    return [...this.adapters.values()]
      .filter((a) => a.createChatSession || a.createChatTranslator)
      .map((a) => ({ id: a.id, name: a.name }));
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info);
  }

  /** Retained scrollback for a session, for replay on connect. */
  buffer(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.buffer;
  }

  /** The session's current working directory (kept live by shell integration),
   * for consumers that record what ran where. */
  sessionCwd(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.info.cwd;
  }

  /** The folder the session was launched in (fixed for the session's life),
   * for ordering folders by which one most recently received input. */
  sessionFolder(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.info.folder;
  }

  /** How the session renders in the browser ("terminal" or "chat"). */
  sessionUi(sessionId: string): SessionUi | undefined {
    return this.sessions.get(sessionId)?.info.ui;
  }

  /** Full info for a session, for consumers that persist harness metadata. */
  sessionInfo(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId)?.info;
  }

  /** The session's resume key, once the adapter has reported one. */
  resumeKey(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.resumeKey;
  }

  /** Resume keys of currently-running sessions — so the resume list can hide
   * conversations that are already open. */
  liveResumeKeys(): Set<string> {
    const keys = new Set<string>();
    for (const s of this.sessions.values())
      if (s.resumeKey && s.info.status === "running") keys.add(s.resumeKey);
    return keys;
  }

  /** Current chat state of a chat session, for replay on connect. */
  chatState(sessionId: string): ChatState | undefined {
    return this.sessions.get(sessionId)?.chat;
  }

  start(harnessId: string, opts: StartOptions): SessionInfo {
    const adapter = this.adapters.get(harnessId);
    if (!adapter) throw new Error(`Unknown harness: ${harnessId}`);

    const isChat = !!(adapter.createChatSession || adapter.createChatTranslator);
    const info: SessionInfo = {
      id: randomUUID(),
      harnessId: adapter.id,
      harnessName: adapter.name,
      folder: opts.cwd,
      cwd: opts.cwd,
      ui: isChat ? "chat" : "terminal",
      status: "running",
      exitCode: null,
      createdAt: Date.now(),
      currentCommand: null,
      ...(opts.parent ? { parentId: opts.parent } : {}),
      ...(opts.spawnedBy ? { spawnedBy: opts.spawnedBy } : {}),
    };
    // Bound by id, resolved lazily at call time — the session isn't registered yet.
    const hostTools = isChat ? this.hostTools?.(info.id) : undefined;
    if (hostTools) opts = { ...opts, hostTools };

    const session = adapter.createChatSession
      ? this.startChatSession(adapter, opts, info)
      : adapter.createChatTranslator
        ? this.startChat(adapter, opts, info)
        : this.startTerminal(adapter, opts, info);

    // Only an empty chat is replaced — a live conversation is never torn down as a
    // side effect of opening another one.
    const old = opts.replaces ? this.sessions.get(opts.replaces) : undefined;
    const replaced =
      old?.chat &&
      isEmptyChat(old.chat) &&
      old.info.folder === info.folder &&
      !old.info.parentId
        ? old.info.id
        : undefined;
    if (replaced) {
      // Take the old slot, so a reconnect snapshot keeps the tab order too.
      const next = new Map<string, Session>();
      for (const [id, s] of this.sessions) {
        if (id === replaced) next.set(info.id, session);
        next.set(id, s);
      }
      this.sessions = next;
    } else this.sessions.set(info.id, session);

    for (const l of this.listeners) l.onStarted(info, replaced);
    if (replaced) this.remove(replaced);
    // Fan out a synchronously-minted resume key (translator chat harnesses, e.g.
    // pi) only now that the session is registered — listeners (e.g. the DB
    // persister) resolve session info/folder by id. Session-based chat harnesses
    // (claude) report their key later, asynchronously, from their own handler.
    if (session.resumeKey)
      for (const l of this.listeners) l.onResumable?.(info.id, session.resumeKey);
    return info;
  }

  /** Session-based chat: the adapter owns the process/SDK and we drive it via
   * the ChatSession interface, folding its events into ChatState like any other
   * chat flavor. */
  private startChatSession(
    adapter: HarnessAdapter,
    opts: SessionOptions,
    info: SessionInfo,
  ): Session {
    const chatSession = adapter.createChatSession!(opts);
    const session: Session = {
      info,
      buffer: "",
      chatSession,
      chat: emptyChatState(),
    };
    chatSession.start({
      onEvent: (event) => this.applyChat(session, event),
      onResumable: (key) => {
        session.resumeKey = key;
        for (const l of this.listeners) l.onResumable?.(info.id, key);
      },
      onExit: (exitCode) => {
        if (info.status === "exited") return;
        info.status = "exited";
        info.exitCode = exitCode;
        info.currentCommand = null;
        for (const l of this.listeners) l.onExit(info.id, exitCode);
      },
    });
    return session;
  }

  private startTerminal(
    adapter: HarnessAdapter,
    opts: SessionOptions,
    info: SessionInfo,
  ): Session {
    const invocation = adapter.invocation(opts);
    const child = spawn(invocation.command, invocation.args, {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd: opts.cwd,
      env: { ...process.env, ...invocation.env } as Record<string, string>,
    });

    const session: Session = {
      info,
      pty: child,
      buffer: "",
      parser: adapter.createEventParser?.(),
    };

    child.onData((data) => {
      // The parser strips integration markers and yields events; without one,
      // data passes through unchanged.
      const { output, events } = session.parser
        ? session.parser.push(data)
        : { output: data, events: [] };
      if (output) {
        session.buffer = (session.buffer + output).slice(-MAX_BUFFER);
        for (const l of this.listeners) l.onOutput(info.id, output);
      }
      for (const event of events) {
        // Reflect live state: cwd + the running command (set on exec, cleared at prompt).
        // `cwd` drifts with `cd` and never re-parents the session (that's
        // `info.folder`); normalized so it compares against folder keys, which
        // carry a trailing slash where a shell reports `/x/y`.
        if (event.type === "cwd") info.cwd = normalizeFolder(event.cwd);
        else if (event.type === "command-start")
          info.currentCommand = event.command.trim() || null;
        else if (event.type === "command-end") info.currentCommand = null;
        for (const l of this.listeners) l.onEvent?.(info.id, event);
      }
    });
    child.onExit(({ exitCode }) => {
      info.status = "exited";
      info.exitCode = exitCode;
      for (const l of this.listeners) l.onExit(info.id, exitCode);
    });

    return session;
  }

  private startChat(
    adapter: HarnessAdapter,
    opts: SessionOptions,
    info: SessionInfo,
  ): Session {
    // Resumable translator harnesses (e.g. pi) use one opaque id as both the
    // on-disk session handle (passed to the CLI) and the resume key we persist:
    // reuse it when resuming, mint a fresh one otherwise. The adapter's
    // invocation() turns it into its own CLI flag.
    const resumeKey = adapter.resumable ? (opts.resume ?? randomUUID()) : undefined;
    const effectiveOpts = resumeKey ? { ...opts, resume: resumeKey } : opts;
    const invocation = adapter.invocation(effectiveOpts);
    const child = spawnPiped(invocation.command, invocation.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...invocation.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const translator = adapter.createChatTranslator!(effectiveOpts);
    const session: Session = {
      info,
      buffer: "",
      child,
      translator,
      chat: emptyChatState(),
      resumeKey,
    };
    // The onResumable fan-out happens in start(), AFTER the session is registered
    // (listeners look the session up by id) — see the note there.

    // setEncoding decodes utf8 across chunk boundaries so the translator only
    // sees whole characters.
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      for (const event of session.translator!.push(chunk))
        this.applyChat(session, event);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      session.stderrTail = ((session.stderrTail ?? "") + chunk).slice(
        -MAX_STDERR_TAIL,
      );
    });

    const finish = (exitCode: number | null) => {
      if (info.status === "exited") return;
      // SIGTERM yields a non-zero code; the tail is then whatever the harness
      // happened to warn about at startup, not a cause of death.
      if (!info.stopped && exitCode !== 0 && session.stderrTail?.trim()) {
        this.applyChat(session, {
          type: "notice",
          level: "error",
          text: session.stderrTail.trim(),
        });
      }
      info.status = "exited";
      info.exitCode = exitCode;
      info.currentCommand = null;
      for (const l of this.listeners) l.onExit(info.id, exitCode);
    };
    child.on("exit", (code) => finish(code));
    // Spawn failure (e.g. binary missing): no "exit" will follow.
    child.on("error", (err) => {
      session.stderrTail = err.message;
      finish(-1);
    });

    // Optional RPC handshake / capability query the translator wants sent first.
    const initData = translator.init?.();
    if (initData) child.stdin.write(initData);

    // On resume, the wire stream doesn't replay prior turns — rebuild the
    // visible transcript from the harness's on-disk session store (best-effort;
    // the model's context is restored regardless).
    if (opts.resume && translator.replayHistory) {
      void translator
        .replayHistory(effectiveOpts)
        .then((events) => {
          if (session.info.status === "exited") return;
          for (const event of events) this.applyChat(session, event);
        })
        .catch(() => {});
    }

    return session;
  }

  /** Fold a chat event into state and fan it out. Also mirrors busy/idle into
   * `currentCommand` so the session-list UI (dot + subtitle) works unchanged. */
  private applyChat(session: Session, event: ChatEvent): void {
    session.chat = applyChatEvent(session.chat ?? emptyChatState(), event);
    const info = session.info;
    if (event.type === "busy") {
      const command = event.busy ? lastPromptLine(session.chat) : null;
      info.currentCommand = command;
      const mirrored: SessionEvent = command
        ? { type: "command-start", command, at: Date.now() }
        : { type: "command-end", exitCode: 0, at: Date.now() };
      for (const l of this.listeners) l.onEvent?.(info.id, mirrored);
    }
    for (const l of this.listeners) l.onChatEvent?.(info.id, event);
  }

  /** Perform a chat action. Session-based: the adapter's ChatSession handles it.
   * Translator-based: encode to stdin and apply synthetic events ourselves. */
  chatAction(sessionId: string, action: ChatAction): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.info.status !== "running") return;
    for (const l of this.listeners) l.onChatAction?.(sessionId, action);
    // Carries no state and no harness meaning — the listeners above are the
    // whole handler (server/autopr.ts).
    if (action.type === "run-auto-pr") return;
    // AI-assistant mode is backend-owned and harness-agnostic — handle its
    // actions here (fold into ChatState + fan out), never in the adapter. The
    // decision-cleared event also reaches the assistant decider (a listener),
    // which cancels its pending auto-response for this request.
    if (action.type === "set-assistant") {
      this.applyChat(session, {
        type: "assistant-config",
        // Master switch is derived, never trusted from a client.
        settings: {
          ...action.settings,
          enabled: deriveAssistantEnabled(action.settings),
        },
      });
      return;
    }
    if (action.type === "cancel-assistant") {
      this.applyChat(session, {
        type: "assistant-decision-cleared",
        requestId: action.requestId,
      });
      return;
    }
    // The unsent composer text is ours too (harness-agnostic).
    if (action.type === "set-draft") {
      this.applyChat(session, { type: "draft", text: action.text });
      return;
    }
    // Withdrawing a Continuity Mode prompt; server/continuity.ts observes the
    // resulting event and cancels its send timer.
    if (action.type === "cancel-auto-prompt") {
      this.applyChat(session, { type: "auto-prompt-cleared", id: action.id });
      return;
    }
    if (action.type === "prompt") {
      // Sending consumes the draft, whatever it holds. (Guarded only to skip a
      // no-op broadcast: the sender usually cleared it already.)
      if (session.chat?.draft) this.applyChat(session, { type: "draft", text: "" });
    }
    if (session.chatSession) {
      session.chatSession.action(action);
      return;
    }
    if (!session.translator || !session.child) return;
    const { data, events } = session.translator.encode(action);
    if (data) session.child.stdin.write(data);
    for (const event of events) this.applyChat(session, event);
  }

  /** Broadcast an AI-assistant verdict for a pending card (drives the countdown
   * ring in every client). Used by the backend decider; no-op for non-chat/
   * absent sessions. */
  postAssistantDecision(sessionId: string, decision: AssistantDecision): void {
    const session = this.sessions.get(sessionId);
    if (session?.chat)
      this.applyChat(session, { type: "assistant-decision", decision });
  }

  /** Surface predicted next-prompt suggestions (composer chips) for a chat
   * session. Used by the harness-agnostic suggestion generator for harnesses
   * without native suggestions; no-op for non-chat/absent sessions. */
  postPromptSuggestions(sessionId: string, suggestions: string[]): void {
    const session = this.sessions.get(sessionId);
    if (session?.chat)
      this.applyChat(session, { type: "prompt-suggestion", suggestions });
  }

  /** Fold LLM-generated model display names (server/modelNames.ts). */
  postModelNames(sessionId: string, names: Record<string, string>): void {
    const session = this.sessions.get(sessionId);
    if (session?.chat) this.applyChat(session, { type: "model-names", names });
  }

  /** Arm Continuity Mode's composed prompt on a chat session — the composer's
   * countdown ring. The backend does the actual sending; no-op for non-chat/
   * absent sessions. */
  postAutoPrompt(sessionId: string, prompt: AutoPrompt): void {
    const session = this.sessions.get(sessionId);
    if (session?.chat) this.applyChat(session, { type: "auto-prompt", prompt });
  }

  /** Withdraw an armed auto-prompt (it fired, or continuity gave up on it). */
  clearAutoPrompt(sessionId: string, id: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.chat)
      this.applyChat(session, { type: "auto-prompt-cleared", id });
  }

  /** Record an AI-assistant deliberation (prompt/thoughts/response) for a card,
   * surfaced in the transcript as a collapsible AI-mode bubble. Used by the
   * backend decider whenever the LLM was queried; no-op for non-chat sessions. */
  postAssistantTrace(sessionId: string, trace: AssistantTrace): void {
    const session = this.sessions.get(sessionId);
    if (session?.chat)
      this.applyChat(session, { type: "assistant-trace", trace });
  }

  input(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.pty?.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (!session?.pty) return;
    try {
      session.pty.resize(cols, rows);
    } catch {
      // PTY may have exited between resize events; ignore.
    }
  }

  stop(sessionId: string): void {
    this.kill(this.sessions.get(sessionId));
  }

  /** Drop a session (killing it first if still running); releases its scrollback.
   * A nested session whose parent is still around is only HIDDEN — left running,
   * state kept — since the parent's inline view still shows it. Removing a parent
   * hard-removes its nested sessions with it. */
  remove(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const parent = session.info.parentId;
    if (parent && this.sessions.has(parent)) {
      if (session.info.hidden) return;
      session.info.hidden = true;
      for (const l of this.listeners) l.onHidden?.(sessionId);
      return;
    }
    if (session.info.status !== "exited") this.kill(session);
    this.sessions.delete(sessionId);
    for (const l of this.listeners) l.onRemoved?.(sessionId);
    // Parent is gone now, so each child takes the hard path above.
    for (const s of [...this.sessions.values()])
      if (s.info.parentId === sessionId) this.remove(s.info.id);
  }

  /** Terminate a session's process. Flags it as OUR doing first: the exit that
   * follows carries SIGTERM's non-zero code, which is expected — so no failure
   * notice, and the UI says "closed" rather than reporting an exit code. */
  private kill(session: Session | undefined): void {
    if (!session) return;
    session.info.stopped = true;
    if (session.pty) session.pty.kill();
    else if (session.chatSession) session.chatSession.close();
    else session.child?.kill("SIGTERM");
  }
}

/** First line of the most recent user prompt, truncated for the session list. */
function lastPromptLine(chat: ChatState): string {
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const msg = chat.messages[i];
    if (msg.role !== "user") continue;
    const text = msg.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("")
      .trim()
      .split("\n", 1)[0];
    if (text) return text.length > 60 ? `${text.slice(0, 60)}…` : text;
    // An image-only prompt (no text) still deserves a legible subtitle.
    if (msg.parts.some((p) => p.type === "image")) return "🖼 image";
  }
  return "working";
}
