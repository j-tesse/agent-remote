import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { SessionManager } from "../sessions/manager.js";
import { emptyChatState } from "../../shared/chat.js";
import type { ChatEvent, ChatState } from "../../shared/protocol.js";
import { createAiderAdapter } from "./aider.js";
import { endpointUp } from "./pi-local.testkit.js";

// Live: a REAL aider (via aider-bridge.py) through the production SessionManager,
// pointed at the local vLLM (zero tokens). Self-skips without aider/endpoint.
// Hard gates are our surfacing (cards, Edit parts, abort, commands, modes);
// whether the small model writes the right fix is the softer check.

async function servedModel(baseUrl: string): Promise<string | undefined> {
  try {
    const res = await fetch(new URL("models", baseUrl.replace(/\/?$/, "/")));
    const body = (await res.json()) as { data?: { id?: string }[] };
    return body.data?.[0]?.id;
  } catch {
    return undefined;
  }
}

class Driver {
  readonly events: ChatEvent[] = [];
  state: ChatState = emptyChatState();
  readonly id: string;
  private waiters: { pred: () => boolean; resolve: () => void }[] = [];
  constructor(
    private readonly manager: SessionManager,
    cwd: string,
    private readonly answer?: string,
  ) {
    manager.subscribe({
      onStarted: () => {},
      onOutput: () => {},
      onExit: () => this.check(),
      onChatEvent: (sid, event) => {
        if (sid !== this.id) return;
        this.events.push(event);
        this.state = manager.chatState(sid) ?? this.state;
        if (event.type === "ui-request" && this.answer)
          manager.chatAction(sid, { type: "ui-response", requestId: event.request.id, value: this.answer });
        this.check();
      },
    });
    this.id = manager.start("aider", { cwd }).id;
  }
  private check() {
    this.waiters = this.waiters.filter((w) => (w.pred() ? (w.resolve(), false) : true));
  }
  until(pred: () => boolean, ms = 120_000, what = "condition"): Promise<void> {
    if (pred()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
      this.waiters.push({ pred, resolve: () => (clearTimeout(t), resolve()) });
    });
  }
  /** Prompt and wait for the turn it starts to end. */
  async turn(text: string, ms?: number): Promise<void> {
    const before = this.state.messages.filter((m) => m.role === "user").length;
    this.manager.chatAction(this.id, { type: "prompt", text });
    await this.until(
      () => this.state.messages.filter((m) => m.role === "user").length > before && !this.state.busy,
      ms,
      `turn "${text}"`,
    );
  }
}

describe("aider (live, local vLLM)", async () => {
  let config;
  try {
    config = loadConfig();
  } catch {
    config = undefined;
  }
  const baseUrl = config?.llm?.baseUrl;
  const model = baseUrl && (await endpointUp(baseUrl)) ? await servedModel(baseUrl) : undefined;
  const command = config?.harnesses.aider?.command ?? "aider";
  let haveAider = true;
  try {
    execFileSync(command, ["--version"], { stdio: "ignore", timeout: 30_000 });
  } catch {
    haveAider = false;
  }
  const run = !!model && haveAider;

  let dir = "";
  let manager: SessionManager;
  beforeAll(() => {
    if (!run) return;
    const adapter = createAiderAdapter({
      enabled: true,
      command,
      args: [
        ...["--model", `openai/${model}`, "--weak-model", `openai/${model}`, "--editor-model", `openai/${model}`],
        ...["--openai-api-base", baseUrl!, "--openai-api-key", "dummy"],
        "--no-auto-commits",
        "--no-show-model-warnings",
      ],
    });
    manager = new SessionManager(new Map([[adapter.id, adapter]]));
    dir = mkdtempSync(join(tmpdir(), "aider-e2e-"));
    writeFileSync(join(dir, "calc.py"), "def add(a, b):\n    return a - b\n");
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!run)("starts with commands + modes, and runs a token-free command turn", async () => {
    const d = new Driver(manager, dir);
    await d.until(() => d.state.commands.length > 0, 60_000, "hello");
    expect(d.state.commands.map((c) => c.name)).toContain("add");
    expect(d.state.commands.map((c) => c.name)).not.toContain("editor");
    expect(d.state.modes.map((m) => m.id)).toEqual(["code", "ask", "architect"]);
    expect(d.state.currentMode).toBe("code");

    await d.turn("/ls", 30_000);
    const reply = d.state.messages.at(-1);
    expect(reply?.role).toBe("assistant");
    expect(JSON.stringify(reply?.parts)).toContain("calc.py");

    d.events.length = 0;
    manager.chatAction(d.id, { type: "set-mode", mode: "ask" });
    await d.until(() => d.state.currentMode === "ask", 30_000, "mode switch");
    manager.stop(d.id);
  }, 120_000);

  it.skipIf(!run)("asks to add the mentioned file, then shows the edit as a diff part", async () => {
    const d = new Driver(manager, dir, "y");
    await d.turn("In calc.py, add() subtracts instead of adding. Fix it. Reply with the edit only.", 180_000);

    // Deterministic: aider's "Add file to the chat?" became a card we answered.
    const card = d.events.find((e) => e.type === "ui-request");
    expect(card).toMatchObject({
      request: { kind: "select", title: expect.stringContaining("Add file to the chat"), message: "calc.py" },
    });
    expect(d.state.pendingRequests).toHaveLength(0);

    // Every SEARCH/REPLACE block became an Edit tool part — never raw markers.
    const parts = d.state.messages.filter((m) => m.role === "assistant").flatMap((m) => m.parts);
    expect(JSON.stringify(parts)).not.toContain("<<<<<<< SEARCH");
    const edits = parts.filter((p) => p.type === "tool" && p.name === "Edit");
    expect(edits.length).toBeGreaterThan(0);
    expect(edits[0]).toMatchObject({ args: { file_path: "calc.py" } });

    // Softer (model): the fix actually landed and was reported as applied.
    expect(readFileSync(join(dir, "calc.py"), "utf8")).toContain("a + b");
    expect(edits.some((p) => p.type === "tool" && p.status === "done")).toBe(true);
    manager.stop(d.id);
  }, 240_000);

  it.skipIf(!run)("Stop interrupts a reply and the session keeps working", async () => {
    const d = new Driver(manager, dir);
    await d.until(() => d.state.commands.length > 0, 60_000, "hello");
    manager.chatAction(d.id, {
      type: "prompt",
      text: "Write a very long essay (at least 3000 words) about the history of calculators. No code edits.",
    });
    await d.until(() => d.events.some((e) => e.type === "part-delta"), 120_000, "first delta");
    manager.chatAction(d.id, { type: "abort" });
    await d.until(() => !d.state.busy, 20_000, "interrupt");
    expect(manager.sessionInfo(d.id)?.status).toBe("running");

    await d.turn("/ls", 30_000);
    expect(JSON.stringify(d.state.messages.at(-1)?.parts)).toContain("calc.py");
    manager.stop(d.id);
  }, 240_000);
});
