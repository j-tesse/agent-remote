import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { HarnessConfig } from "../config.js";
import type {
  ChatAction,
  ChatEvent,
  ChatUiOption,
  ChatUiRequest,
} from "../../shared/protocol.js";
import { promptParts } from "../../shared/chat.js";
import type {
  ChatSession,
  ChatSessionHandlers,
  HarnessAdapter,
  SessionOptions,
} from "./types.js";

// Generic adapter for any agent speaking ACP (Agent Client Protocol,
// agentclientprotocol.com): newline-delimited JSON-RPC 2.0 over stdio. One
// adapter, many harnesses (gemini --experimental-acp, goose acp, …) — each is
// just a config entry. ALL ACP vocabulary stays in this file.
// A ChatSession, not a ChatTranslator: the agent sends requests of its own
// (request_permission) and the handshake must finish before a prompt.

const PROTOCOL_VERSION = 1;
const STDERR_TAIL = 4000;

export function createAcpAdapter(
  cfg: HarnessConfig,
  meta: { id: string; name: string },
): HarnessAdapter {
  return {
    id: meta.id,
    name: meta.name,
    invocation: () => ({ command: cfg.command, args: cfg.args ?? [], env: cfg.env }),
    createChatSession: (opts) => new AcpChatSession(cfg, opts),
  };
}

// --- wire shapes (only what we read) --------------------------------------

type Json = Record<string, unknown>;
interface RpcMsg {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message?: string };
}
interface ContentBlock {
  type?: string;
  text?: string;
}
interface ToolCallContent {
  type?: string; // content | diff | terminal
  content?: ContentBlock;
  path?: string;
  oldText?: string | null;
  newText?: string;
}
interface AcpToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  content?: ToolCallContent[];
  locations?: { path?: string; line?: number }[];
  rawInput?: unknown;
  rawOutput?: unknown;
}
interface PermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

// --- pure mapping (exported for unit tests) -------------------------------

const INTENT: Record<string, ChatUiOption["intent"]> = {
  allow_once: "accept",
  allow_always: "always",
  reject_once: "reject",
  reject_always: "reject",
};

export function acpOptions(options: PermissionOption[]): ChatUiOption[] {
  return options.map((o) => ({
    value: o.optionId,
    label: o.name || o.optionId,
    ...(o.kind && INTENT[o.kind] ? { intent: INTENT[o.kind] } : {}),
  }));
}

/** Tool name for the transcript: ACP's `kind` (edit/read/execute/…), falling
 * back to the title when the agent didn't classify it. */
export function acpToolName(tc: Partial<AcpToolCall>): string {
  return tc.kind && tc.kind !== "other" ? tc.kind : tc.title || "tool";
}

/** Args in the field vocabulary `toolView` reads (path, oldText/newText or
 * edits[], command, description), so ACP tools get the shared diff/code views. */
export function acpToolArgs(tc: Partial<AcpToolCall>): Json {
  const raw = tc.rawInput;
  const args: Json = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Json) } : {};
  const diffs = (tc.content ?? []).filter((c) => c.type === "diff" && typeof c.path === "string");
  const hasEdit = "old_string" in args || "oldText" in args || "edits" in args;
  if (diffs.length && !hasEdit) {
    args.path ??= diffs[0].path;
    args.edits = diffs.map((d) => ({ oldText: d.oldText ?? "", newText: d.newText ?? "" }));
  }
  const loc = tc.locations?.find((l) => typeof l.path === "string");
  if (loc && args.path === undefined && args.file_path === undefined) args.path = loc.path;
  if (tc.title && args.description === undefined) args.description = tc.title;
  return args;
}

/** Textual output of a tool call update, or undefined when it carries none. */
export function acpToolOutput(tc: Partial<AcpToolCall>): string | undefined {
  const parts: string[] = [];
  for (const c of tc.content ?? []) {
    if (c.type === "content" && c.content?.type === "text" && c.content.text) parts.push(c.content.text);
    else if (c.type === "diff" && c.path) parts.push(`Edited ${c.path}`);
    else if (c.type === "terminal") parts.push("[terminal output]");
  }
  if (parts.length) return parts.join("\n");
  const ro = tc.rawOutput;
  if (ro === undefined || ro === null) return undefined;
  if (typeof ro === "string") return ro;
  const o = ro as Json;
  for (const k of ["output", "stdout", "content", "text"]) if (typeof o[k] === "string") return o[k] as string;
  return JSON.stringify(ro, null, 2);
}

/** A plan update as a checklist (rendered as a tool part's output). */
export function acpPlanText(entries: { content?: string; status?: string }[]): string {
  const mark: Record<string, string> = { completed: "[x]", in_progress: "[~]" };
  return entries.map((e) => `${mark[e.status ?? ""] ?? "[ ]"} ${e.content ?? ""}`).join("\n");
}

// --- session --------------------------------------------------------------

interface Pending {
  resolve(result: any): void;
  reject(err: Error): void;
}

class AcpChatSession implements ChatSession {
  private child?: ChildProcessWithoutNullStreams;
  private h!: ChatSessionHandlers;
  private buf = "";
  private stderr = "";
  private nextId = 1;
  private calls = new Map<number, Pending>();
  private sessionId?: string;
  private agentCaps: Json = {};
  private ready = false;
  private beforeReady: ChatAction[] = [];
  private closing = false;
  private exited = false;

  // Turn state.
  private busy = false;
  private queue: ChatAction[] = [];
  private cancelled = false;
  private streaming = false;
  private lastKind: "text" | "thinking" | "tool" | null = null;
  private tools = new Map<string, { ended: boolean }>();
  private planId?: string;
  // Replay (session/load) state: user chunks arrive piecewise.
  private replaying = false;
  private userText: string | null = null;
  // Our card id → the agent's JSON-RPC request id.
  private permissions = new Map<string, number | string>();

  constructor(
    private readonly cfg: HarnessConfig,
    private readonly opts: SessionOptions,
  ) {}

  start(handlers: ChatSessionHandlers): void {
    this.h = handlers;
    const child = spawn(this.cfg.command, this.cfg.args ?? [], {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.cfg.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL);
    });
    child.stdin.on("error", () => {}); // EPIPE after the agent died; exit handles it
    child.on("error", (err) => {
      this.emit({ type: "notice", level: "error", text: `Failed to start ${this.cfg.command}: ${err.message}` });
      this.finish(null);
    });
    child.on("exit", (code) => this.finish(code));
    void this.handshake();
  }

  action(action: ChatAction): void {
    if (this.exited) return;
    if (!this.ready && (action.type === "prompt" || action.type === "set-mode")) {
      this.beforeReady.push(action);
      if (action.type === "prompt") this.echoPrompt(action);
      return;
    }
    switch (action.type) {
      case "prompt":
        if (this.busy) {
          // Shown as a queued chip; becomes a bubble when actually sent.
          this.queue.push(action);
          this.emitQueue();
        } else this.sendPrompt(action, true);
        return;
      case "abort":
        return this.abort();
      case "ui-response":
        return this.answerPermission(action);
      case "set-mode":
        return void this.setMode(action.mode);
      default:
        return; // set-model/effort/usage/rewind: not in stable ACP
    }
  }

  close(): void {
    this.closing = true;
    this.child?.stdin.end();
    this.child?.kill("SIGTERM");
  }

  // --- handshake ----------------------------------------------------------

  private async handshake(): Promise<void> {
    try {
      const init = await this.call("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        // No client fs/terminal yet: the agent uses its own tools.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      this.agentCaps = (init?.agentCapabilities as Json) ?? {};
      let result: any;
      if (this.opts.resume && this.agentCaps.loadSession) {
        try {
          this.replaying = true;
          result = await this.call("session/load", {
            sessionId: this.opts.resume,
            cwd: this.opts.cwd,
            mcpServers: [],
          });
          this.sessionId = this.opts.resume;
        } catch (err) {
          this.emit({
            type: "notice",
            level: "warning",
            text: `Couldn't resume (${(err as Error).message}); started a new session.`,
          });
        } finally {
          this.flushUser();
          this.endAssistant();
          this.replaying = false;
        }
      } else if (this.opts.resume) {
        this.emit({ type: "notice", level: "warning", text: "This agent can't resume sessions; started a new one." });
      }
      if (!this.sessionId) {
        result = await this.call("session/new", { cwd: this.opts.cwd, mcpServers: [] });
        this.sessionId = result?.sessionId;
        if (!this.sessionId) throw new Error("session/new returned no sessionId");
      }
      this.applyModes(result?.modes);
      this.h.onResumable?.(this.sessionId!);
      this.ready = true;
      for (const a of this.beforeReady.splice(0)) {
        if (a.type === "prompt") {
          if (this.busy) {
            this.queue.push(a);
            this.emitQueue();
          } else this.sendPrompt(a, false);
        } else this.action(a);
      }
    } catch (err) {
      if (this.exited) return;
      this.emit({
        type: "notice",
        level: "error",
        text: `ACP handshake failed: ${(err as Error).message}. If the agent needs a login, run \`${this.cfg.command}\` once in a terminal.`,
      });
    }
  }

  private applyModes(modes: any): void {
    const list = Array.isArray(modes?.availableModes) ? modes.availableModes : [];
    if (!list.length) return;
    this.emit({
      type: "modes",
      modes: list.map((m: any) => ({ id: m.id, label: m.name ?? m.id, ...(m.description ? { description: m.description } : {}) })),
      current: modes.currentModeId ?? null,
    });
  }

  // --- prompts --------------------------------------------------------------

  private echoPrompt(a: Extract<ChatAction, { type: "prompt" }>): void {
    this.emit({
      type: "user-message",
      message: { id: randomUUID(), role: "user", parts: promptParts(a.text, a.images), createdAt: Date.now() },
    });
  }

  private sendPrompt(a: Extract<ChatAction, { type: "prompt" }>, echo: boolean): void {
    if (echo) this.echoPrompt(a);
    const blocks: Json[] = [];
    if (a.text) blocks.push({ type: "text", text: a.text });
    const images = (a.images ?? []).filter((i) => i.data);
    const caps = (this.agentCaps.promptCapabilities as Json) ?? {};
    if (images.length && caps.image) {
      for (const i of images) blocks.push({ type: "image", mimeType: i.mediaType, data: i.data });
    } else if (images.length) {
      this.emit({ type: "notice", level: "warning", text: "This agent doesn't accept images; sent the text only." });
    }
    this.busy = true;
    this.cancelled = false;
    this.emit({ type: "busy", busy: true });
    this.call("session/prompt", { sessionId: this.sessionId, prompt: blocks }).then(
      (res) => this.endTurn(res?.stopReason),
      (err: Error) => {
        if (!this.cancelled && !this.exited)
          this.emit({ type: "notice", level: "error", text: err.message });
        this.endTurn("cancelled");
      },
    );
  }

  private endTurn(stopReason?: string): void {
    if (this.exited) return; // finish() already closed the turn
    if (stopReason === "max_tokens") this.emit({ type: "notice", level: "warning", text: "The agent hit its token limit." });
    else if (stopReason === "max_turn_requests") this.emit({ type: "notice", level: "warning", text: "The agent hit its turn limit." });
    else if (stopReason === "refusal") this.emit({ type: "notice", level: "warning", text: "The agent refused to continue." });
    this.cancelPermissions();
    this.endAssistant();
    this.busy = false;
    this.emit({ type: "busy", busy: false });
    const next = this.queue.shift();
    if (next?.type === "prompt" && !this.exited) {
      this.emitQueue();
      this.sendPrompt(next, true);
    }
  }

  private abort(): void {
    if (this.queue.length) {
      this.queue = [];
      this.emitQueue();
    }
    if (!this.busy || !this.sessionId) return;
    this.cancelled = true;
    this.notify("session/cancel", { sessionId: this.sessionId });
    // Spec: the client must answer outstanding permission requests `cancelled`.
    this.cancelPermissions();
  }

  private emitQueue(): void {
    this.emit({ type: "queue", queued: this.queue.map((a) => (a.type === "prompt" ? a.text : "")) });
  }

  private async setMode(mode: string): Promise<void> {
    try {
      await this.call("session/set_mode", { sessionId: this.sessionId, modeId: mode });
      this.emit({ type: "mode-changed", current: mode });
    } catch (err) {
      this.emit({ type: "notice", level: "error", text: `Couldn't switch mode: ${(err as Error).message}` });
    }
  }

  // --- permissions --------------------------------------------------------

  private requestPermission(rpcId: number | string, params: any): void {
    const tc: AcpToolCall = params?.toolCall ?? { toolCallId: randomUUID() };
    if (tc.toolCallId && !this.tools.has(tc.toolCallId)) this.toolCall(tc);
    const id = randomUUID();
    this.permissions.set(id, rpcId);
    const request: ChatUiRequest = {
      id,
      kind: "select",
      title: tc.title ? `Allow: ${tc.title}?` : "Allow this tool call?",
      options: acpOptions(params?.options ?? []),
      tool: { name: acpToolName(tc), args: acpToolArgs(tc) },
    };
    this.emit({ type: "ui-request", request });
  }

  private answerPermission(a: Extract<ChatAction, { type: "ui-response" }>): void {
    const rpcId = this.permissions.get(a.requestId);
    if (rpcId === undefined) return;
    this.permissions.delete(a.requestId);
    // ACP has no deny-reason field; a rejection's note is dropped.
    const outcome =
      a.cancelled || !a.value ? { outcome: "cancelled" } : { outcome: "selected", optionId: a.value };
    this.send({ id: rpcId, result: { outcome } });
    this.emit({ type: "ui-request-done", requestId: a.requestId });
  }

  private cancelPermissions(): void {
    for (const [id, rpcId] of this.permissions) {
      this.send({ id: rpcId, result: { outcome: { outcome: "cancelled" } } });
      this.emit({ type: "ui-request-done", requestId: id });
    }
    this.permissions.clear();
  }

  // --- session/update -------------------------------------------------------

  private onUpdate(u: any): void {
    switch (u?.sessionUpdate) {
      case "user_message_chunk":
        // Live turns are echoed by us; only a session/load replay carries these.
        if (!this.replaying) return;
        this.endAssistant();
        if (u.content?.type === "text") this.userText = (this.userText ?? "") + u.content.text;
        return;
      case "agent_message_chunk":
        return this.chunk("text", u.content);
      case "agent_thought_chunk":
        return this.chunk("thinking", u.content);
      case "tool_call":
        return this.toolCall(u);
      case "tool_call_update":
        return this.toolUpdate(u);
      case "plan":
        return this.plan(u.entries ?? []);
      case "available_commands_update":
        return this.emit({
          type: "commands",
          commands: (u.availableCommands ?? []).map((c: any) => ({
            name: c.name,
            ...(c.description ? { description: c.description } : {}),
          })),
        });
      case "current_mode_update":
        if (u.currentModeId) this.emit({ type: "mode-changed", current: u.currentModeId });
        return;
      default:
        return;
    }
  }

  private chunk(kind: "text" | "thinking", content: ContentBlock | undefined): void {
    if (content?.type !== "text" || !content.text) return;
    this.ensureAssistant();
    if (this.lastKind !== kind) {
      this.emit({ type: "part-start", kind });
      this.lastKind = kind;
    }
    this.emit({ type: "part-delta", kind, delta: content.text });
  }

  private toolCall(tc: AcpToolCall): void {
    if (!tc.toolCallId) return;
    if (this.tools.has(tc.toolCallId)) return this.toolUpdate(tc);
    this.ensureAssistant();
    this.tools.set(tc.toolCallId, { ended: false });
    this.lastKind = "tool";
    this.emit({ type: "tool-call", toolId: tc.toolCallId, name: acpToolName(tc), args: acpToolArgs(tc) });
    this.toolUpdate(tc, true);
  }

  private toolUpdate(tc: Partial<AcpToolCall>, initial = false): void {
    const t = tc.toolCallId ? this.tools.get(tc.toolCallId) : undefined;
    if (!t || t.ended) {
      if (!t && tc.toolCallId) this.toolCall(tc as AcpToolCall);
      return;
    }
    // A diff in the initial call is the proposal (shown as args), not output.
    const output = acpToolOutput(
      initial ? { ...tc, content: tc.content?.filter((c) => c.type !== "diff") } : tc,
    );
    if (tc.status === "completed" || tc.status === "failed") {
      t.ended = true;
      this.emit({ type: "tool-end", toolId: tc.toolCallId!, output: output ?? "", isError: tc.status === "failed" });
    } else if (tc.status === "in_progress" || output !== undefined) {
      this.emit({ type: "tool-update", toolId: tc.toolCallId!, output: output ?? "" });
    }
  }

  private plan(entries: { content?: string; status?: string }[]): void {
    const output = acpPlanText(entries);
    if (!this.planId) {
      this.ensureAssistant();
      this.planId = `plan-${randomUUID()}`;
      this.lastKind = "tool";
      this.emit({ type: "tool-call", toolId: this.planId, name: "plan", args: { description: "Plan" } });
    }
    this.emit({ type: "tool-update", toolId: this.planId, output });
  }

  private ensureAssistant(): void {
    this.flushUser();
    if (this.streaming) return;
    this.streaming = true;
    this.lastKind = null;
    this.emit({ type: "assistant-start", messageId: randomUUID() });
  }

  private endAssistant(): void {
    if (this.planId) {
      const id = this.planId;
      this.planId = undefined;
      this.emit({ type: "tool-end", toolId: id, output: "", isError: false });
    }
    if (!this.streaming) return;
    this.streaming = false;
    this.lastKind = null;
    this.emit({ type: "assistant-end" });
  }

  private flushUser(): void {
    if (this.userText === null) return;
    const text = this.userText;
    this.userText = null;
    this.emit({
      type: "user-message",
      message: { id: randomUUID(), role: "user", parts: promptParts(text), createdAt: Date.now() },
    });
  }

  // --- JSON-RPC -------------------------------------------------------------

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    // LF framing, not readline: U+2028/9 are legal inside JSON strings.
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: RpcMsg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // stray log line on stdout
      }
      this.onMessage(msg);
    }
  }

  private onMessage(msg: RpcMsg): void {
    if (msg.method === undefined && msg.id !== undefined) {
      const p = this.calls.get(Number(msg.id));
      if (!p) return;
      this.calls.delete(Number(msg.id));
      if (msg.error) p.reject(new Error(msg.error.message ?? `ACP error ${msg.error.code}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "session/update") return this.onUpdate(msg.params?.update);
    if (msg.method === "session/request_permission" && msg.id !== undefined)
      return this.requestPermission(msg.id, msg.params);
    // fs/*, terminal/*: not advertised, so not served.
    if (msg.id !== undefined)
      this.send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }

  private call(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.exited) return reject(new Error("agent exited"));
      this.calls.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  private send(msg: Json): void {
    if (this.exited || !this.child?.stdin.writable) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  }

  private emit(e: ChatEvent): void {
    this.h.onEvent(e);
  }

  private finish(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const p of this.calls.values()) p.reject(new Error("agent exited"));
    this.calls.clear();
    this.permissions.clear();
    this.endAssistant();
    if (this.busy) {
      this.busy = false;
      this.emit({ type: "busy", busy: false });
    }
    if (!this.closing && code !== 0) {
      const tail = this.stderr.trim().split("\n").slice(-5).join("\n");
      this.emit({
        type: "notice",
        level: "error",
        text: `Agent exited${code === null ? "" : ` with code ${code}`}${tail ? `:\n${tail}` : ""}`,
      });
    }
    this.h.onExit(code);
  }
}
