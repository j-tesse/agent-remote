// Host tools that let an agent start and drive OTHER chat sessions — top-level
// tabs, indistinguishable from ones a human opened. Harness-agnostic: speaks only
// ChatAction/ChatState through the manager; each adapter exposes the HostToolSet
// natively (claude: in-process MCP server). Spawns are rate-limited globally.
import type { SessionManager } from "./sessions/manager.js";
import type { HostTool, HostToolParam, HostToolSet } from "./adapters/types.js";
import type { AssistantSettings, ChatState, SessionInfo } from "../shared/protocol.js";
import { emptyChatState } from "../shared/chat.js";
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
 * as user turns, a not-yet-busy session is still starting, not idle.
 * `assistantWork` = backend AI-assistant work in flight (auto-PR, continuity, a
 * card being auto-answered) — the turn isn't over until that is. */
export function childStatus(
  state: ChatState | undefined,
  info: Pick<SessionInfo, "status"> | undefined,
  sent: number,
  assistantWork: readonly string[] = [],
): ChildStatus {
  if (!info || info.status === "exited" || !state) return "exited";
  if (assistantWork.length) return "running";
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

const NEW_SESSION = ["never", "after-pr", "always"];
const opt = (type: HostToolParam["type"], description: string, extra?: Partial<HostToolParam>): HostToolParam => ({
  type,
  description,
  optional: true,
  ...extra,
});
const enabledParam = opt("boolean", "Turn this capability on/off.");
const instructionsParam = opt("string", "Free-text instructions (empty = default rubric).");

/** Overlay for the child's AI-assistant checklist; omitted fields are inherited. */
export const ASSISTANT_PARAM: HostToolParam = opt(
  "object",
  "AI-assistant settings for the new session, overlaid on this session's own (which it inherits by default); give only what should differ. E.g. {autoPr:{enabled:true}} opens a PR for the work once its turn finishes.",
  {
    properties: {
      permissions: opt(
        "object",
        "Auto-answer tool permission prompts. Can only be disabled here, never enabled or loosened.",
        { properties: { enabled: enabledParam } },
      ),
      questions: opt("object", "Auto-answer AskUserQuestion dialogs.", {
        properties: {
          enabled: enabledParam,
          instructions: instructionsParam,
          onlyIfSure: opt("boolean", "Abstain unless the right option is unambiguous."),
        },
      }),
      autoPr: opt("object", "Commit, push and open a PR when a turn finishes the work.", {
        properties: {
          enabled: enabledParam,
          instructions: instructionsParam,
          autoMerge: opt("boolean", "Squash-merge the PR once checks pass."),
        },
      }),
      continuity: opt("object", "Keep the agent working: write and send the next prompt unattended.", {
        properties: {
          enabled: enabledParam,
          instructions: instructionsParam,
          newSession: opt("string", "When to start a fresh session instead of replying in place.", {
            enum: NEW_SESSION,
          }),
        },
      }),
    },
  },
);

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `base` with `overlay` merged in, validated against ASSISTANT_PARAM. Throws on
 * anything malformed, and on any attempt to grant permissions — a spawned
 * session must never auto-accept more than its caller. */
export function overlayAssistant(base: AssistantSettings, overlay: unknown): AssistantSettings {
  const out = structuredClone(base);
  if (overlay === undefined || overlay === null) return out;
  if (!isObj(overlay)) throw new Error("assistant must be an object");
  const sections = ASSISTANT_PARAM.properties!;
  for (const [name, value] of Object.entries(overlay)) {
    const fields = sections[name]?.properties;
    if (!fields) throw new Error(`Unknown assistant setting: ${name}`);
    if (!isObj(value)) throw new Error(`assistant.${name} must be an object`);
    const target = out[name as keyof Omit<AssistantSettings, "enabled">] as unknown as Record<string, unknown>;
    for (const [key, v] of Object.entries(value)) {
      const spec = fields[key];
      const path = `assistant.${name}.${key}`;
      if (!spec) throw new Error(`Unknown assistant setting: ${path}`);
      if (typeof v !== spec.type) throw new Error(`${path} must be a ${spec.type}`);
      if (spec.enum && !spec.enum.includes(v as string))
        throw new Error(`${path} must be one of ${spec.enum.join(", ")}`);
      if (name === "permissions" && v !== false)
        throw new Error("assistant.permissions can only be disabled for a spawned session");
      target[key] = v;
    }
  }
  return out;
}

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
    const work = manager.assistantWork(id);
    const status = childStatus(state, info, child?.sent ?? 0, work);
    return {
      sessionId: id,
      harness: info?.harnessId,
      status,
      ...(status === "running" && work.length
        ? { assistant: [...new Set(work)] }
        : {}),
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
        childStatus(
          manager.chatState(id),
          manager.sessionInfo(id),
          sent(),
          manager.assistantWork(id),
        ) !== "running";
      if (check()) return resolve();
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      };
      // Deferred: the event that ends a turn is also what makes the turn router /
      // card decider take their hold, and they may be later listeners than us.
      const recheck = (sid: string) =>
        sid === id && setImmediate(() => check() && done());
      const timer = setTimeout(done, sec * 1000);
      const unsubscribe = manager.subscribe({
        onStarted() {},
        onOutput() {},
        onExit: (sid) => sid === id && done(),
        onRemoved: (sid) => sid === id && done(),
        onChatEvent: recheck,
        onAssistantWork: recheck,
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
        "Start a new, independent agent chat session that the user sees as an ordinary tab, and send it a first prompt. Returns immediately with its sessionId; use wait_session to get its reply. The new session has no memory of this conversation, so the prompt must be self-contained. It inherits this session's AI-assistant settings unless `assistant` overrides some. Limited to " +
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
        assistant: ASSISTANT_PARAM,
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
        // Validated before taking a slot, so a bad overlay spends nothing.
        const assistant = overlayAssistant(
          manager.chatState(caller)?.assistant ?? emptyChatState().assistant,
          args.assistant,
        );
        const slot = limiter.take();
        if (!slot.ok)
          throw new Error(
            `Spawn limit reached (${SPAWN_LIMIT} per ${SPAWN_WINDOW_MS / 60_000} min); next slot in ${Math.ceil(slot.retryMs / 1000)}s`,
          );
        const info = manager.start(harness, { cwd: folder, spawnedBy: caller });
        children.set(info.id, { owner: caller, sent: 0 });
        // Before the first prompt, so its very first card is already covered.
        manager.chatAction(info.id, { type: "set-assistant", settings: assistant });
        send(info.id, prompt);
        // `spawnedSession` is what the UI keys its inline panel off (render.ts).
        return JSON.stringify({
          spawnedSession: info.id,
          harness,
          folder,
          status: "running",
          assistant: {
            permissions: assistant.permissions.enabled,
            questions: assistant.questions.enabled,
            autoPr: assistant.autoPr.enabled,
            continuity: assistant.continuity.enabled,
          },
        });
      },
    },
    {
      name: "wait_session",
      description:
        "Wait (bounded) for a session you spawned to finish its turn, including any AI-assistant work that follows it (auto-PR, continuity, auto-answered cards). Returns status running (timed out — call again; `assistant` names AI-assistant work still in flight), idle (with its reply), waiting-for-input (a permission/question card awaits the user), or exited.",
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
        const status = childStatus(
          manager.chatState(id),
          manager.sessionInfo(id),
          child.sent,
          manager.assistantWork(id),
        );
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
