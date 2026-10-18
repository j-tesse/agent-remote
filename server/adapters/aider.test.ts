import { describe, expect, it } from "vitest";
import { applyChatEvent, emptyChatState } from "../../shared/chat.js";
import type { ChatEvent, ChatPart, ChatState } from "../../shared/protocol.js";
import {
  AiderReplyParser,
  AiderTranslator,
  editOutcome,
  failedBlocks,
  shebangPython,
  stripFilename,
} from "./aider.js";

// Pure: bridge JSONL lines → ChatEvents → folded ChatState. No aider process.

const TAG = "thinking-content-7bbeb8e1441453ad999a0bbba8a46d4b";

function feed(t: AiderTranslator, ...lines: object[]): ChatEvent[] {
  return t.push(lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
}

function fold(events: ChatEvent[], state: ChatState = emptyChatState()): ChatState {
  return events.reduce(applyChatEvent, state);
}

/** Parse one reply delivered as `deltas`, returning its final parts. */
function parts(deltas: string[], tags: string[] = [TAG]): ChatPart[] {
  const p = new AiderReplyParser(tags);
  const events: ChatEvent[] = [{ type: "assistant-start", messageId: "m" }];
  for (const d of deltas) events.push(...p.push(d));
  events.push(...p.end(), { type: "assistant-end" });
  return fold(events).messages[0]?.parts ?? [];
}

const strip = (ps: ChatPart[]) =>
  ps.map((p) =>
    p.type === "tool" ? { tool: p.name, args: p.args } : { [p.type]: (p as { text: string }).text },
  );

const hello = {
  type: "hello",
  model: "openai/m",
  mode: "code",
  modes: ["code", "ask", "architect"],
  reasoningTags: [TAG],
  commands: [{ name: "add", description: "Add files to the chat" }],
  announcements: ["Aider v0.86.1", "Main model: openai/m with diff-fenced edit format"],
};

describe("AiderReplyParser", () => {
  it("lifts a diff-fenced block (as split live by vLLM) into an Edit tool part", () => {
    // Verbatim delta boundaries from a real gemma-4 turn: the HEAD marker
    // arrives split across two deltas, the filename across two more.
    const deltas = [
      "I", " will fix the bug in `", "calc.py` by changing", " the subtraction operator to an",
      " addition operator in", " the `add` function.", "\n\n```python\ncalc.", "py\n<<<",
      "<<<< SEARCH\ndef", " add(a, b):", "\n    return a - b", "\n=======\ndef", " add(a, b):",
      "\n    return a + b", "\n>>>>>>> REPLACE\n```",
    ];
    expect(strip(parts(deltas))).toEqual([
      {
        text: "I will fix the bug in `calc.py` by changing the subtraction operator to an addition operator in the `add` function.\n\n",
      },
      {
        tool: "Edit",
        args: {
          file_path: "calc.py",
          old_string: "def add(a, b):\n    return a - b",
          new_string: "def add(a, b):\n    return a + b",
        },
      },
    ]);
  });

  it("is independent of how the stream is chunked", () => {
    const reply =
      "Plan:\n\n```python\nsrc/a.py\n<<<<<<< SEARCH\nx = 1\n=======\nx = 2\n>>>>>>> REPLACE\n```\n\nDone, and tidy.\n";
    const whole = strip(parts([reply]));
    const perChar = strip(parts([...reply]));
    expect(perChar).toEqual(whole);
    expect(whole).toEqual([
      { text: "Plan:\n\n" },
      { tool: "Edit", args: { file_path: "src/a.py", old_string: "x = 1", new_string: "x = 2" } },
      { text: "\nDone, and tidy.\n" },
    ]);
  });

  it("streams prose before the line ends (no whole-line lag)", () => {
    const p = new AiderReplyParser();
    const ev = p.push("Here is a sentence that is still being");
    expect(ev).toContainEqual({ type: "part-delta", kind: "text", delta: "Here is a sentence that is still being" });
  });

  it("holds a possible block header back until it's decided", () => {
    const p = new AiderReplyParser();
    // A lone filename line could be a header — nothing may flash as prose.
    expect(p.push("Intro text\n\n```python\ncalc.py\n<<<")).toEqual([
      { type: "part-start", kind: "text" },
      { type: "part-delta", kind: "text", delta: "Intro text\n" },
    ]);
  });

  it("supports the plain `diff` layout (filename before the fence) and repeated files", () => {
    const reply = [
      "a.py",
      "```python",
      "<<<<<<< SEARCH",
      "one",
      "=======",
      "uno",
      ">>>>>>> REPLACE",
      "```",
      "```python",
      "<<<<<<< SEARCH",
      "two",
      "=======",
      "dos",
      ">>>>>>> REPLACE",
      "```",
      "",
    ].join("\n");
    expect(strip(parts([reply]))).toEqual([
      { tool: "Edit", args: { file_path: "a.py", old_string: "one", new_string: "uno" } },
      // No filename → aider reuses the previous one.
      { tool: "Edit", args: { file_path: "a.py", old_string: "two", new_string: "dos" } },
    ]);
  });

  it("treats an empty SEARCH as a new file", () => {
    const reply = "```\nnew.txt\n<<<<<<< SEARCH\n=======\nhello\n>>>>>>> REPLACE\n```\n";
    expect(strip(parts([reply]))).toEqual([
      { tool: "Edit", args: { file_path: "new.txt", old_string: "", new_string: "hello" } },
    ]);
  });

  it("leaves ordinary code blocks as markdown", () => {
    const reply = "Run:\n\n```bash\nnpm test\n```\n";
    expect(strip(parts([reply]))).toEqual([{ text: reply }]);
  });

  it("splits aider's reasoning wrapper into a thinking part, even split mid-tag", () => {
    const reply = `<${TAG}>\n\nLet me think.\n\n</${TAG}>\n\nAnswer here.`;
    const chunks = [reply.slice(0, 7), reply.slice(7, 60), reply.slice(60)];
    expect(strip(parts(chunks))).toEqual([
      { thinking: "Let me think.\n\n" },
      { text: "\n\nAnswer here." },
    ]);
  });

  it("closes on the model's own tag name", () => {
    expect(strip(parts([`<${TAG}>hmm</think>ok`], [TAG, "think"]))).toEqual([
      { thinking: "hmm" },
      { text: "ok" },
    ]);
  });

  it("shows an unterminated block raw instead of dropping it", () => {
    const out = strip(parts(["```\nx.py\n<<<<<<< SEARCH\nfoo\n"]));
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ text: expect.stringContaining("<<<<<<< SEARCH\nfoo") });
  });
});

describe("stripFilename (mirrors aider)", () => {
  it.each([
    ["calc.py", "calc.py"],
    ["  src/x.ts:  ", "src/x.ts"],
    ["### `a/b.py`", "a/b.py"],
    ["**a.py**", "a.py"],
    ["```python", undefined],
    ["```a/b.py", "a/b.py"],
    ["...", undefined],
  ])("%s → %s", (line, want) => expect(stripFilename(line)).toBe(want));
});

describe("edit outcomes", () => {
  const edit = { toolId: "t", path: "a.py", search: "x = 1", replace: "x = 2" };
  const error = [
    "# 1 SEARCH/REPLACE block failed to match!",
    "",
    "## SearchReplaceNoExactMatch: This SEARCH block failed to exactly match lines in a.py",
    "<<<<<<< SEARCH",
    "x = 1",
    "=======",
    "x = 2",
    ">>>>>>> REPLACE",
    "",
    "The SEARCH section must exactly match an existing block of lines",
    "",
    "# The other 1 SEARCH/REPLACE block were applied successfully.",
  ].join("\n");

  it("parses aider's failed-match report", () => {
    expect(failedBlocks(error)).toEqual([
      { path: "a.py", search: "x = 1\n", section: expect.stringContaining("failed to exactly match lines in a.py") },
    ]);
  });

  it("marks only the failed block of a partially-applied reply as an error", () => {
    const other = { ...edit, toolId: "u", search: "y = 1" };
    const result = { applied: true, written: ["a.py"], error };
    expect(editOutcome(edit, result).isError).toBe(true);
    expect(editOutcome(other, result)).toEqual({ output: "Applied edit to a.py", isError: false });
  });

  it("fails every edit when nothing was applied", () => {
    expect(editOutcome(edit, { applied: false, written: [], error: null }).isError).toBe(true);
    expect(
      editOutcome(edit, { applied: true, written: [], error: "The LLM did not conform" }).isError,
    ).toBe(true);
  });
});

describe("AiderTranslator", () => {
  it("announces commands, modes and the startup banner on hello", () => {
    const t = new AiderTranslator();
    const ev = feed(
      t,
      { type: "output", level: "info", text: "https://aider.chat/docs/llms/warnings.html" },
      hello,
    );
    const s = fold(ev);
    expect(s.commands).toEqual([{ name: "add", description: "Add files to the chat" }]);
    expect(s.modes.map((m) => m.id)).toEqual(["code", "ask", "architect"]);
    expect(s.currentMode).toBe("code");
    expect(s.notices.at(-1)?.text).toContain("Main model: openai/m");
    expect(s.notices.at(-1)?.text).toContain("warnings.html");
  });

  it("runs a whole edit turn: user bubble, prose, diff, applied, idle", () => {
    const t = new AiderTranslator();
    const ev = feed(
      t,
      hello,
      { type: "turn_start", text: "fix it" },
      { type: "reply_start" },
      { type: "delta", text: "Fixing.\n\n```python\na.py\n<<<<<<< SEARCH\nx = 1\n=======\nx = 2\n>>>>>>> REPLACE\n```" },
      { type: "output", level: "info", text: "Tokens: 2.5k sent, 64 received." },
      { type: "output", level: "info", text: "Applied edit to a.py" },
      { type: "output", level: "info", text: "Commit 1a2b3c4 fix: x" },
      { type: "reply_end", applied: true, written: ["a.py"], error: null, content: null },
      { type: "turn_end" },
    );
    const s = fold(ev);
    expect(s.busy).toBe(false);
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const tool = s.messages[1].parts.find((p) => p.type === "tool");
    expect(tool).toMatchObject({ name: "Edit", status: "done", output: "Applied edit to a.py" });
    // Tokens/applied chatter is dropped; the commit is kept.
    expect(s.notices.map((n) => n.text)).toEqual([expect.any(String), "Commit 1a2b3c4 fix: x"]);
  });

  it("parses a non-streamed reply from reply_end.content", () => {
    const t = new AiderTranslator();
    const s = fold(
      feed(
        t,
        hello,
        { type: "turn_start", text: "hi" },
        { type: "reply_start" },
        { type: "reply_end", applied: true, written: [], error: null, content: "Hello there." },
        { type: "turn_end" },
      ),
    );
    expect(s.messages[1].parts).toEqual([{ type: "text", text: "Hello there." }]);
  });

  it("turns a pure command's output into the reply", () => {
    const t = new AiderTranslator();
    const s = fold(
      feed(
        t,
        hello,
        { type: "turn_start", text: "/ls" },
        { type: "output", level: "info", text: "Files in chat:" },
        { type: "output", level: "info", text: "  a.py" },
        { type: "turn_end" },
      ),
    );
    expect(s.messages[1].parts[0]).toMatchObject({ type: "text", text: expect.stringContaining("Files in chat:\n  a.py") });
  });

  it("shows a reflection as a system turn, never a user one", () => {
    const t = new AiderTranslator();
    const s = fold(
      feed(
        t,
        hello,
        { type: "turn_start", text: "go" },
        { type: "reply_start" },
        { type: "reply_end", applied: false, written: [], error: null, content: "ok" },
        { type: "reply_start", reflection: "I added these files to the chat: a.py\nLet me know…" },
        { type: "reply_end", applied: true, written: [], error: null, content: "ok2" },
        { type: "turn_end" },
      ),
    );
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant", "system", "assistant"]);
    expect(s.messages[2].parts[0]).toEqual({ type: "text", text: "Aider: I added these files to the chat: a.py" });
  });

  it("maps confirm_ask onto a permission card and answers by value", () => {
    const t = new AiderTranslator();
    feed(t, hello, { type: "turn_start", text: "go" });
    const [ev] = feed(t, {
      type: "confirm",
      id: "aider-1",
      question: "Run shell command?",
      subject: "npm test",
      group: true,
      explicitYes: true,
      allowNever: true,
    });
    expect(ev).toEqual({
      type: "ui-request",
      request: {
        id: "aider-1",
        kind: "select",
        title: "Run shell command?",
        message: undefined,
        tool: { name: "Bash", args: { command: "npm test" } },
        // explicit_yes_required → no "Yes to all".
        options: [
          { value: "y", label: "Yes", intent: "accept" },
          { value: "n", label: "No", intent: "cancel" },
          { value: "s", label: "Skip all", intent: "cancel" },
          { value: "d", label: "Don't ask again", intent: "cancel" },
        ],
      },
    });
    const { data, events } = t.encode({ type: "ui-response", requestId: "aider-1", value: "y" });
    expect(JSON.parse(data)).toEqual({ type: "ui_response", id: "aider-1", value: "y" });
    expect(events).toEqual([{ type: "ui-request-done", requestId: "aider-1" }]);
  });

  it("clears a card an interrupt left unanswered", () => {
    const t = new AiderTranslator();
    feed(t, hello, { type: "turn_start", text: "go" });
    feed(t, { type: "confirm", id: "aider-1", question: "Create new file?", subject: "x" });
    expect(feed(t, { type: "turn_end" })).toContainEqual({ type: "ui-request-done", requestId: "aider-1" });
  });

  it("queues a prompt sent mid-turn and shows it only when it starts", () => {
    const t = new AiderTranslator();
    feed(t, hello, { type: "turn_start", text: "first" });
    const sent = t.encode({ type: "prompt", text: "second" });
    expect(JSON.parse(sent.data)).toEqual({ type: "prompt", text: "second" });
    expect(sent.events).toEqual([{ type: "queue", queued: ["second"] }]);
    const next = feed(t, { type: "turn_end" }, { type: "turn_start", text: "second" });
    expect(next).toContainEqual({ type: "queue", queued: [] });
    expect(next.filter((e) => e.type === "user-message")).toHaveLength(1);
  });

  it("queues prompts sent before aider finished starting", () => {
    const t = new AiderTranslator();
    expect(t.encode({ type: "prompt", text: "early" }).events).toEqual([{ type: "queue", queued: ["early"] }]);
  });

  it("reports a mode switch", () => {
    const t = new AiderTranslator();
    feed(t, hello);
    expect(JSON.parse(t.encode({ type: "set-mode", mode: "ask" }).data)).toEqual({ type: "set_mode", mode: "ask" });
    const s = fold(feed(t, { ...hello, type: "coder", mode: "ask", announcements: [] }), fold(feed(new AiderTranslator(), hello)));
    expect(s.currentMode).toBe("ask");
  });
});

describe("shebangPython", () => {
  it.each([
    ["#!/home/u/.local/share/uv/tools/aider-chat/bin/python", "/home/u/.local/share/uv/tools/aider-chat/bin/python"],
    ["#!/usr/bin/env python3", "python3"],
    ["#!/usr/bin/python3.12", "/usr/bin/python3.12"],
    ["#!/bin/sh", undefined],
    ["\x7fELF", undefined],
  ])("%s", (line, want) => expect(shebangPython(line)).toBe(want));
});
