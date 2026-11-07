import { describe, it, expect } from "vitest";
import {
  SpawnLimiter,
  childStatus,
  clampWaitSec,
  lastReply,
  overlayAssistant,
  ASSISTANT_PARAM,
  describeRequest,
  answerAction,
} from "./sessionTools.js";
import { zodParam } from "./adapters/claude.js";
import { SessionManager } from "./sessions/manager.js";
import { emptyChatState } from "../shared/chat.js";
import type { ChatMessage, ChatState, ChatUiRequest } from "../shared/protocol.js";

const msg = (role: ChatMessage["role"], text: string): ChatMessage => ({
  id: Math.random().toString(36),
  role,
  parts: [{ type: "text", text }],
  createdAt: 0,
});
const state = (over: Partial<ChatState>): ChatState => ({ ...emptyChatState(), ...over });
const running = { status: "running" as const };

describe("SpawnLimiter", () => {
  it("allows the limit per window, then reports when a slot frees", () => {
    const l = new SpawnLimiter(2, 1000);
    expect(l.take(0).ok).toBe(true);
    expect(l.take(100).ok).toBe(true);
    expect(l.take(200)).toEqual({ ok: false, retryMs: 800 });
    expect(l.take(1000).ok).toBe(true); // first stamp expired
    expect(l.take(1050).ok).toBe(false);
  });
});

describe("childStatus", () => {
  it("exited when the session is gone or exited", () => {
    expect(childStatus(undefined, undefined, 1)).toBe("exited");
    expect(childStatus(state({}), { status: "exited" }, 1)).toBe("exited");
  });

  it("running until the sent prompt is echoed and answered", () => {
    expect(childStatus(state({}), running, 1)).toBe("running");
    expect(childStatus(state({ messages: [msg("user", "hi")] }), running, 1)).toBe(
      "running",
    );
    expect(
      childStatus(state({ messages: [msg("user", "hi")], busy: true }), running, 1),
    ).toBe("running");
  });

  it("idle once the last turn is the assistant's and all prompts landed", () => {
    const s = state({ messages: [msg("user", "hi"), msg("assistant", "yo")] });
    expect(childStatus(s, running, 1)).toBe("idle");
    // A second prompt sent but not yet echoed.
    expect(childStatus(s, running, 2)).toBe("running");
  });

  it("system turns don't count as prompts", () => {
    const s = state({
      messages: [msg("user", "hi"), msg("assistant", "a"), msg("system", "note")],
    });
    expect(childStatus(s, running, 2)).toBe("running");
  });

  it("a pending card wins over idle/busy", () => {
    const s = state({
      busy: true,
      pendingRequests: [{ id: "r", kind: "select", title: "Allow Bash?" }],
    });
    expect(childStatus(s, running, 1)).toBe("waiting-for-input");
  });
});

describe("childStatus with AI-assistant work", () => {
  const idle = state({ messages: [msg("user", "hi"), msg("assistant", "done")] });

  it("an idle turn still runs while auto-PR/continuity work is in flight", () => {
    expect(childStatus(idle, running, 1, ["auto-pr"])).toBe("running");
    expect(childStatus(idle, running, 1, [])).toBe("idle");
  });

  it("a card the assistant is answering isn't waiting on a human", () => {
    const s = state({ pendingRequests: [{ id: "r", kind: "select", title: "Allow?" }] });
    expect(childStatus(s, running, 1, ["permissions"])).toBe("running");
    expect(childStatus(s, running, 1)).toBe("waiting-for-input");
  });

  it("exited still wins", () => {
    expect(childStatus(idle, { status: "exited" }, 1, ["auto-pr"])).toBe("exited");
  });
});

describe("SessionManager.holdAssistant", () => {
  it("ref-counts labels, notifies, and releases idempotently", () => {
    const m = new SessionManager(new Map());
    const seen: string[][] = [];
    m.subscribe({
      onStarted() {},
      onOutput() {},
      onExit() {},
      onAssistantWork: (_id, w) => seen.push([...w]),
    });
    const a = m.holdAssistant("s", "turn-router");
    const b = m.holdAssistant("s", "auto-pr");
    expect(m.assistantWork("s")).toEqual(["turn-router", "auto-pr"]);
    b();
    b();
    expect(m.assistantWork("s")).toEqual(["turn-router"]);
    a();
    expect(m.assistantWork("s")).toEqual([]);
    expect(seen).toEqual([["turn-router"], ["turn-router", "auto-pr"], ["turn-router"], []]);
  });
});

describe("lastReply", () => {
  it("joins every assistant turn after the latest prompt", () => {
    const s = state({
      messages: [
        msg("user", "q1"),
        msg("assistant", "old"),
        msg("user", "q2"),
        msg("assistant", "one"),
        msg("assistant", "two"),
      ],
    });
    expect(lastReply(s)).toBe("one\n\ntwo");
  });

  it("keeps the tail of a long reply", () => {
    const r = lastReply(state({ messages: [msg("assistant", "x".repeat(9000) + "END")] }));
    expect(r.startsWith("…")).toBe(true);
    expect(r.endsWith("END")).toBe(true);
    expect(r.length).toBe(8001);
  });
});

describe("clampWaitSec", () => {
  it("defaults and clamps", () => {
    expect(clampWaitSec(undefined)).toBe(120);
    expect(clampWaitSec(1)).toBe(5);
    expect(clampWaitSec(9999)).toBe(600);
    expect(clampWaitSec(30)).toBe(30);
  });
});

describe("overlayAssistant", () => {
  const base = () => {
    const a = emptyChatState().assistant;
    a.permissions.enabled = true;
    a.permissions.instructions = "allow everything";
    return a;
  };

  it("no overlay inherits the base verbatim", () => {
    expect(overlayAssistant(base(), undefined)).toEqual(base());
  });

  it("overlays only the given fields", () => {
    const out = overlayAssistant(base(), {
      autoPr: { enabled: true },
      continuity: { newSession: "never" },
    });
    expect(out.autoPr).toEqual({ ...base().autoPr, enabled: true });
    expect(out.continuity).toEqual({ ...base().continuity, newSession: "never" });
    expect(out.permissions).toEqual(base().permissions);
  });

  it("never mutates the base", () => {
    const b = base();
    overlayAssistant(b, { autoPr: { enabled: true }, permissions: { enabled: false } });
    expect(b).toEqual(base());
  });

  it("permissions can be disabled but never granted", () => {
    expect(overlayAssistant(base(), { permissions: { enabled: false } }).permissions.enabled).toBe(
      false,
    );
    expect(() => overlayAssistant(base(), { permissions: { enabled: true } })).toThrow(
      /only be disabled/,
    );
    expect(() =>
      overlayAssistant(base(), { permissions: { instructions: "allow everything" } }),
    ).toThrow(/Unknown/);
  });

  it("rejects malformed overlays", () => {
    expect(() => overlayAssistant(base(), "autoPr")).toThrow();
    expect(() => overlayAssistant(base(), { bogus: {} })).toThrow(/Unknown/);
    expect(() => overlayAssistant(base(), { autoPr: true })).toThrow(/object/);
    expect(() => overlayAssistant(base(), { autoPr: { enabled: "yes" } })).toThrow(/boolean/);
    expect(() => overlayAssistant(base(), { continuity: { newSession: "sometimes" } })).toThrow(
      /one of/,
    );
  });
});

describe("zodParam (nested host-tool params)", () => {
  const schema = zodParam(ASSISTANT_PARAM);
  it("accepts a valid overlay and omission", () => {
    expect(schema.safeParse({ autoPr: { enabled: true, autoMerge: false } }).success).toBe(true);
    expect(schema.safeParse(undefined).success).toBe(true);
  });
  it("rejects wrong types and unknown keys", () => {
    expect(schema.safeParse({ autoPr: { enabled: "yes" } }).success).toBe(false);
    expect(schema.safeParse({ autoPr: { bogus: 1 } }).success).toBe(false);
  });
  it("maps a `values` object to a string-keyed record", () => {
    const rec = zodParam({ type: "object", description: "m", values: { type: "string", description: "v" } });
    expect(rec.safeParse({ "Which db?": "Postgres" }).success).toBe(true);
    expect(rec.safeParse({ "Which db?": 3 }).success).toBe(false);
  });
});

describe("question cards for the spawning session", () => {
  const q: ChatUiRequest = {
    id: "r1",
    kind: "questions",
    title: "Question",
    questions: [
      { question: "Which db?", options: [{ label: "Postgres" }, { label: "SQLite" }] },
      { question: "Extras?", multiSelect: true, options: [{ label: "a" }, { label: "b" }] },
    ],
  };
  const perm: ChatUiRequest = {
    id: "r2",
    kind: "select",
    title: "Allow Bash?",
    options: [{ value: "allow", label: "Allow", intent: "accept" }],
    tool: { name: "Bash", args: { command: "x".repeat(5000) } },
  };

  it("describes a card with what's needed to answer it", () => {
    expect(describeRequest(q)).toEqual({
      requestId: "r1",
      kind: "questions",
      title: "Question",
      answerable: true,
      questions: [
        { question: "Which db?", options: ["Postgres", "SQLite"] },
        { question: "Extras?", multiSelect: true, options: ["a", "b"] },
      ],
    });
    const d = describeRequest(perm);
    expect(d.answerable).toBe(false);
    expect(d.tool).toBe("Bash");
    expect(d.toolArgs!.length).toBeLessThan(2100); // truncated
  });

  it("builds the ui-response for a fully answered questions card", () => {
    expect(answerAction(q, { answers: { "Which db?": "SQLite", "Extras?": " a, b " } })).toEqual({
      type: "ui-response",
      requestId: "r1",
      answers: { "Which db?": "SQLite", "Extras?": "a, b" },
    });
  });

  it("rejects missing, unknown or malformed answers", () => {
    expect(() => answerAction(q, { answers: { "Which db?": "SQLite" } })).toThrow(/Missing answer/);
    expect(() =>
      answerAction(q, { answers: { "Which db?": "x", "Extras?": "a", Nope: "y" } }),
    ).toThrow(/Unknown question/);
    expect(() => answerAction(q, {})).toThrow(/answers/);
  });

  it("answers input cards with text", () => {
    const input: ChatUiRequest = { id: "r3", kind: "input", title: "Name?" };
    expect(answerAction(input, { text: "bob" })).toEqual({ type: "ui-response", requestId: "r3", value: "bob" });
    expect(() => answerAction(input, {})).toThrow(/text/);
  });

  it("never answers permission or plan cards", () => {
    expect(() => answerAction(perm, { text: "allow" })).toThrow(/needs the user/);
    expect(() => answerAction({ id: "p", kind: "plan", title: "Plan" }, {})).toThrow(/needs the user/);
  });
});
