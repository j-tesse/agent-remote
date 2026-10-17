#!/usr/bin/env node
// Scripted ACP (Agent Client Protocol) agent for acp.e2e.test.ts. Speaks
// newline-delimited JSON-RPC 2.0 on stdio like a real ACP agent (gemini
// --experimental-acp, goose acp, …), but deterministically: behaviour is keyed
// off the prompt's first word. No model, no endpoint, no tokens.
//
// Side files in process.cwd() (the adapter must spawn us in the session cwd):
//   .acp-fake-log.jsonl  — every message in/out, for wire-level assertions
//   .acp-fake-sessions.json — per-session turns, replayed by session/load
//
// Prompt scripts:
//   hello  → thought chunk + two message chunks → end_turn
//   edit   → tool_call(edit, diff) → session/request_permission → result per answer
//   slow   → message chunks every 50ms until session/cancel → cancelled
//   crash  → exit(3) mid-turn
//   *      → echo the prompt text back
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const LOG = join(process.cwd(), ".acp-fake-log.jsonl");
const STORE = join(process.cwd(), ".acp-fake-sessions.json");

const MODES = {
  currentModeId: "ask",
  availableModes: [
    { id: "ask", name: "Ask", description: "Request permission before edits" },
    { id: "code", name: "Code", description: "Edit without asking" },
  ],
};
const COMMANDS = [
  { name: "web", description: "Search the web", input: { hint: "query" } },
  { name: "plan", description: "Make a plan" },
];

const log = (dir, msg) => appendFileSync(LOG, JSON.stringify({ dir, msg }) + "\n");
const send = (msg) => {
  const full = { jsonrpc: "2.0", ...msg };
  log("out", full);
  process.stdout.write(JSON.stringify(full) + "\n");
};
const update = (sessionId, u) =>
  send({ method: "session/update", params: { sessionId, update: u } });
const text = (t) => ({ type: "text", text: t });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const load = () => (existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8")) : {});
const save = (s) => writeFileSync(STORE, JSON.stringify(s));

let nextId = 1000;
const pending = new Map(); // our outbound request id → resolve
const cancelled = new Set(); // sessionIds with a session/cancel since their prompt began

function request(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}

async function prompt(id, { sessionId, prompt: blocks }) {
  cancelled.delete(sessionId);
  const said = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
  const word = said.trim().split(/\s+/)[0]?.toLowerCase();
  let reply = "";
  const say = (t) => {
    reply += t;
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: text(t) });
  };
  const finish = (stopReason) => {
    const s = load();
    (s[sessionId] ??= []).push({ user: said, agent: reply });
    save(s);
    send({ id, result: { stopReason } });
  };

  if (word === "hello") {
    update(sessionId, {
      sessionUpdate: "agent_thought_chunk",
      content: text("The user greeted me."),
    });
    await sleep(10);
    say("Hello");
    await sleep(10);
    say(", world.");
    return finish("end_turn");
  }

  if (word === "edit") {
    const path = join(process.cwd(), "notes.txt");
    const toolCallId = "call-" + randomUUID().slice(0, 8);
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId,
      title: "Edit notes.txt",
      kind: "edit",
      status: "pending",
      locations: [{ path }],
      rawInput: { path, oldText: "old line", newText: "new line" },
      content: [{ type: "diff", path, oldText: "old line", newText: "new line" }],
    });
    const res = await request("session/request_permission", {
      sessionId,
      toolCall: { toolCallId, title: "Edit notes.txt", kind: "edit", status: "pending" },
      options: [
        { optionId: "allow-once", name: "Allow", kind: "allow_once" },
        { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    const outcome = res?.result?.outcome;
    if (outcome?.outcome === "cancelled" || cancelled.has(sessionId)) {
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
      return finish("cancelled");
    }
    if (outcome?.optionId?.startsWith("allow")) {
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" });
      await sleep(10);
      update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        content: [{ type: "content", content: text("Edited notes.txt") }],
      });
      say("Done.");
    } else {
      update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "failed",
        content: [{ type: "content", content: text("Rejected by user") }],
      });
      say("Okay, not editing.");
    }
    return finish("end_turn");
  }

  if (word === "slow") {
    for (let i = 0; i < 400 && !cancelled.has(sessionId); i++) {
      say("tick ");
      await sleep(50);
    }
    return finish(cancelled.has(sessionId) ? "cancelled" : "end_turn");
  }

  if (word === "crash") {
    say("about to crash");
    await sleep(20);
    process.exit(3);
  }

  const images = blocks.filter((b) => b.type === "image").length;
  say(images ? `Echo: ${said} [${images} image(s)]` : `Echo: ${said}`);
  return finish("end_turn");
}

function handle(msg) {
  // A response to one of our requests (permission).
  if (msg.id !== undefined && !msg.method) {
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
    return;
  }
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return send({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, audio: false, embeddedContext: false },
          },
          authMethods: [],
        },
      });
    case "session/new": {
      const sessionId = "sess-" + randomUUID();
      send({ id, result: { sessionId, modes: MODES } });
      setTimeout(() => update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: COMMANDS }), 5);
      return;
    }
    case "session/load": {
      const turns = load()[params.sessionId];
      if (!turns) return send({ id, error: { code: -32002, message: "Session not found" } });
      // Spec: history is replayed as session/update BEFORE the load response.
      for (const t of turns) {
        update(params.sessionId, { sessionUpdate: "user_message_chunk", content: text(t.user) });
        update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: text(t.agent) });
      }
      send({ id, result: { modes: MODES } });
      setTimeout(() => update(params.sessionId, { sessionUpdate: "available_commands_update", availableCommands: COMMANDS }), 5);
      return;
    }
    case "session/set_mode":
      send({ id, result: {} });
      return update(params.sessionId, { sessionUpdate: "current_mode_update", currentModeId: params.modeId });
    case "session/prompt":
      return void prompt(id, params);
    case "session/cancel": // notification
      cancelled.add(params.sessionId);
      return;
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    log("in", msg);
    handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0));
