// Scheduled prompts (long-press Send → Schedule): the manager holds them until
// the turn ends and sends one before any turn-end listener sees a settled
// session. Fake in-process ChatSession — no subprocess, no tokens.
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { SessionManager } from "./manager.js";
import { shouldRouteTurn } from "../turnRouter.js";
import { shouldSuggest } from "../suggestions.js";
import { childStatus } from "../sessionTools.js";
import type { ChatSession, HarnessAdapter } from "../adapters/types.js";
import type { ChatAction, ChatEvent, ChatState } from "../../shared/protocol.js";

function harness() {
  let emit: (e: ChatEvent) => void = () => {};
  const actions: ChatAction[] = [];
  let n = 0;
  const session: ChatSession = {
    start(h) {
      emit = h.onEvent;
    },
    action(a) {
      actions.push(a);
      if (a.type === "prompt")
        emit({
          type: "user-message",
          message: {
            id: `u${++n}`,
            role: "user",
            parts: [{ type: "text", text: a.text }],
            createdAt: Date.now(),
          },
        });
    },
    close() {},
  };
  const adapters = new Map<string, HarnessAdapter>([
    [
      "fake",
      {
        id: "fake",
        name: "Fake",
        invocation: () => ({ command: "true", args: [] }),
        createChatSession: () => session,
      } as HarnessAdapter,
    ],
  ]);
  const manager = new SessionManager(adapters);
  const id = manager.start("fake", { cwd: tmpdir() }).id;
  const reply = (text: string) => {
    emit({ type: "busy", busy: true });
    emit({ type: "assistant-start", messageId: `a${Math.random()}` });
    emit({ type: "part-start", kind: "text" });
    emit({ type: "part-delta", kind: "text", delta: text });
    emit({ type: "assistant-end" });
  };
  const prompts = () =>
    actions.flatMap((a) => (a.type === "prompt" ? [a.text] : []));
  return { manager, id, emit: (e: ChatEvent) => emit(e), reply, prompts, actions };
}

describe("scheduled prompts", () => {
  it("sends at once when idle", () => {
    const h = harness();
    h.manager.chatAction(h.id, { type: "schedule-prompt", text: "hi" });
    expect(h.prompts()).toEqual(["hi"]);
    expect(h.manager.chatState(h.id)!.scheduled).toEqual([]);
  });

  it("holds while busy and sends when the turn ends", () => {
    const h = harness();
    h.manager.chatAction(h.id, { type: "prompt", text: "first" });
    h.reply("working");
    h.manager.chatAction(h.id, { type: "schedule-prompt", text: "next" });
    expect(h.prompts()).toEqual(["first"]);
    expect(h.manager.chatState(h.id)!.scheduled.map((s) => s.text)).toEqual(["next"]);
    h.emit({ type: "busy", busy: false });
    expect(h.prompts()).toEqual(["first", "next"]);
    expect(h.manager.chatState(h.id)!.scheduled).toEqual([]);
  });

  it("settle listeners see the session as not settled at the turn end", () => {
    const h = harness();
    h.manager.chatAction(h.id, {
      type: "set-assistant",
      settings: {
        ...h.manager.chatState(h.id)!.assistant,
        autoPr: { enabled: true, instructions: "", autoMerge: false },
      },
    });
    h.manager.chatAction(h.id, { type: "prompt", text: "first" });
    h.reply("working");
    h.manager.chatAction(h.id, { type: "schedule-prompt", text: "next" });
    const seen: ChatState[] = [];
    h.manager.subscribe({
      onStarted() {},
      onOutput() {},
      onExit() {},
      onChatEvent(sid, e) {
        if (e.type === "busy" && !e.busy) seen.push(h.manager.chatState(sid)!);
      },
    });
    h.emit({ type: "busy", busy: false });
    const [atEnd] = seen;
    expect(shouldRouteTurn(atEnd)).toBe(false);
    expect(shouldSuggest(atEnd)).toBe(false);
    expect(childStatus(atEnd, { status: "running" }, 1)).toBe("running");
    // …and right after delivery the new prompt keeps it running.
    expect(
      childStatus(h.manager.chatState(h.id), { status: "running" }, 1),
    ).toBe("running");
  });

  it("sends one per turn, ignoring a repeated busy:false before the next turn starts", () => {
    const h = harness();
    h.manager.chatAction(h.id, { type: "prompt", text: "first" });
    h.reply("working");
    h.manager.chatAction(h.id, { type: "schedule-prompt", text: "a" });
    h.manager.chatAction(h.id, { type: "schedule-prompt", text: "b" });
    h.emit({ type: "busy", busy: false });
    expect(h.prompts()).toEqual(["first", "a"]);
    // pi settles twice (agent_end, then agent_settled).
    h.emit({ type: "busy", busy: false });
    expect(h.prompts()).toEqual(["first", "a"]);
    h.reply("did a");
    h.emit({ type: "busy", busy: false });
    expect(h.prompts()).toEqual(["first", "a", "b"]);
  });

  it("doesn't clear the draft being typed when it delivers", () => {
    const h = harness();
    h.manager.chatAction(h.id, { type: "prompt", text: "first" });
    h.reply("working");
    h.manager.chatAction(h.id, { type: "schedule-prompt", text: "next" });
    h.manager.chatAction(h.id, { type: "set-draft", text: "half-typed" });
    h.emit({ type: "busy", busy: false });
    expect(h.manager.chatState(h.id)!.draft).toBe("half-typed");
  });

  it("cancel withdraws it", () => {
    const h = harness();
    h.manager.chatAction(h.id, { type: "prompt", text: "first" });
    h.reply("working");
    h.manager.chatAction(h.id, { type: "schedule-prompt", text: "next" });
    const [s] = h.manager.chatState(h.id)!.scheduled;
    h.manager.chatAction(h.id, { type: "cancel-scheduled", id: s.id });
    h.emit({ type: "busy", busy: false });
    expect(h.prompts()).toEqual(["first"]);
  });

  it("abort returns scheduled text to the composer instead of sending it", () => {
    const h = harness();
    h.manager.chatAction(h.id, { type: "prompt", text: "first" });
    h.reply("working");
    h.manager.chatAction(h.id, { type: "schedule-prompt", text: "next" });
    h.manager.chatAction(h.id, { type: "abort" });
    h.emit({ type: "busy", busy: false });
    expect(h.prompts()).toEqual(["first"]);
    const state = h.manager.chatState(h.id)!;
    expect(state.scheduled).toEqual([]);
    expect(state.draft).toBe("next");
  });

  it("keeps resolved image bytes out of ChatState but sends them", () => {
    const h = harness();
    h.manager.chatAction(h.id, { type: "prompt", text: "first" });
    h.reply("working");
    const img = { id: "i1", mediaType: "image/png", name: "x.png", data: "AAAA" };
    h.manager.chatAction(h.id, { type: "schedule-prompt", text: "look", images: [img] });
    expect(h.manager.chatState(h.id)!.scheduled[0].images).toEqual([
      { id: "i1", mediaType: "image/png", name: "x.png" },
    ]);
    h.emit({ type: "busy", busy: false });
    expect(h.actions.at(-1)).toMatchObject({ type: "prompt", images: [img] });
  });
});
