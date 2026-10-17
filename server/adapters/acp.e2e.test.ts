// Contract test for the ACP (Agent Client Protocol) adapter — DRAFTED BEFORE THE
// ADAPTER EXISTS (TDD, see AGENTS.md). Pins the observable backend contract:
// the ChatEvents an ACP agent's JSON-RPC stream must fold into, and the wire
// messages our actions must produce.
//
// Driven through the real SessionManager against `acp-fake-agent.mjs`, a
// scripted ACP agent (real subprocess, real stdio framing; no model, no
// endpoint, no tokens) — hence e2e, not the pure gate. Deterministic, so every
// assertion is a hard gate. A live smoke against a real ACP agent (gemini /
// goose → local vLLM) belongs in a separate, self-skipping file.
//
// Adapter shape this assumes (decisions the implementation must honour):
//   - `createAcpAdapter(cfg, {id, name})` in ./acp.ts, where `cfg.args` is a
//     NEW optional HarnessConfig field (real ACP agents need flags:
//     `gemini --experimental-acp`, `goose acp`).
//   - A `createChatSession` adapter, NOT a ChatTranslator: ACP is
//     bidirectional JSON-RPC — the agent sends requests (request_permission)
//     and the handshake (initialize → session/new) must finish before a prompt,
//     but a translator can only write stdin in response to a ChatAction.
//   - The resume key IS the ACP sessionId; resume = `session/load`.
//   - We advertise no client fs/terminal capabilities (yet), so the agent uses
//     its own tools and never calls back into us for file I/O.
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../sessions/manager.js";
import { applyChatEvent, emptyChatState } from "../../shared/chat.js";
import { toolView } from "../../shared/render.js";
import type {
  ChatAction,
  ChatEvent,
  ChatImageRef,
  ChatPart,
  ChatState,
  ChatUiRequest,
} from "../../shared/protocol.js";
import type { HarnessAdapter } from "./types.js";
import { createAcpAdapter } from "./acp.js";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "acp-fake-agent.mjs");
const ID = "acp-fake";

function manager(): SessionManager {
  const adapter = createAcpAdapter(
    { enabled: true, command: process.execPath, args: [FAKE] },
    { id: ID, name: "Fake ACP" },
  );
  return new SessionManager(new Map<string, HarnessAdapter>([[ID, adapter]]));
}

const freshDir = () => mkdtempSync(join(tmpdir(), "agent-remote-acp-"));

// --- wire log (what the fake agent saw / sent) ---------------------------

interface WireMsg {
  dir: "in" | "out";
  msg: {
    id?: number | string;
    method?: string;
    params?: any;
    result?: any;
    error?: any;
  };
}

function wire(dir: string): WireMsg[] {
  const f = join(dir, ".acp-fake-log.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
/** Requests/notifications the agent received for `method`. */
const received = (dir: string, method: string) =>
  wire(dir).filter((w) => w.dir === "in" && w.msg.method === method);
/** Our responses to the agent's outbound requests (permission answers). */
const repliesTo = (dir: string, method: string) => {
  const log = wire(dir);
  const ids = new Set(
    log.filter((w) => w.dir === "out" && w.msg.method === method).map((w) => w.msg.id),
  );
  return log.filter((w) => w.dir === "in" && !w.msg.method && ids.has(w.msg.id!));
};

// --- driver ---------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out: ${what}`)), ms).unref()),
  ]);
}

/** One ACP session through the manager. `onCard` decides how a ui-request is
 * answered (default: leave it pending). */
class Driver {
  readonly events: ChatEvent[] = [];
  readonly id: string;
  resumeKey?: string;
  persistable = false;
  exitCode?: number | null;
  onCard?: (req: ChatUiRequest, d: Driver) => void;
  private waiters: Array<{ pred: (e: ChatEvent) => boolean; resolve: (e: ChatEvent) => void }> = [];
  private exitWaiters: Array<() => void> = [];
  private unsub: () => void;

  constructor(readonly m: SessionManager, readonly cwd: string, resume?: string) {
    this.unsub = m.subscribe({
      onStarted: () => {},
      onOutput: () => {},
      onExit: (id, code) => {
        if (id !== this.id) return;
        this.exitCode = code;
        this.exitWaiters.splice(0).forEach((w) => w());
      },
      onResumable: (id, key) => {
        if (id !== this.id && this.id) return;
        this.resumeKey = key;
        this.persistable = !!(m.sessionInfo(id) && m.sessionFolder(id));
      },
      onChatEvent: (id, e) => {
        if (id !== this.id) return;
        this.events.push(e);
        this.waiters = this.waiters.filter((w) => (w.pred(e) ? (w.resolve(e), false) : true));
        if (e.type === "ui-request") this.onCard?.(e.request, this);
      },
    });
    this.id = m.start(ID, { cwd, resume }).id;
  }

  act(a: ChatAction) {
    this.m.chatAction(this.id, a);
  }

  /** First event matching `pred`, including ones already seen. */
  waitFor<T extends ChatEvent>(pred: (e: ChatEvent) => e is T, ms = 10_000, what = "event"): Promise<T> {
    const seen = this.events.find(pred);
    if (seen) return Promise.resolve(seen as T);
    return withTimeout(
      new Promise<T>((resolve) => this.waiters.push({ pred, resolve: resolve as (e: ChatEvent) => void })),
      ms,
      what,
    );
  }

  /** Send a prompt; resolve on the first busy:false after it. */
  async prompt(text: string, images?: ChatImageRef[], ms = 15_000): Promise<void> {
    const from = this.events.length;
    this.act({ type: "prompt", text, images });
    await withTimeout(
      new Promise<void>((resolve) => {
        const check = (e: ChatEvent) => e.type === "busy" && !e.busy;
        if (this.events.slice(from).some(check)) return resolve();
        this.waiters.push({ pred: check, resolve: () => resolve() });
      }),
      ms,
      `turn for "${text}"`,
    );
  }

  exited(ms = 10_000): Promise<void> {
    if (this.exitCode !== undefined) return Promise.resolve();
    return withTimeout(new Promise<void>((r) => this.exitWaiters.push(r)), ms, "exit");
  }

  state(): ChatState {
    return this.events.reduce(applyChatEvent, emptyChatState());
  }

  close() {
    this.m.stop(this.id);
    this.unsub();
  }
}

const textOf = (parts: ChatPart[], type: "text" | "thinking" = "text") =>
  parts.map((p) => (p.type === type ? p.text : "")).join("");
const tools = (s: ChatState) =>
  s.messages.flatMap((m) => m.parts).filter((p): p is Extract<ChatPart, { type: "tool" }> => p.type === "tool");
const is =
  <K extends ChatEvent["type"]>(type: K) =>
  (e: ChatEvent): e is Extract<ChatEvent, { type: K }> =>
    e.type === type;

// --- tests ----------------------------------------------------------------

const open: Driver[] = [];
afterEach(() => open.splice(0).forEach((d) => d.close()));
function start(cwd = freshDir(), resume?: string, m = manager()): Driver {
  const d = new Driver(m, cwd, resume);
  open.push(d);
  return d;
}

describe("acp adapter (scripted fake agent)", () => {
  it("handshakes: initialize → session/new in the folder, surfaces modes, commands and the resume key", async () => {
    const d = start();
    const modes = await d.waitFor(is("modes"), 10_000, "modes");
    expect(modes.modes.map((x) => x.id)).toEqual(["ask", "code"]);
    expect(modes.modes[0]).toMatchObject({ label: "Ask", description: expect.any(String) });
    expect(modes.current).toBe("ask");

    const cmds = await d.waitFor(is("commands"), 10_000, "commands");
    expect(cmds.commands.map((c) => c.name)).toEqual(["web", "plan"]);

    const [init] = received(d.cwd, "initialize");
    expect(init, "agent was never initialized (or not spawned in the session cwd)").toBeTruthy();
    expect(init.msg.params.protocolVersion).toBe(1);
    // We can't serve the agent's terminal requests yet — must not claim to.
    expect(init.msg.params.clientCapabilities?.terminal ?? false).toBe(false);

    const [created] = received(d.cwd, "session/new");
    expect(created.msg.params.cwd.replace(/\/$/, "")).toBe(d.cwd.replace(/\/$/, ""));
    expect(created.msg.params.mcpServers).toEqual([]);

    // Resume key = the agent's own sessionId, reported once the session is registered.
    const sessionId = wire(d.cwd).find((w) => w.dir === "out" && w.msg.result?.sessionId)?.msg.result.sessionId;
    expect(d.resumeKey).toBe(sessionId);
    expect(d.persistable, "onResumable fired before the session was registered").toBe(true);
  });

  it("streams a turn: prompt → thinking + text chunks folded into one assistant message, busy brackets it", async () => {
    const d = start();
    await d.waitFor(is("modes"));
    await d.prompt("hello there");

    const s = d.state();
    expect(s.busy).toBe(false);
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(textOf(s.messages[0].parts)).toBe("hello there");
    expect(textOf(s.messages[1].parts, "thinking")).toBe("The user greeted me.");
    expect(textOf(s.messages[1].parts)).toBe("Hello, world.");

    const busyOn = d.events.findIndex((e) => e.type === "busy" && e.busy);
    const firstPart = d.events.findIndex((e) => e.type === "part-start" || e.type === "assistant-start");
    expect(busyOn, "busy:true never emitted").toBeGreaterThanOrEqual(0);
    expect(busyOn).toBeLessThan(firstPart);

    const [p] = received(d.cwd, "session/prompt");
    expect(p.msg.params.sessionId).toBe(d.resumeKey);
    expect(p.msg.params.prompt).toEqual([{ type: "text", text: "hello there" }]);
  });

  it("permission → select card with the tool, mapped option intents; Allow round-trips the optionId", async () => {
    const d = start();
    await d.waitFor(is("modes"));
    let card: ChatUiRequest | undefined;
    d.onCard = (req, dr) => {
      card = req;
      dr.act({ type: "ui-response", requestId: req.id, value: "allow-once" });
    };
    await d.prompt("edit notes");

    expect(card, "no ui-request for session/request_permission").toBeTruthy();
    expect(card!.kind).toBe("select");
    expect(card!.tool?.name).toBeTruthy();
    expect(card!.options).toEqual([
      expect.objectContaining({ value: "allow-once", label: "Allow", intent: "accept" }),
      expect.objectContaining({ value: "allow-always", label: "Always allow", intent: "always" }),
      expect.objectContaining({ value: "reject-once", label: "Reject", intent: "reject" }),
    ]);
    expect(d.events.some((e) => e.type === "ui-request-done" && e.requestId === card!.id)).toBe(true);

    const [answer] = repliesTo(d.cwd, "session/request_permission");
    expect(answer.msg.result).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });

    const s = d.state();
    expect(s.pendingRequests).toEqual([]);
    const [tool] = tools(s);
    expect(tool.status).toBe("done");
    expect(tool.output).toContain("Edited notes.txt");
    // ACP's diff content must reach the shared diff view, not a JSON dump.
    const view = toolView(tool);
    expect(view.body.kind).toBe("diff");
    expect(view.primary).toContain("notes.txt");
    expect(view.stat).toEqual({ added: 1, removed: 1 });
    expect(textOf(s.messages.at(-1)!.parts)).toContain("Done.");
  });

  it("permission → Reject marks the tool as an error and the turn continues", async () => {
    const d = start();
    await d.waitFor(is("modes"));
    d.onCard = (req, dr) => dr.act({ type: "ui-response", requestId: req.id, value: "reject-once", note: "not now" });
    await d.prompt("edit notes");

    const [answer] = repliesTo(d.cwd, "session/request_permission");
    expect(answer.msg.result.outcome).toEqual({ outcome: "selected", optionId: "reject-once" });
    const s = d.state();
    expect(tools(s)[0].status).toBe("error");
    expect(textOf(s.messages.at(-1)!.parts)).toContain("Okay, not editing.");
  });

  it("abort while a permission card is pending: session/cancel + the card answered `cancelled`, turn ends", async () => {
    const d = start();
    await d.waitFor(is("modes"));
    let cardId = "";
    d.onCard = (req, dr) => {
      cardId = req.id;
      dr.act({ type: "abort" });
    };
    await d.prompt("edit notes");

    expect(received(d.cwd, "session/cancel")).toHaveLength(1);
    // ACP spec: the client MUST answer outstanding permission requests with `cancelled`.
    const [answer] = repliesTo(d.cwd, "session/request_permission");
    expect(answer.msg.result).toEqual({ outcome: { outcome: "cancelled" } });
    expect(d.events.some((e) => e.type === "ui-request-done" && e.requestId === cardId)).toBe(true);
    expect(d.state().pendingRequests).toEqual([]);
  });

  it("abort mid-stream: session/cancel ends the turn quietly (a user stop is not an error)", async () => {
    const d = start();
    await d.waitFor(is("modes"));
    const turn = d.prompt("slow please", undefined, 5_000);
    await d.waitFor(is("part-delta"), 5_000, "first chunk");
    d.act({ type: "abort" });
    await turn; // well before the fake's 20s natural end

    expect(received(d.cwd, "session/cancel")).toHaveLength(1);
    expect(d.events.filter((e) => e.type === "notice" && e.level === "error")).toEqual([]);
    expect(textOf(d.state().messages.at(-1)!.parts)).toMatch(/^(tick )+$/);
  });

  it("set-mode → session/set_mode, confirmed by the agent's current_mode_update", async () => {
    const d = start();
    await d.waitFor(is("modes"));
    d.act({ type: "set-mode", mode: "code" });
    const changed = await d.waitFor(is("mode-changed"), 5_000, "mode-changed");
    expect(changed.current).toBe("code");
    const [req] = received(d.cwd, "session/set_mode");
    expect(req.msg.params).toEqual({ sessionId: d.resumeKey, modeId: "code" });
  });

  it("images ride as ACP image blocks (agent advertised promptCapabilities.image)", async () => {
    const d = start();
    await d.waitFor(is("modes"));
    const img: ChatImageRef = { id: "img-1", mediaType: "image/png", name: "dot.png", data: "iVBORw0KGgo=" };
    await d.prompt("look at this", [img]);

    const [p] = received(d.cwd, "session/prompt");
    expect(p.msg.params.prompt).toContainEqual({ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" });
    expect(p.msg.params.prompt).toContainEqual({ type: "text", text: "look at this" });
    const user = d.state().messages[0];
    expect(user.parts.some((x) => x.type === "image" && x.id === "img-1")).toBe(true);
    expect(textOf(d.state().messages[1].parts)).toContain("[1 image(s)]");
  });

  it("resume: session/load by key replays the transcript once, then continues in the same session", async () => {
    const dir = freshDir();
    const m = manager();
    const s1 = start(dir, undefined, m);
    await s1.waitFor(is("modes"));
    await s1.prompt("hello one");
    const key = s1.resumeKey!;
    s1.close();
    open.splice(open.indexOf(s1), 1);

    const s2 = start(dir, key, m);
    await s2.waitFor(is("modes"));
    expect(received(dir, "session/new"), "resume must not create a new session").toHaveLength(1);
    const [loaded] = received(dir, "session/load");
    expect(loaded.msg.params).toMatchObject({ sessionId: key, mcpServers: [] });
    expect(s2.resumeKey).toBe(key);

    // Replayed history is folded before any new prompt, and isn't busy.
    let s = s2.state();
    expect(s.busy).toBe(false);
    expect(s.messages.map((x) => [x.role, textOf(x.parts)])).toEqual([
      ["user", "hello one"],
      ["assistant", "Hello, world."],
    ]);

    await s2.prompt("ping");
    s = s2.state();
    expect(s.messages.filter((x) => x.role === "user").map((x) => textOf(x.parts))).toEqual(["hello one", "ping"]);
    expect(textOf(s.messages.at(-1)!.parts)).toBe("Echo: ping");
    expect(received(dir, "session/prompt").at(-1)!.msg.params.sessionId).toBe(key);
  });

  it("agent process dying mid-turn surfaces as session exit with its code", async () => {
    const d = start();
    await d.waitFor(is("modes"));
    d.act({ type: "prompt", text: "crash now" });
    await d.exited();
    expect(d.exitCode).toBe(3);
    await sleep(50);
    expect(d.state().busy).toBe(false);
  });
});
