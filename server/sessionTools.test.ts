import { describe, it, expect } from "vitest";
import {
  SpawnLimiter,
  childStatus,
  clampWaitSec,
  lastReply,
} from "./sessionTools.js";
import { emptyChatState } from "../shared/chat.js";
import type { ChatMessage, ChatState } from "../shared/protocol.js";

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
