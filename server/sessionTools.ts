// Host tools that let an agent start and drive OTHER chat sessions — top-level
// tabs, indistinguishable from ones a human opened. Harness-agnostic: speaks only
// ChatAction/ChatState through the manager; each adapter exposes the HostToolSet
// natively (claude: in-process MCP server). Spawns are rate-limited globally.
import type { SessionManager } from "./sessions/manager.js";
import type { HostTool, HostToolSet } from "./adapters/types.js";
import type { ChatState, SessionInfo } from "../shared/protocol.js";
import { normalizeFolder } from "./paths.js";
import { messageText } from "./suggestions.js";

export const SPAWN_LIMIT = 5;
export const SPAWN_WINDOW_MS = 10 * 60_000;
const WAIT_DEFAULT_SEC = 120;
const WAIT_MIN_SEC = 5;
const WAIT_MAX_SEC = 600;
/** Tail of a reply returned to the caller — a verdict lives in the closing lines. */
const REPLY_MAX_CHARS = 8_000;

/** Sliding-window spawn budget, shared by every session (runaway guard). */
export class SpawnLimiter {
  private stamps: number[] = [];
  constructor(
    private limit = SPAWN_LIMIT,
    private windowMs = SPAWN_WINDOW_MS,
  ) {}
  /** Takes a slot, or returns ms until one frees up. */
  take(now = Date.now()): { ok: true } | { ok: false; retryMs: number } {
    this.stamps = this.stamps.filter((t) => now - t < this.windowMs);
    if (this.stamps.length < this.limit) {
      this.stamps.push(now);
      return { ok: true };
    }
    return { ok: false, retryMs: this.stamps[0] + this.windowMs - now };
  }
}

export type ChildStatus = "running" | "idle" | "waiting-for-input" | "exited";

/** Where a child stands. `sent` = prompts we've sent it: until all are echoed
 * as user turns, a not-yet-busy session is still starting, not idle. */
export function childStatus(
  state: ChatState | undefined,
  info: Pick<SessionInfo, "status"> | undefined,
  sent: number,
): ChildStatus {
  if (!info || info.status === "exited" || !state) return "exited";
  if (state.pendingRequests.length) return "waiting-for-input";
  if (state.busy || state.streaming || state.queued.length || state.autoPrompt)
    return "running";
  const prompts = state.messages.filter((m) => m.role === "user").length;
  if (prompts < sent) return "running";
  return state.messages.at(-1)?.role === "assistant" ? "idle" : "running";
}

/** The child's answer to its latest prompt: every assistant turn after it. */
export function lastReply(state: ChatState | undefined): string {
  if (!state) return "";
  const out: string[] = [];
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (m.role === "user") break;
    if (m.role === "assistant") {
      const text = messageText(m);
      if (text) out.unshift(text);
    }
  }
  const text = out.join("\n\n");
  return text.length > REPLY_MAX_CHARS
    ? `…${text.slice(-REPLY_MAX_CHARS)}`
    : text;
}

export function clampWaitSec(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : WAIT_DEFAULT_SEC;
  return Math.min(WAIT_MAX_SEC, Math.max(WAIT_MIN_SEC, n));
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Install the tools on `manager`. `knownFolders` = the folder allowlist. */
export function attachSessionTools(
  manager: SessionManager,
  knownFolders: () => string[],
  limiter = new SpawnLimiter(),
): void {
  /** child id → spawning session id + prompts sent. */
  const children = new Map<string, { owner: string; sent: number }>();
  const harnesses = manager.chatHarnesses();

  const report = (id: string) => {
    const child = children.get(id);
    const info = manager.sessionInfo(id);
    const state = manager.chatState(id);
    const status = childStatus(state, info, child?.sent ?? 0);
    return {
      sessionId: id,
      harness: info?.harnessId,
      status,
      ...(status === "idle" || status === "exited"
        ? { reply: lastReply(state) }
        : {}),
      ...(status === "waiting-for-input"
        ? { pending: state?.pendingRequests.map((r) => r.title) }
        : {}),
    };
  };

  /** A session the caller spawned, or throws. */
  const own = (caller: string, id: string) => {
    const child = children.get(id);
    if (!child || child.owner !== caller)
      throw new Error(`No session ${id} spawned by this session`);
    return child;
  };

  /** Resolve when the child stops running, or after `sec` regardless. */
  const settle = (id: string, sec: number) =>
    new Promise<void>((resolve) => {
      const sent = () => children.get(id)?.sent ?? 0;
      const check = () =>
        childStatus(manager.chatState(id), manager.sessionInfo(id), sent()) !==
        "running";
      if (check()) return resolve();
      const done = () => {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      };
      const timer = setTimeout(done, sec * 1000);
      const unsubscribe = manager.subscribe({
        onStarted() {},
        onOutput() {},
        onExit: (sid) => sid === id && done(),
        onRemoved: (sid) => sid === id && done(),
        onChatEvent: (sid) => sid === id && check() && done(),
      });
    });

  const send = (id: string, text: string) => {
    const child = children.get(id)!;
    child.sent++;
    manager.chatAction(id, { type: "prompt", text });
  };

  const toolsFor = (caller: string): HostTool[] => [
    {
      name: "spawn_session",
      description:
        "Start a new, independent agent chat session that the user sees as an ordinary tab, and send it a first prompt. Returns immediately with its sessionId; use wait_session to get its reply. The new session has no memory of this conversation, so the prompt must be self-contained. Limited to " +
        `${SPAWN_LIMIT} spawns per ${SPAWN_WINDOW_MS / 60_000} minutes across all sessions.`,
      params: {
        harness: {
          type: "string",
          description: `Agent to run: ${harnesses.map((h) => `${h.id} (${h.name})`).join(", ")}.`,
          enum: harnesses.map((h) => h.id),
        },
        prompt: { type: "string", description: "First message to the new session." },
        folder: {
          type: "string",
          optional: true,
          description:
            "Absolute folder to run in; must be one already open in the UI. Defaults to this session's folder.",
        },
      },
      async run(args) {
        const harness = str(args.harness);
        const prompt = str(args.prompt);
        if (!harnesses.some((h) => h.id === harness))
          throw new Error(`Unknown harness: ${harness}`);
        if (!prompt) throw new Error("prompt is required");
        const home = manager.sessionFolder(caller);
        const folder = str(args.folder) ? normalizeFolder(str(args.folder)) : home;
        if (!folder) throw new Error("Calling session is gone");
        if (folder !== home && !knownFolders().map(normalizeFolder).includes(folder))
          throw new Error(`Folder is not open in the UI: ${folder}`);
        const slot = limiter.take();
        if (!slot.ok)
          throw new Error(
            `Spawn limit reached (${SPAWN_LIMIT} per ${SPAWN_WINDOW_MS / 60_000} min); next slot in ${Math.ceil(slot.retryMs / 1000)}s`,
          );
        const info = manager.start(harness, { cwd: folder, spawnedBy: caller });
        children.set(info.id, { owner: caller, sent: 0 });
        // Inherit the caller's AI-assistant checklist, before the first prompt
        // so its very first card is already covered.
        const assistant = manager.chatState(caller)?.assistant;
        if (assistant)
          manager.chatAction(info.id, { type: "set-assistant", settings: assistant });
        send(info.id, prompt);
        // `spawnedSession` is what the UI keys its inline panel off (render.ts).
        return JSON.stringify({ spawnedSession: info.id, harness, folder, status: "running" });
      },
    },
    {
      name: "wait_session",
      description:
        "Wait (bounded) for a session you spawned to finish its turn. Returns status running (timed out — call again), idle (with its reply), waiting-for-input (a permission/question card awaits the user), or exited.",
      readOnly: true,
      params: {
        sessionId: { type: "string", description: "Id from spawn_session." },
        timeoutSec: {
          type: "number",
          optional: true,
          description: `Max seconds to wait (${WAIT_MIN_SEC}–${WAIT_MAX_SEC}, default ${WAIT_DEFAULT_SEC}).`,
        },
      },
      async run(args) {
        const id = str(args.sessionId);
        own(caller, id);
        await settle(id, clampWaitSec(args.timeoutSec));
        return JSON.stringify(report(id));
      },
    },
    {
      name: "send_to_session",
      description:
        "Send a follow-up prompt to an idle session you spawned. Then use wait_session for the reply.",
      params: {
        sessionId: { type: "string", description: "Id from spawn_session." },
        prompt: { type: "string", description: "Message to send." },
      },
      async run(args) {
        const id = str(args.sessionId);
        const prompt = str(args.prompt);
        const child = own(caller, id);
        if (!prompt) throw new Error("prompt is required");
        const status = childStatus(manager.chatState(id), manager.sessionInfo(id), child.sent);
        if (status !== "idle")
          throw new Error(`Session is ${status}; only an idle session takes a prompt`);
        send(id, prompt);
        return JSON.stringify({ sessionId: id, status: "running" });
      },
    },
    {
      name: "list_sessions",
      description: "List the sessions you spawned and their status.",
      readOnly: true,
      params: {},
      async run() {
        const mine = [...children]
          .filter(([, c]) => c.owner === caller)
          .map(([id]) => {
            const { reply: _reply, ...rest } = report(id);
            return rest;
          });
        return JSON.stringify(mine);
      },
    },
    {
      name: "stop_session",
      description: "Stop a session you spawned (its tab stays, marked closed).",
      params: { sessionId: { type: "string", description: "Id from spawn_session." } },
      async run(args) {
        const id = str(args.sessionId);
        own(caller, id);
        manager.stop(id);
        return JSON.stringify({ sessionId: id, status: "exited" });
      },
    },
  ];

  manager.setHostTools(
    (caller): HostToolSet => ({
      name: "agent-remote",
      instructions:
        "Tools to delegate work to other agent sessions (Claude Code or pi) that run as separate tabs the user can watch and take over.",
      tools: toolsFor(caller),
    }),
  );
}
