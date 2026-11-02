import { describe, it, expect } from "vitest";
import {
  ALLOW_EVERYTHING,
  applyChatEvent,
  assistantNeedsLlm,
  autoActionDelayMs,
  AUTO_DELAY_MAX_SCALE,
  deriveAssistantEnabled,
  emptyChatState,
  isAllowEverything,
  isEmptyChat,
  promptParts,
} from "./chat.js";
import type { AssistantSettings, ChatEvent, ChatState } from "./protocol.js";

// Fold a list of events over an initial state — how the reducer is used for real
// (server replay + live client updates), so tests read as a script of events.
function reduce(events: ChatEvent[], initial: ChatState = emptyChatState()) {
  return events.reduce(applyChatEvent, initial);
}

describe("applyChatEvent", () => {
  it("streams an assistant turn into a finished message", () => {
    const state = reduce([
      { type: "assistant-start", messageId: "m1" },
      { type: "part-start", kind: "text" },
      { type: "part-delta", kind: "text", delta: "Hello" },
      { type: "part-delta", kind: "text", delta: ", world" },
      { type: "assistant-end" },
    ]);
    expect(state.streaming).toBeNull();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      id: "m1",
      role: "assistant",
      parts: [{ type: "text", text: "Hello, world" }],
    });
  });

  it("echoes a user message into history", () => {
    const state = reduce([
      {
        type: "user-message",
        message: {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "hi" }],
          createdAt: 0,
        },
      },
    ]);
    expect(state.messages).toEqual([
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }], createdAt: 0 },
    ]);
  });

  it("drops a content-less thinking part once the next part starts", () => {
    // claude emits an empty thinking part as a live 'Thinking…' indicator; it
    // carries nothing by the time real content arrives, so it's stripped.
    const state = reduce([
      { type: "assistant-start", messageId: "m1" },
      { type: "part-start", kind: "thinking" }, // never gets a delta
      { type: "part-start", kind: "text" },
      { type: "part-delta", kind: "text", delta: "answer" },
      { type: "assistant-end" },
    ]);
    expect(state.messages[0].parts).toEqual([{ type: "text", text: "answer" }]);
  });

  it("appends no message when a turn finalizes with only an empty thinking part", () => {
    // An assistant turn that reduces to nothing must not leave a blank bubble.
    const state = reduce([
      { type: "assistant-start", messageId: "m1" },
      { type: "part-start", kind: "thinking" }, // never gets a delta
      { type: "assistant-end" },
    ]);
    expect(state.streaming).toBeNull();
    expect(state.messages).toEqual([]);
  });

  it("drops an empty text part and appends no message when it's the only one", () => {
    const state = reduce([
      { type: "assistant-start", messageId: "m1" },
      { type: "part-start", kind: "text" },
      { type: "part-delta", kind: "text", delta: "   " },
      { type: "assistant-end" },
    ]);
    expect(state.messages).toEqual([]);
  });

  it("still finalizes a turn with real text (guard against over-dropping)", () => {
    const state = reduce([
      { type: "assistant-start", messageId: "m1" },
      { type: "part-start", kind: "thinking" }, // empty, dropped
      { type: "part-start", kind: "text" },
      { type: "part-delta", kind: "text", delta: "hi" },
      { type: "assistant-end" },
    ]);
    expect(state.messages[0].parts).toEqual([{ type: "text", text: "hi" }]);
  });

  it("appends no message when an idle flush leaves only empty parts", () => {
    const state = reduce([
      { type: "assistant-start", messageId: "m1" },
      { type: "part-start", kind: "thinking" },
      { type: "busy", busy: false },
    ]);
    expect(state.streaming).toBeNull();
    expect(state.messages).toEqual([]);
  });

  it("keeps a thinking part that has text (pi streams reasoning)", () => {
    const state = reduce([
      { type: "assistant-start", messageId: "m1" },
      { type: "part-start", kind: "thinking" },
      { type: "part-delta", kind: "thinking", delta: "let me think" },
      { type: "assistant-end" },
    ]);
    expect(state.messages[0].parts).toEqual([
      { type: "thinking", text: "let me think" },
    ]);
  });

  it("routes a late thinking delta to the thinking part, not the open text part", () => {
    // Regression: a provider chunk that straddles </think> arrives carrying
    // both fields at once — {reasoning: ".\n", content: "\n\nPR"} — and pi
    // reads `content` first, so the thinking delta lands *after* text_start.
    // Appending by position spliced the reasoning tail into the answer and
    // rendered "PR.\n is mergeable" instead of "PR is mergeable".
    const state = reduce([
      { type: "assistant-start", messageId: "m1" },
      { type: "part-start", kind: "thinking" },
      { type: "part-delta", kind: "thinking", delta: "merge it anyway" },
      { type: "part-start", kind: "text" },
      { type: "part-delta", kind: "text", delta: "\n\nPR" },
      { type: "part-delta", kind: "thinking", delta: ".\n" },
      { type: "part-delta", kind: "text", delta: " is mergeable and clean." },
      { type: "assistant-end" },
    ]);
    expect(state.messages[0].parts).toEqual([
      { type: "thinking", text: "merge it anyway.\n" },
      { type: "text", text: "\n\nPR is mergeable and clean." },
    ]);
  });

  it("starts a part for a delta whose kind was never opened", () => {
    // Defensive: a harness that skips part-start must not lose the text.
    const state = reduce([
      { type: "assistant-start", messageId: "m1" },
      { type: "part-delta", kind: "text", delta: "no start event" },
      { type: "assistant-end" },
    ]);
    expect(state.messages[0].parts).toEqual([
      { type: "text", text: "no start event" },
    ]);
  });

  it("flushes a half-streamed message when going idle (abort safety)", () => {
    // An abort can skip assistant-end; busy:false must not lose the partial turn.
    const state = reduce([
      { type: "assistant-start", messageId: "m1" },
      { type: "part-start", kind: "text" },
      { type: "part-delta", kind: "text", delta: "partial" },
      { type: "busy", busy: false },
    ]);
    expect(state.streaming).toBeNull();
    expect(state.busy).toBe(false);
    expect(state.messages[0].parts).toEqual([{ type: "text", text: "partial" }]);
  });

  it("attaches tool output and status via tool-end", () => {
    const state = reduce([
      { type: "assistant-start", messageId: "m1" },
      { type: "tool-call", toolId: "t1", name: "Bash", args: { command: "ls" } },
      { type: "assistant-end" },
      { type: "tool-end", toolId: "t1", output: "file.txt", isError: false },
    ]);
    const part = state.messages[0].parts[0];
    expect(part).toMatchObject({
      type: "tool",
      toolId: "t1",
      output: "file.txt",
      status: "done",
    });
  });

  it("marks an errored tool result", () => {
    const state = reduce([
      { type: "assistant-start", messageId: "m1" },
      { type: "tool-call", toolId: "t1", name: "Bash", args: { command: "boom" } },
      { type: "assistant-end" },
      { type: "tool-end", toolId: "t1", output: "nope", isError: true },
    ]);
    expect(state.messages[0].parts[0]).toMatchObject({ status: "error" });
  });

  it("caps tool output at 20k characters (keeps the tail)", () => {
    const big = "x".repeat(25_000);
    const state = reduce([
      { type: "assistant-start", messageId: "m1" },
      { type: "tool-call", toolId: "t1", name: "Bash", args: {} },
      { type: "assistant-end" },
      { type: "tool-end", toolId: "t1", output: big, isError: false },
    ]);
    const part = state.messages[0].parts[0] as { output: string };
    expect(part.output).toHaveLength(20_000);
    expect(part.output.endsWith("x")).toBe(true);
  });

  it("caps notices at 20 (keeps the most recent)", () => {
    const events: ChatEvent[] = Array.from({ length: 25 }, (_, i) => ({
      type: "notice",
      level: "info",
      text: `notice ${i}`,
    }));
    const state = reduce(events);
    expect(state.notices).toHaveLength(20);
    expect(state.notices[state.notices.length - 1].text).toBe("notice 24");
  });

  it("anchors a notice to the turn it arrived during", () => {
    const state = reduce([
      {
        type: "user-message",
        message: {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "hi" }],
          createdAt: 0,
        },
      },
      { type: "notice", level: "info", text: "early" },
      { type: "assistant-start", messageId: "a1" },
      { type: "notice", level: "info", text: "mid-turn" },
      { type: "assistant-end" },
    ]);
    // Not pinned to the end: each keeps the place it happened, so later turns
    // render below it.
    expect(state.notices.map((n) => n.anchorMessageId)).toEqual(["u1", "a1"]);
  });

  it("leaves a notice that predates every message unanchored", () => {
    const state = reduce([{ type: "notice", level: "error", text: "boom" }]);
    expect(state.notices[0].anchorMessageId).toBeUndefined();
  });

  it("rewind drops notices about dropped turns, keeps unanchored ones", () => {
    const state = reduce([
      { type: "notice", level: "info", text: "at startup" },
      {
        type: "user-message",
        message: {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "one" }],
          createdAt: 0,
        },
      },
      { type: "assistant-start", messageId: "a1" },
      { type: "assistant-end" },
      {
        type: "user-message",
        message: {
          id: "u2",
          role: "user",
          parts: [{ type: "text", text: "two" }],
          createdAt: 0,
        },
      },
      { type: "notice", level: "info", text: "about u2" },
      { type: "rewind", messageId: "u2" },
    ]);
    expect(state.notices.map((n) => n.text)).toEqual(["at startup"]);
  });

  it("adds, de-duplicates, and clears ui-requests", () => {
    const req = {
      id: "r1",
      kind: "confirm" as const,
      title: "Allow?",
    };
    let state = reduce([
      { type: "ui-request", request: req },
      { type: "ui-request", request: { ...req, title: "Allow? (again)" } },
    ]);
    // Same id → replaced, not duplicated.
    expect(state.pendingRequests).toHaveLength(1);
    expect(state.pendingRequests[0].title).toBe("Allow? (again)");

    state = applyChatEvent(state, { type: "ui-request-done", requestId: "r1" });
    expect(state.pendingRequests).toEqual([]);
  });

  it("tracks model and mode selection", () => {
    const state = reduce([
      {
        type: "models",
        models: [{ id: "opus", label: "Opus" }],
        current: "opus",
      },
      { type: "model-changed", current: "sonnet" },
    ]);
    expect(state.models).toEqual([{ id: "opus", label: "Opus" }]);
    expect(state.currentModel).toBe("sonnet");
  });

  it("replaces model display names and keeps them across a re-sent catalog", () => {
    const models = [{ id: "vllm/a", label: "Org/a-it-NVFP4" }];
    const state = reduce([
      { type: "models", models, current: null },
      { type: "model-names", names: { "vllm/a": "A", "vllm/b": "B" } },
      { type: "model-names", names: { "vllm/a": "A (FP8)" } },
      { type: "models", models, current: "vllm/a" },
    ]);
    expect(state.modelNames).toEqual({ "vllm/a": "A (FP8)" });
  });

  it("anchors an AI-mode trace to the streaming turn, surviving finalization", () => {
    // Trace fires mid-turn (while the assistant message with the tool is
    // streaming); it must anchor to that message id and keep it after the turn
    // finalizes — so the UI renders it inline beside that turn in both phases.
    let state = reduce([
      { type: "assistant-start", messageId: "m1" },
      { type: "tool-call", toolId: "t1", name: "Edit", args: {} },
      {
        type: "assistant-trace",
        trace: {
          requestId: "r1",
          kind: "select",
          prompt: "SYSTEM:\n…\n\nUSER:\n…",
          response: '{"allow":true}',
          outcome: "allow",
          summary: "Allowed",
          at: 123,
        },
      },
    ]);
    expect(state.assistantTraces).toHaveLength(1);
    expect(state.assistantTraces[0].anchorMessageId).toBe("m1");
    // Finalize the turn: the message keeps id m1, so the anchor still matches.
    state = applyChatEvent(state, { type: "assistant-end" });
    state = applyChatEvent(state, {
      type: "tool-end",
      toolId: "t1",
      output: "ok",
      isError: false,
    });
    expect(state.messages[0].id).toBe("m1");
    expect(state.assistantTraces[0].anchorMessageId).toBe("m1");
  });

  it("updates a live AI-mode note in place (same slot, anchor and time)", () => {
    const note = (summary: string, at: number, update?: boolean) => ({
      type: "assistant-trace" as const,
      trace: {
        requestId: "auto-pr:checks",
        kind: "auto-pr" as const,
        outcome: "note" as const,
        summary,
        at,
        update,
        checks: [{ name: "build", bucket: summary === "done" ? "pass" : "pending", state: "" }],
      },
    });
    let state = reduce([
      { type: "user-message", message: { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] } },
      note("waiting", 10, true),
      {
        type: "assistant-trace",
        trace: { requestId: "other", kind: "auto-pr", outcome: "note", summary: "x", at: 11 },
      },
      { type: "user-message", message: { id: "u2", role: "user", parts: [{ type: "text", text: "more" }] } },
    ]);
    state = applyChatEvent(state, note("done", 20, true));
    expect(state.assistantTraces.map((t) => t.summary)).toEqual(["done", "x"]);
    const live = state.assistantTraces[0];
    expect(live.at).toBe(10);
    expect(live.anchorMessageId).toBe("u1");
    expect(live.checks?.[0].bucket).toBe("pass");
  });

  it("appends a same-id trace that doesn't ask to update", () => {
    const t = (summary: string) => ({
      type: "assistant-trace" as const,
      trace: { requestId: "r", kind: "select" as const, outcome: "allow" as const, summary, at: 1 },
    });
    expect(reduce([t("a"), t("b")]).assistantTraces).toHaveLength(2);
  });

  it("caps AI-mode traces at 20 (keeps the most recent)", () => {
    const events: ChatEvent[] = Array.from({ length: 25 }, (_, i) => ({
      type: "assistant-trace",
      trace: {
        requestId: `r${i}`,
        kind: "confirm",
        prompt: "p",
        response: "x",
        outcome: "allow",
        summary: `s${i}`,
        at: i,
      },
    }));
    const state = reduce(events);
    expect(state.assistantTraces).toHaveLength(20);
    expect(state.assistantTraces[state.assistantTraces.length - 1].summary).toBe(
      "s24",
    );
  });

  it("folds a usage snapshot into ChatState.usage (replacing any prior)", () => {
    const first = reduce([
      {
        type: "usage",
        usage: {
          available: false,
          subscriptionType: null,
          windows: [],
          sessionCostUsd: 0.5,
          at: 1,
        },
      },
    ]);
    expect(first.usage?.available).toBe(false);
    expect(first.usage?.sessionCostUsd).toBe(0.5);

    // A newer snapshot replaces the old one wholesale.
    const second = applyChatEvent(first, {
      type: "usage",
      usage: {
        available: true,
        subscriptionType: "max",
        windows: [
          { key: "seven_day", label: "Week — all models", utilization: 16, resetsAt: "2026-07-31T15:59:00Z" },
        ],
        sessionCostUsd: 1.25,
        at: 2,
      },
    });
    expect(second.usage?.available).toBe(true);
    expect(second.usage?.subscriptionType).toBe("max");
    expect(second.usage?.windows).toHaveLength(1);
    expect(second.usage?.windows[0].utilization).toBe(16);
  });

  it("folds next-prompt suggestions and clears them on the next prompt", () => {
    // A prompt_suggestion arrives after a turn → held for the composer hints.
    const withSuggestion = reduce([
      {
        type: "prompt-suggestion",
        suggestions: ["Add a test for that", "Refactor the helper"],
      },
    ]);
    expect(withSuggestion.promptSuggestions).toEqual([
      "Add a test for that",
      "Refactor the helper",
    ]);

    // Sending a new prompt makes the prior suggestions stale — drop them.
    const afterPrompt = applyChatEvent(withSuggestion, {
      type: "user-message",
      message: {
        id: "u9",
        role: "user",
        parts: [{ type: "text", text: "different idea" }],
        createdAt: 0,
      },
    });
    expect(afterPrompt.promptSuggestions).toEqual([]);
  });

  it("starts with no prompt suggestions", () => {
    expect(emptyChatState().promptSuggestions).toEqual([]);
  });

  it("folds the unsent composer draft, and keeps it across a rewind", () => {
    const state = reduce([
      {
        type: "user-message",
        message: {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "first" }],
          createdAt: 0,
        },
      },
      { type: "draft", text: "half-written th" },
    ]);
    expect(state.draft).toBe("half-written th");
    // A rewind prefills the composer, so it must not wipe the stored draft.
    const rewound = applyChatEvent(state, {
      type: "rewind",
      messageId: state.messages[0].id,
    });
    expect(rewound.draft).toBe("half-written th");
    expect(applyChatEvent(rewound, { type: "draft", text: "" }).draft).toBe("");
  });

  it("returns the same state when the draft is unchanged", () => {
    const state = reduce([{ type: "draft", text: "x" }]);
    expect(applyChatEvent(state, { type: "draft", text: "x" })).toBe(state);
  });

  it("leaves state untouched for an unknown/newer event (deploy-skew safety)", () => {
    const before = reduce([{ type: "busy", busy: true }]);
    // Simulate a server ahead of this client emitting an event type it doesn't
    // know: the reducer must return the same state, never undefined.
    const after = applyChatEvent(before, {
      type: "some-future-event",
    } as unknown as ChatEvent);
    expect(after).toBe(before);
  });

  it("ignores stream events with no active streaming message", () => {
    // part-delta / tool-call before assistant-start are no-ops, not throws.
    const before = emptyChatState();
    const after = reduce([
      { type: "part-delta", kind: "text", delta: "orphan" },
      { type: "tool-call", toolId: "t1", name: "X" },
    ]);
    expect(after).toEqual(before);
  });
});

describe("promptParts", () => {
  it("returns a single text part when there are no images", () => {
    expect(promptParts("hi")).toEqual([{ type: "text", text: "hi" }]);
  });

  it("appends an image part per attached image with the serve url", () => {
    const parts = promptParts("look", [
      { id: "a", mediaType: "image/png", name: "shot.png" },
    ]);
    expect(parts).toEqual([
      { type: "text", text: "look" },
      {
        type: "image",
        id: "a",
        mediaType: "image/png",
        name: "shot.png",
        url: "/api/upload/a",
      },
    ]);
  });

  it("omits the text part for an image-only prompt", () => {
    const parts = promptParts("", [{ id: "b", mediaType: "image/jpeg" }]);
    expect(parts).toEqual([
      {
        type: "image",
        id: "b",
        mediaType: "image/jpeg",
        name: undefined,
        url: "/api/upload/b",
      },
    ]);
  });
});

describe("applyChatEvent user image message", () => {
  it("stores image parts on a user message verbatim", () => {
    const state = reduce([
      {
        type: "user-message",
        message: {
          id: "u1",
          role: "user",
          parts: promptParts("hi", [{ id: "a", mediaType: "image/png" }]),
          createdAt: 0,
        },
      },
    ]);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].parts).toContainEqual({
      type: "image",
      id: "a",
      mediaType: "image/png",
      name: undefined,
      url: "/api/upload/a",
    });
  });
});

describe("applyChatEvent rewind", () => {
  const user = (id: string, text: string): ChatEvent => ({
    type: "user-message",
    message: { id, role: "user", parts: [{ type: "text", text }], createdAt: 0 },
  });
  const turn = (id: string, text: string): ChatEvent[] => [
    { type: "assistant-start", messageId: id },
    { type: "part-start", kind: "text" },
    { type: "part-delta", kind: "text", delta: text },
    { type: "assistant-end" },
  ];
  // Two full exchanges: u1/a1 then u2/a2.
  const conversation = (): ChatState =>
    reduce([user("u1", "first"), ...turn("a1", "ok"), user("u2", "second"), ...turn("a2", "done")]);

  it("drops the target user message and everything after it", () => {
    const state = reduce([{ type: "rewind", messageId: "u2" }], conversation());
    expect(state.messages.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  it("clears in-flight state so the session is idle afterwards", () => {
    const before = reduce(
      [
        user("u1", "first"),
        user("u2", "second"),
        { type: "busy", busy: true },
        { type: "assistant-start", messageId: "a2" },
        { type: "part-start", kind: "text" },
        { type: "part-delta", kind: "text", delta: "half…" },
        { type: "queue", queued: ["later"] },
        {
          type: "ui-request",
          request: { id: "r1", kind: "confirm", title: "Run it?" },
        },
        { type: "prompt-suggestion", suggestions: ["next?"] },
        {
          type: "assistant-decision",
          decision: { requestId: "r1", action: "confirm", delayMs: 2000 },
        },
        {
          type: "auto-prompt",
          prompt: { id: "p1", text: "carry on", delayMs: 8000, at: 0 },
        },
      ],
    );
    expect(before.streaming).not.toBeNull();

    const state = applyChatEvent(before, { type: "rewind", messageId: "u2" });
    expect(state.messages.map((m) => m.id)).toEqual(["u1"]);
    expect(state.streaming).toBeNull();
    expect(state.busy).toBe(false);
    expect(state.queued).toEqual([]);
    expect(state.pendingRequests).toEqual([]);
    expect(state.promptSuggestions).toEqual([]);
    expect(state.autoDecisions).toEqual({});
    expect(state.autoPrompt).toBeNull();
    expect(state.rewindPreview).toBeNull();
  });

  it("prunes traces anchored to dropped turns but keeps the rest", () => {
    const trace = {
      requestId: "",
      kind: "confirm" as const,
      prompt: "p",
      response: "r",
      outcome: "allow" as const,
      summary: "",
      at: 0,
    };
    const before = reduce(
      [
        {
          type: "assistant-trace",
          trace: { ...trace, requestId: "r1", summary: "kept", anchorMessageId: "a1" },
        },
        {
          type: "assistant-trace",
          trace: { ...trace, requestId: "r2", summary: "dropped", anchorMessageId: "a2" },
        },
        // An AI-mode note (no LLM detail) prunes on the same rule.
        {
          type: "assistant-trace",
          trace: {
            requestId: "auto-pr:1",
            kind: "auto-pr",
            outcome: "note",
            summary: "dropped note",
            at: 0,
            anchorMessageId: "a2",
          },
        },
      ],
      conversation(),
    );
    const state = applyChatEvent(before, { type: "rewind", messageId: "u2" });
    expect(state.assistantTraces.map((t) => t.summary)).toEqual(["kept"]);
  });

  it("keeps session-level state (models, modes, commands, capabilities)", () => {
    const before = reduce(
      [
        { type: "models", models: [{ id: "opus", name: "Opus" }], current: "opus" },
        { type: "commands", commands: [{ name: "compact" }] },
        { type: "capabilities", capabilities: { rewind: true, rewindFiles: true } },
      ],
      conversation(),
    );
    const state = applyChatEvent(before, { type: "rewind", messageId: "u2" });
    expect(state.currentModel).toBe("opus");
    expect(state.commands).toHaveLength(1);
    expect(state.capabilities).toEqual({ rewind: true, rewindFiles: true });
  });

  it("ignores a rewind to an unknown message", () => {
    const before = conversation();
    expect(applyChatEvent(before, { type: "rewind", messageId: "nope" })).toBe(before);
  });

  it("folds capabilities and rewind previews", () => {
    const state = reduce([
      { type: "capabilities", capabilities: { rewind: true } },
      {
        type: "rewind-preview",
        preview: { messageId: "u2", canRewind: true, filesChanged: ["a.ts"], insertions: 3, deletions: 1 },
      },
    ]);
    expect(state.capabilities).toEqual({ rewind: true });
    expect(state.rewindPreview).toMatchObject({ messageId: "u2", canRewind: true });
    expect(applyChatEvent(state, { type: "rewind-preview", preview: null }).rewindPreview).toBeNull();
  });
});

describe("applyChatEvent system turns", () => {
  const systemTurn = (text: string): ChatEvent => ({
    type: "user-message",
    message: { id: `s-${text}`, role: "system", parts: [{ type: "text", text }], createdAt: 0 },
  });

  it("appends to the transcript like any other turn", () => {
    const state = reduce([systemTurn("background task finished")]);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe("system");
  });

  it("does not consume an armed auto-prompt or clear suggestions", () => {
    // A notification arriving mid-countdown is not the developer replying: it
    // must not cancel Continuity Mode's armed prompt.
    const before = reduce([
      { type: "prompt-suggestion", suggestions: ["carry on?"] },
      { type: "auto-prompt", prompt: { id: "p1", text: "next", delayMs: 8000, at: 0 } },
    ]);
    const after = applyChatEvent(before, systemTurn("task done"));
    expect(after.autoPrompt).toMatchObject({ id: "p1" });
    expect(after.promptSuggestions).toEqual(["carry on?"]);

    // A real prompt still spends both.
    const sent = applyChatEvent(before, {
      type: "user-message",
      message: { id: "u1", role: "user", parts: [{ type: "text", text: "go" }], createdAt: 0 },
    });
    expect(sent.autoPrompt).toBeNull();
    expect(sent.promptSuggestions).toEqual([]);
  });
});

describe("applyChatEvent sub-agents", () => {
  // A main turn that calls the Agent tool with id `t`.
  const spawn = (t: string): ChatEvent[] => [
    { type: "assistant-start", messageId: "a1" },
    { type: "tool-call", toolId: t, name: "Agent", args: { subagent_type: "Explore" } },
    { type: "assistant-end" },
  ];
  // One nested assistant turn inside agent `t`.
  const nested = (t: string, id: string, text: string): ChatEvent[] =>
    [
      { type: "assistant-start", messageId: id },
      { type: "part-start", kind: "text" },
      { type: "part-delta", kind: "text", delta: text },
      { type: "assistant-end" },
    ].map((event) => ({ type: "agent-event", toolId: t, event }) as ChatEvent);

  it("folds nested events into the run's own transcript, not the root", () => {
    const state = reduce([
      ...spawn("t1"),
      { type: "agent-start", toolId: "t1", agentType: "Explore", description: "look" },
      ...nested("t1", "n1", "found it"),
    ]);
    expect(state.messages.map((m) => m.id)).toEqual(["a1"]);
    const run = state.agents.t1;
    expect(run).toMatchObject({ toolId: "t1", agentType: "Explore", description: "look" });
    expect(run.state.messages).toHaveLength(1);
    expect(run.state.messages[0].parts).toEqual([{ type: "text", text: "found it" }]);
    // Nested state never grows its own agents map — the root map is flat.
    expect(run.state.agents).toEqual({});
  });

  it("creates a run on demand when a nested event arrives before any start", () => {
    const state = reduce([...spawn("t1"), ...nested("t1", "n1", "hi")]);
    expect(state.agents.t1.state.messages).toHaveLength(1);
  });

  it("keeps an existing transcript when agent-start repeats, but fills metadata", () => {
    const state = reduce([
      ...spawn("t1"),
      { type: "agent-start", toolId: "t1" },
      ...nested("t1", "n1", "hi"),
      { type: "agent-start", toolId: "t1", agentType: "Explore", loading: true },
    ]);
    expect(state.agents.t1.state.messages).toHaveLength(1);
    expect(state.agents.t1.agentType).toBe("Explore");
    expect(state.agents.t1.loading).toBe(true);
  });

  it("appends the final report as the last nested bubble, and clears loading", () => {
    const state = reduce([
      ...spawn("t1"),
      { type: "agent-start", toolId: "t1", loading: true },
      ...nested("t1", "n1", "working…"),
      { type: "agent-done", toolId: "t1", report: "the answer" },
    ]);
    const msgs = state.agents.t1.state.messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toMatchObject({ role: "assistant", parts: [{ type: "text", text: "the answer" }] });
    expect(state.agents.t1.loading).toBe(false);
  });

  it("does not duplicate a report the transcript already ends with", () => {
    const state = reduce([
      ...spawn("t1"),
      ...nested("t1", "n1", "the answer"),
      { type: "agent-done", toolId: "t1", report: "  the answer\n" },
    ]);
    expect(state.agents.t1.state.messages).toHaveLength(1);
  });

  it("nests an agent inside an agent as its own flat entry", () => {
    const state = reduce([
      ...spawn("t1"),
      // The sub-agent itself calls the Agent tool (id t2).
      ...([
        { type: "assistant-start", messageId: "n1" },
        { type: "tool-call", toolId: "t2", name: "Agent" },
        { type: "assistant-end" },
      ] as ChatEvent[]).map((event) => ({ type: "agent-event", toolId: "t1", event }) as ChatEvent),
      ...nested("t2", "n2", "deep"),
    ]);
    expect(Object.keys(state.agents).sort()).toEqual(["t1", "t2"]);
    expect(state.agents.t2.state.messages[0].parts).toEqual([
      { type: "text", text: "deep" },
    ]);
  });

  it("prunes runs unreachable from the surviving transcript on rewind", () => {
    const state = reduce([
      {
        type: "user-message",
        message: { id: "u1", role: "user", parts: [{ type: "text", text: "a" }], createdAt: 0 },
      },
      ...spawn("t1"),
      ...nested("t1", "n1", "kept"),
      {
        type: "user-message",
        message: { id: "u2", role: "user", parts: [{ type: "text", text: "b" }], createdAt: 0 },
      },
      { type: "assistant-start", messageId: "a2" },
      { type: "tool-call", toolId: "t9", name: "Agent" },
      { type: "assistant-end" },
      ...nested("t9", "n9", "dropped"),
    ]);
    expect(Object.keys(state.agents).sort()).toEqual(["t1", "t9"]);
    const after = applyChatEvent(state, { type: "rewind", messageId: "u2" });
    expect(Object.keys(after.agents)).toEqual(["t1"]);
  });

  it("keeps a nested-only run alive on rewind (reachability is transitive)", () => {
    const state = reduce([
      ...spawn("t1"),
      ...([
        { type: "assistant-start", messageId: "n1" },
        { type: "tool-call", toolId: "t2", name: "Agent" },
        { type: "assistant-end" },
      ] as ChatEvent[]).map((event) => ({ type: "agent-event", toolId: "t1", event }) as ChatEvent),
      ...nested("t2", "n2", "deep"),
      {
        type: "user-message",
        message: { id: "u2", role: "user", parts: [{ type: "text", text: "b" }], createdAt: 0 },
      },
    ]);
    const after = applyChatEvent(state, { type: "rewind", messageId: "u2" });
    expect(Object.keys(after.agents).sort()).toEqual(["t1", "t2"]);
  });

  it("caps how many runs it keeps, dropping the oldest", () => {
    const events: ChatEvent[] = [];
    for (let i = 0; i < 40; i++) events.push({ type: "agent-start", toolId: `t${i}` });
    const state = reduce(events);
    const ids = Object.keys(state.agents);
    expect(ids).toHaveLength(30);
    expect(ids[0]).toBe("t10");
    expect(ids[29]).toBe("t39");
  });
});

describe("applyChatEvent auto-prompt", () => {
  const prompt = (id: string, text: string): ChatEvent => ({
    type: "auto-prompt",
    prompt: { id, text, delayMs: 8_000, at: 1_000 },
  });

  it("arms a composed prompt for the composer countdown", () => {
    const state = reduce([prompt("p1", "carry on")]);
    expect(state.autoPrompt).toEqual({
      id: "p1",
      text: "carry on",
      delayMs: 8_000,
      at: 1_000,
    });
  });

  it("clears it when the matching id is withdrawn", () => {
    const state = reduce([
      prompt("p1", "carry on"),
      { type: "auto-prompt-cleared", id: "p1" },
    ]);
    expect(state.autoPrompt).toBeNull();
  });

  it("ignores a stale clear, so it can't kill a fresher prompt", () => {
    const state = reduce([
      prompt("p1", "carry on"),
      prompt("p2", "no, do this instead"),
      { type: "auto-prompt-cleared", id: "p1" },
    ]);
    expect(state.autoPrompt?.id).toBe("p2");
  });

  it("is spent by any prompt actually being sent", () => {
    const state = reduce([
      prompt("p1", "carry on"),
      {
        type: "user-message",
        message: {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "carry on" }],
          createdAt: 0,
        },
      },
    ]);
    expect(state.autoPrompt).toBeNull();
  });
});

describe("isEmptyChat", () => {
  it("is empty on a fresh session, even with a draft or notices", () => {
    const s = emptyChatState();
    s.draft = "/resume";
    s.notices = [{ level: "info", text: "hi", at: 0 }];
    expect(isEmptyChat(s)).toBe(true);
  });

  it("is not empty once anything was said, runs or waits", () => {
    const said = reduce([
      {
        type: "user-message",
        message: { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      },
    ]);
    expect(isEmptyChat(said)).toBe(false);
    expect(isEmptyChat({ ...emptyChatState(), busy: true })).toBe(false);
    expect(isEmptyChat({ ...emptyChatState(), queued: ["x"] })).toBe(false);
  });
});

describe("isAllowEverything", () => {
  it("matches the sentinel regardless of case, spacing or trailing punctuation", () => {
    for (const s of ["allow everything", "  Allow Everything ", "ALLOW EVERYTHING."])
      expect(isAllowEverything(s)).toBe(true);
  });

  it("does not match empty, absent or merely-similar instructions", () => {
    for (const s of [undefined, "", "allow everything in /tmp", "allow all"])
      expect(isAllowEverything(s)).toBe(false);
  });
});

describe("assistant settings", () => {
  /** A settings object with only the named capabilities enabled. */
  function settings(patch: Partial<AssistantSettings> = {}): AssistantSettings {
    return { ...emptyChatState().assistant, ...patch };
  }

  it("starts with every capability off, so the derived master is off", () => {
    const s = emptyChatState().assistant;
    expect(s).toEqual({
      enabled: false,
      permissions: { enabled: false, instructions: ALLOW_EVERYTHING },
      questions: { enabled: false, instructions: "", onlyIfSure: false },
      autoPr: { enabled: false, instructions: "", autoMerge: true },
      continuity: { enabled: false, instructions: "", newSession: "after-pr" },
    });
    expect(deriveAssistantEnabled(s)).toBe(false);
  });

  it("pre-sets the sub-options, but they stay inert until ticked", () => {
    // Blanket-accept and auto-merge are what a user ticking a capability
    // almost always wants; neither does anything while its capability is off.
    const s = emptyChatState().assistant;
    expect(isAllowEverything(s.permissions.instructions)).toBe(true);
    expect(s.autoPr.autoMerge).toBe(true);
    expect(s.continuity.newSession).toBe("after-pr");
    expect(deriveAssistantEnabled(s)).toBe(false);
    // Pre-set blanket-accept must not make an off assistant claim it needs
    // (or doesn't need) an endpoint on someone else's behalf.
    expect(assistantNeedsLlm(s)).toBe(false);
  });

  it("derives the master switch from any single enabled capability", () => {
    expect(
      deriveAssistantEnabled(
        settings({ permissions: { enabled: true, instructions: "" } }),
      ),
    ).toBe(true);
    expect(
      deriveAssistantEnabled(
        settings({
          questions: { enabled: true, instructions: "", onlyIfSure: false },
        }),
      ),
    ).toBe(true);
    expect(
      deriveAssistantEnabled(
        settings({ autoPr: { enabled: true, instructions: "", autoMerge: false } }),
      ),
    ).toBe(true);
    expect(
      deriveAssistantEnabled(
        settings({
          continuity: { enabled: true, instructions: "", newSession: "never" },
        }),
      ),
    ).toBe(true);
  });

  it("needs the LLM for continuity — it has no prompt to send without one", () => {
    expect(
      assistantNeedsLlm(
        settings({
          continuity: { enabled: true, instructions: "", newSession: "never" },
        }),
      ),
    ).toBe(true);
  });

  it("needs the LLM only for capabilities that actually consult it", () => {
    // Questions always do.
    expect(
      assistantNeedsLlm(
        settings({
          questions: { enabled: true, instructions: "", onlyIfSure: false },
        }),
      ),
    ).toBe(true);
    // Permissions do, unless blanket-accept bypasses the endpoint.
    expect(
      assistantNeedsLlm(
        settings({ permissions: { enabled: true, instructions: "only git" } }),
      ),
    ).toBe(true);
    expect(
      assistantNeedsLlm(
        settings({
          permissions: { enabled: true, instructions: "allow everything" },
        }),
      ),
    ).toBe(false);
    // Auto-PR never does, and neither does an all-off config.
    expect(
      assistantNeedsLlm(
        settings({ autoPr: { enabled: true, instructions: "", autoMerge: false } }),
      ),
    ).toBe(false);
    expect(assistantNeedsLlm(settings())).toBe(false);
  });

  it("folds an AI-mode note with no LLM detail, anchored to the last turn", () => {
    // Auto-PR fires on busy:false, when nothing is streaming — the note must
    // land on the just-finalized turn, and carry no prompt/response (no LLM was
    // consulted), which is what makes its bubble non-expandable.
    const state = reduce([
      { type: "assistant-start", messageId: "m1" },
      { type: "part-start", kind: "text" },
      { type: "part-delta", kind: "text", delta: "done" },
      { type: "assistant-end" },
      {
        type: "assistant-trace",
        trace: {
          requestId: "auto-pr:1",
          kind: "auto-pr",
          outcome: "note",
          reason: "running…",
          summary: "Running auto PR",
          at: 1,
        },
      },
    ]);
    expect(state.streaming).toBeNull();
    expect(state.assistantTraces).toHaveLength(1);
    const trace = state.assistantTraces[0];
    expect(trace.anchorMessageId).toBe("m1");
    expect(trace.prompt).toBeUndefined();
    expect(trace.response).toBeUndefined();
  });

  it("honours a pinned anchor while its turn is in the transcript", () => {
    // Auto-PR pins the turn that started the run, so notes posted minutes later
    // stay with it instead of trailing whatever the developer has since sent.
    const state = reduce([
      { type: "assistant-start", messageId: "m1" },
      { type: "part-start", kind: "text" },
      { type: "part-delta", kind: "text", delta: "done" },
      { type: "assistant-end" },
      {
        type: "user-message",
        message: {
          id: "m2",
          role: "user",
          parts: [{ type: "text", text: "next" }],
          createdAt: 2,
        },
      },
      {
        type: "assistant-trace",
        trace: {
          requestId: "auto-pr:1",
          kind: "auto-pr",
          outcome: "note",
          summary: "Pushed joran/x to origin",
          at: 3,
          anchorMessageId: "m1",
        },
      },
    ]);
    expect(state.assistantTraces[0].anchorMessageId).toBe("m1");
  });

  it("re-anchors a trace whose pinned turn is gone to the latest message", () => {
    // A stale pin (its turn rewound or capped out of history) must not leave the
    // trace dangling: the UI renders nothing after the last message, so a
    // dangling trace would vanish — or, if parked at the end, would sit below
    // every message sent after it.
    const state = reduce([
      {
        type: "user-message",
        message: {
          id: "m9",
          role: "user",
          parts: [{ type: "text", text: "hi" }],
          createdAt: 1,
        },
      },
      {
        type: "assistant-trace",
        trace: {
          requestId: "auto-pr:1",
          kind: "auto-pr",
          outcome: "note",
          summary: "Opened PR #1",
          at: 2,
          anchorMessageId: "long-gone",
        },
      },
    ]);
    expect(state.assistantTraces[0].anchorMessageId).toBe("m9");
  });
});

describe("autoActionDelayMs", () => {
  it("keeps the 2s…10s curve at 100%", () => {
    expect(autoActionDelayMs(0)).toBe(2000);
    expect(autoActionDelayMs(681 / 2)).toBe(6000);
    expect(autoActionDelayMs(100_000)).toBe(10_000);
    expect(autoActionDelayMs(100_000, 1)).toBe(10_000);
  });
  it("scales the whole curve — floor and cap alike", () => {
    expect(autoActionDelayMs(0, 2)).toBe(4000);
    expect(autoActionDelayMs(100_000, 2)).toBe(20_000);
    expect(autoActionDelayMs(0, 0.5)).toBe(1000);
    expect(autoActionDelayMs(100_000, 0.5)).toBe(5000);
  });
  it("0% applies at once", () => {
    expect(autoActionDelayMs(0, 0)).toBe(0);
    expect(autoActionDelayMs(100_000, 0)).toBe(0);
  });
  it("clamps junk scales instead of trusting the client", () => {
    expect(autoActionDelayMs(100_000, 99)).toBe(10_000 * AUTO_DELAY_MAX_SCALE);
    expect(autoActionDelayMs(100_000, -1)).toBe(0);
    expect(autoActionDelayMs(100_000, Number.NaN)).toBe(10_000);
  });
});
