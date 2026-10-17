import { describe, it, expect } from "vitest";
import {
  spawnedSessionId,
  DIFF_CONTEXT,
  copyText,
  diffFoldLabel,
  diffRows,
  diffStats,
  groupParts,
  lineDiff,
  markWordDiff,
  renderMessage,
  renderPart,
  shortenPath,
  thoughtAmount,
  thinkingSummary,
  toolView,
  wordDiff,
} from "./render.js";
import type { DiffLine } from "./render.js";
import type { ChatMessage, ChatPart } from "./protocol.js";
import { emptyChatState } from "./chat.js";

// Small helper to build a tool part with just the args we're exercising.
function toolPart(args: unknown): Extract<ChatPart, { type: "tool" }> {
  return { type: "tool", toolId: "t1", name: "Tool", args, output: "", status: "done" };
}

describe("shortenPath", () => {
  it("keeps short paths and trims long ones to the last two segments", () => {
    expect(shortenPath("file.ts")).toBe("file.ts");
    expect(shortenPath("dir/file.ts")).toBe("dir/file.ts");
    expect(shortenPath("/a/b/c/d/file.ts")).toBe("…/d/file.ts");
  });
});

describe("lineDiff", () => {
  it("marks added, removed, and unchanged lines", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual([
      { sign: " ", text: "a" },
      { sign: "-", text: "b" },
      { sign: "+", text: "B" },
      { sign: " ", text: "c" },
    ]);
  });
});

describe("toolView", () => {
  it("renders an edit (old/new_string) as a diff", () => {
    const view = toolView(
      toolPart({ file_path: "/repo/src/app.ts", old_string: "a", new_string: "b" }),
    );
    expect(view.primary).toBe("…/src/app.ts");
    expect(view.stat).toEqual({ added: 1, removed: 1 });
    expect(view.body.kind).toBe("diff");
    if (view.body.kind === "diff") {
      expect(view.body.path).toBe("/repo/src/app.ts");
      expect(view.body.added).toBe(1);
      expect(view.body.removed).toBe(1);
      expect(view.body.rows.map((r) => (r.kind === "line" ? r.line.text : "…"))).toEqual([
        "a",
        "b",
      ]);
    }
  });

  // pi's edit takes camelCase text in an `edits[]` array instead of claude's
  // top-level old/new_string; both must land in the same diff view.
  it("renders pi's camelCase edits[] as a diff too", () => {
    const view = toolView(
      toolPart({ path: "shared/render.ts", edits: [{ oldText: "foo", newText: "bar" }] }),
    );
    expect(view.primary).toBe("shared/render.ts");
    expect(view.body.kind).toBe("diff");
    if (view.body.kind === "diff")
      expect(
        view.body.rows.filter((r) => r.kind === "line").map((r) => r.line.text),
      ).toEqual(["foo", "bar"]);
  });

  it("shows a multi-edit call as one diff with a hunk break between edits", () => {
    const view = toolView(
      toolPart({
        path: "a.ts",
        edits: [
          { oldText: "one", newText: "ONE" },
          { oldText: "two", newText: "TWO" },
        ],
      }),
    );
    expect(view.secondary).toBe("2 edits");
    expect(view.stat).toEqual({ added: 2, removed: 2 });
    if (view.body.kind === "diff")
      expect(
        view.body.rows.map((r) => (r.kind === "fold" ? "fold" : r.line.sign)),
      ).toEqual(["-", "+", "fold", "-", "+"]);
  });

  it("never stacks a hunk break on a fold that already marks the gap", () => {
    // Second edit sits far down a long fragment, so its own elided lead *is* the
    // break between the two hunks.
    const long = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
    const view = toolView(
      toolPart({
        path: "a.ts",
        edits: [
          { oldText: "one", newText: "ONE" },
          { oldText: long, newText: long.replace("l15", "L15") },
        ],
      }),
    );
    if (view.body.kind === "diff") {
      const kinds = view.body.rows.map((r) => r.kind);
      expect(kinds.some((k, i) => k === "fold" && kinds[i - 1] === "fold")).toBe(false);
    } else {
      throw new Error("expected a diff body");
    }
  });

  it("never stacks a hunk break on a fold left over from the previous hunk", () => {
    const long = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
    const view = toolView(
      toolPart({
        path: "a.ts",
        edits: [
          { oldText: long, newText: long.replace("l15", "L15") },
          { oldText: "one", newText: "ONE" },
        ],
      }),
    );
    if (view.body.kind !== "diff") throw new Error("expected a diff body");
    const kinds = view.body.rows.map((r) => r.kind);
    expect(kinds.some((k, i) => k === "fold" && kinds[i - 1] === "fold")).toBe(false);
  });

  it("treats an empty oldText as an insertion, not a missing edit", () => {
    const view = toolView(toolPart({ path: "new.ts", oldText: "", newText: "hi" }));
    expect(view.body.kind).toBe("diff");
    expect(view.stat).toEqual({ added: 1, removed: 0 });
  });

  it("renders a write (content) as a code block labelled with the path", () => {
    const view = toolView(toolPart({ file_path: "new.txt", content: "hello" }));
    expect(view.primary).toBe("new.txt");
    expect(view.body).toEqual({ kind: "code", label: "new.txt", text: "hello" });
  });

  it("renders a bash command, leading the body with its description", () => {
    const view = toolView(
      toolPart({ command: "npm   test", description: "run tests" }),
    );
    expect(view.primary).toBe("npm test"); // summary collapses whitespace
    expect(view.secondary).toBe("run tests");
    // …but the body keeps the command verbatim.
    expect(view.body).toEqual({ kind: "code", text: "run tests:\nnpm   test" });
  });

  it("renders a read as a path with a line-range subtitle and no body", () => {
    const view = toolView(toolPart({ file_path: "/x/y/z.ts", offset: 10, limit: 5 }));
    expect(view.primary).toBe("…/y/z.ts");
    expect(view.secondary).toBe("lines 10–15");
    expect(view.body).toEqual({ kind: "none" });
  });

  // Tools without an Edit/Write/Bash/Read shape used to dump raw JSON as their
  // subject. They now pick a legible field-driven subject (harness-agnostic —
  // recognizes arg fields, not tool names) while keeping full args in the body.
  it("previews a query tool (ToolSearch/WebSearch) by its query", () => {
    const view = toolView(toolPart({ query: "select:Read,Edit", max_results: 5 }));
    expect(view.primary).toBe("select:Read,Edit");
    expect(view.body.kind).toBe("json");
  });

  it("previews a WebFetch by url with the prompt as secondary", () => {
    const view = toolView(
      toolPart({ url: "https://example.com/docs/page", prompt: "summarize the page" }),
    );
    expect(view.primary).toBe("…/docs/page"); // path-like → shortened
    expect(view.secondary).toBe("summarize the page");
    expect(view.body.kind).toBe("json");
  });

  it("previews an Agent by its description with the subagent as secondary", () => {
    const view = toolView(
      toolPart({ description: "find the reducer", prompt: "long task…", subagent_type: "Explore" }),
    );
    expect(view.primary).toBe("find the reducer");
    expect(view.secondary).toBe("Explore");
    expect(view.body.kind).toBe("json");
  });

  it("previews a Skill by its skill name", () => {
    const view = toolView(toolPart({ skill: "code-review", args: "--fix" }));
    expect(view.primary).toBe("code-review");
    expect(view.secondary).toBe("--fix");
    expect(view.body.kind).toBe("json");
  });

  it("previews a Grep by its pattern with the path as secondary", () => {
    const view = toolView(toolPart({ pattern: "toolView", path: "shared", output_mode: "content" }));
    expect(view.primary).toBe("toolView");
    expect(view.secondary).toBe("shared");
    expect(view.body.kind).toBe("json");
  });

  it("previews an MCP tool by its query field", () => {
    const view = toolView(toolPart({ query: "from:alice", label_ids: ["INBOX"] }));
    expect(view.primary).toBe("from:alice");
    expect(view.body.kind).toBe("json");
  });

  it("collapses whitespace and truncates a long subject", () => {
    const long = "word ".repeat(40).trim();
    const view = toolView(toolPart({ query: `a\n${long}` }));
    expect(view.primary.length).toBeLessThanOrEqual(81); // 80 + ellipsis
    expect(view.primary).not.toContain("\n");
  });

  it("falls back to pretty JSON for a tool with no recognized field", () => {
    const view = toolView(toolPart({ foo: 1, bar: 2 }));
    expect(view.primary).not.toMatch(/^\{/); // never a raw JSON subject
    expect(view.body.kind).toBe("json");
    if (view.body.kind === "json") {
      expect(view.body.text).toBe(JSON.stringify({ foo: 1, bar: 2 }, null, 2));
    }
  });
});

describe("wordDiff", () => {
  it("marks only the words that differ", () => {
    const d = wordDiff("const a = 1;", "const a = 2;")!;
    expect(d.old.filter((w) => w.changed).map((w) => w.text)).toEqual(["1;"]);
    expect(d.new.filter((w) => w.changed).map((w) => w.text)).toEqual(["2;"]);
    // Reassembling either side gives the original line back.
    expect(d.old.map((w) => w.text).join("")).toBe("const a = 1;");
    expect(d.new.map((w) => w.text).join("")).toBe("const a = 2;");
  });

  it("keeps the whitespace between words out of the highlight", () => {
    const d = wordDiff("a b   c", "a bb   c")!;
    // The changed run is the word, never the spaces around it.
    expect(d.new.find((w) => w.changed)?.text).toBe("bb");
  });
});

describe("markWordDiff", () => {
  it("pairs an adjacent removed/added line but not a lone one", () => {
    const marked = markWordDiff(lineDiff("a x\nkeep", "a y\nkeep"));
    expect(marked[0].words).toBeDefined();
    expect(marked[1].words).toBeDefined();
    expect(marked[2].words).toBeUndefined(); // context line
    expect(markWordDiff(lineDiff("a\nb", "a")).every((l) => l.words === undefined)).toBe(
      true,
    );
  });
});

describe("diffRows", () => {
  const run = (sign: " " | "+" | "-", count: number) =>
    Array.from({ length: count }, (_x, i): DiffLine => ({ sign, text: `${sign}${i}` }));

  it("folds a long unchanged run, keeping context either side", () => {
    const rows = diffRows([...run(" ", 20), ...run("+", 1), ...run(" ", 20)]);
    const folds = rows.filter((r) => r.kind === "fold");
    expect(folds).toHaveLength(2);
    if (folds[0].kind === "fold") expect(folds[0].count).toBe(20 - DIFF_CONTEXT);
    expect(rows.filter((r) => r.kind === "line" && r.line.sign === "+")).toHaveLength(1);
  });

  it("never folds short runs — a short diff stays fully readable", () => {
    const rows = diffRows([...run(" ", 6), ...run("-", 1), ...run(" ", 6)]);
    expect(rows.every((r) => r.kind === "line")).toBe(true);
  });

  it("shows every line when nothing is changed", () => {
    expect(diffRows(run(" ", 30)).every((r) => r.kind === "line")).toBe(true);
  });

  it("names the hidden lines, and says nothing for a hunk break", () => {
    expect(diffFoldLabel(2)).toBe("⋯ 2 unchanged lines");
    expect(diffFoldLabel(1)).toBe("⋯ 1 unchanged line");
    expect(diffFoldLabel()).toBe("⋯");
  });
});

describe("diffStats", () => {
  it("tallies added and removed lines, ignoring context", () => {
    expect(diffStats(lineDiff("a\nb\nc\nd", "a\nc\nX\nd"))).toEqual({
      added: 1,
      removed: 1,
    });
  });
});

describe("thinking summary", () => {
  const words = (n: number) => Array.from({ length: n }, (_x, i) => `w${i}`).join(" ");

  it("counts words below the page threshold", () => {
    expect(thoughtAmount(words(3))).toBe("3 words");
    expect(thoughtAmount("one two")).toBe("2 words");
    expect(thoughtAmount("one")).toBe("1 word");
  });

  it("switches to pages once the thought is past ~1.2 pages", () => {
    expect(thoughtAmount(words(599))).toBe("599 words");
    expect(thoughtAmount(words(600))).toBe("1.2 pages");
    expect(thoughtAmount(words(6_190))).toBe("12 pages");
  });

  it("says nothing about text that isn't there", () => {
    expect(thoughtAmount("")).toBe("");
    expect(thoughtAmount("   \n ")).toBe("");
  });

  it("reads as live while reasoning, past-tense once settled", () => {
    expect(thinkingSummary(words(12), true)).toEqual({
      label: "Thinking…",
      amount: "12 words",
    });
    expect(thinkingSummary(words(12))).toEqual({
      label: "Thought for",
      amount: "12 words",
    });
  });
});

describe("renderPart", () => {
  it("renders assistant text through markdown", () => {
    const part = renderPart({ type: "text", text: "**bold**" });
    expect(part.component).toBe("Markdown");
    expect(part.html).toContain("<strong>bold</strong>");
  });

  it("renders an empty thinking part as a transient label", () => {
    const part = renderPart({ type: "thinking", text: "   " });
    expect(part.className).toBe("chat-thinking-label");
    expect(part.html).toContain("Thinking…");
  });

  it("collapses a thought to its label plus how much of it there is", () => {
    const part = renderPart({
      type: "thinking",
      text: Array.from({ length: 610 }, (_x, i) => `w${i}`).join(" "),
    });
    expect(part.className).toBe("chat-thinking");
    expect(part.html).toContain("Thought for");
    expect(part.html).toContain('<span class="chat-thinking-count">1.2 pages</span>');
    // The thought itself stays in the DOM behind the disclosure, escaped.
    expect(part.html).toContain("w609");
  });

  it("renders a diff body with a path/stats header, gutters and folds", () => {
    const part = renderPart(
      toolPart({
        file_path: "/repo/a.ts",
        old_string: "keep\nold value",
        new_string: "keep\nnew value",
      }),
    );
    expect(part.html).toContain('<span class="chat-diff-path">/repo/a.ts</span>');
    expect(part.html).toContain('<span class="diff-add">+1</span>');
    expect(part.html).toContain('<span class="diff-del">−1</span>');
    expect(part.html).toContain('<span class="diff-mark">-</span>');
    // Only the word that differs is marked, not the whole line — "value" is
    // common to both sides and stays plain.
    expect(part.html).toContain('<span class="diff-word">old</span> value');
    expect(part.html).toContain('<span class="diff-word">new</span> value');
  });

  it("tallies +N −M on the collapsed summary too, not just the body", () => {
    const part = renderPart(
      toolPart({ path: "a.ts", edits: [{ oldText: "x", newText: "y" }] }),
    );
    const summary = part.html.slice(0, part.html.indexOf("</summary>"));
    expect(summary).toContain('<span class="chat-tool-stats">');
    expect(summary).toContain('<span class="diff-add">+1</span>');
    expect(summary).toContain('<span class="diff-del">−1</span>');
  });

  it("escapes raw HTML inside thinking text", () => {
    const part = renderPart({ type: "thinking", text: "<script>x</script>" });
    expect(part.html).toContain("&lt;script&gt;");
    expect(part.html).not.toContain("<script>");
  });

  it("carries the tool status onto the details element", () => {
    const part = renderPart(toolPart({ command: "ls" }));
    expect(part.component).toBe("ToolPart");
    expect(part.html).toContain('data-status="done"');
  });

  it("renders an image part as an <img> with escaped url and alt", () => {
    const part = renderPart({
      type: "image",
      id: "abc",
      mediaType: "image/png",
      name: 'a"b<c',
      url: "/api/upload/abc",
    });
    expect(part.component).toBe("ImagePart");
    expect(part.html).toContain('src="/api/upload/abc"');
    expect(part.html).toContain('alt="a&quot;b&lt;c"');
    expect(part.html).not.toContain('alt="a"b<c"');
  });
});

describe("renderMessage", () => {
  it("renders a user bubble as markdown, with raw HTML still escaped", () => {
    const msg: ChatMessage = {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "a <b> & **c**" }],
      createdAt: 0,
    };
    const rendered = renderMessage(msg);
    expect(rendered.bubbleClassName).toBe("chat-bubble user");
    expect(rendered.html).toContain('<div class="chat-md">');
    expect(rendered.html).toContain("<strong>c</strong>");
    expect(rendered.html).toContain("a &lt;b&gt; &amp;");
    expect(rendered.html).not.toContain("<b>");
  });

  it("renders attached images in a user bubble alongside text", () => {
    const msg: ChatMessage = {
      id: "u2",
      role: "user",
      parts: [
        { type: "text", text: "look" },
        {
          type: "image",
          id: "img1",
          mediaType: "image/png",
          url: "/api/upload/img1",
        },
      ],
      createdAt: 0,
    };
    const rendered = renderMessage(msg);
    expect(rendered.html).toContain("look");
    expect(rendered.html).toContain('<img class="chat-image"');
    expect(rendered.html).toContain('src="/api/upload/img1"');
  });

  it("splits an assistant turn into a prose bubble plus a standalone tool", () => {
    const msg: ChatMessage = {
      id: "m1",
      role: "assistant",
      parts: [
        { type: "text", text: "hi" },
        toolPart({ command: "ls" }),
      ],
      createdAt: 0,
    };
    const rendered = renderMessage(msg);
    expect(rendered.parts).toHaveLength(2);
    expect(rendered.bubbleClassName).toBe("chat-turn assistant");
    // Prose is wrapped in a bubble; the tool is a bubble in its own right.
    expect(rendered.html).toBe(
      `<div class="chat-bubble assistant">${rendered.parts[0].html}</div>` +
        rendered.parts[1].html,
    );
    expect(rendered.parts[1].className).toBe("chat-tool standalone");
  });

  it("gives a tool-only turn no wrapping prose bubble", () => {
    const msg: ChatMessage = {
      id: "m2",
      role: "assistant",
      parts: [toolPart({ command: "ls" })],
      createdAt: 0,
    };
    const rendered = renderMessage(msg);
    expect(rendered.html).not.toContain("chat-bubble");
    expect(rendered.html).toContain('class="chat-tool standalone"');
  });
});

describe("groupParts", () => {
  it("keeps consecutive prose parts in one group and splits each tool out", () => {
    const groups = groupParts([
      { type: "thinking", text: "hmm" },
      { type: "text", text: "hi" },
      toolPart({ command: "ls" }),
      { type: "text", text: "done" },
    ]);
    expect(groups.map((g) => g.kind)).toEqual(["prose", "tool", "prose"]);
    expect(groups[0].kind === "prose" && groups[0].parts).toHaveLength(2);
  });

  it("keys tool groups by toolId so open state survives a growing turn", () => {
    const tool = toolPart({ command: "ls" });
    const before = groupParts([tool]);
    const after = groupParts([tool, { type: "text", text: "and then" }]);
    expect(before[0].key).toBe("tool-t1");
    expect(after[0].key).toBe(before[0].key);
  });
});

describe("renderPart sub-agent panels", () => {
  const agentTool = (): Extract<ChatPart, { type: "tool" }> => ({
    type: "tool",
    toolId: "t1",
    name: "Agent",
    args: { description: "Explore X", subagent_type: "Explore", prompt: "long…" },
    output: "the final report",
    status: "done",
  });
  const run = (messages: ChatMessage[], loading?: boolean) => ({
    t1: {
      toolId: "t1",
      agentType: "Explore",
      state: { ...emptyChatState(), messages },
      loading,
    },
  });
  const assistant = (id: string, text: string): ChatMessage => ({
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
    createdAt: 0,
  });

  it("renders today's args + output when there is no run", () => {
    const rendered = renderPart(agentTool(), true);
    expect(rendered.component).toBe("ToolPart");
    expect(rendered.html).toContain('<pre class="chat-tool-output">the final report</pre>');
    expect(rendered.html).not.toContain("chat-agent");
  });

  it("replaces args and the duplicate report <pre> with the nested transcript", () => {
    const rendered = renderPart(agentTool(), true, run([
      { id: "n0", role: "user", parts: [{ type: "text", text: "go" }], createdAt: 0 },
      assistant("n1", "the final report"),
    ]));
    expect(rendered.component).toBe("AgentPart");
    expect(rendered.html).toContain('<div class="chat-agent">');
    expect(rendered.html).toContain('<div class="chat-turn user">');
    expect(rendered.html).toContain("the final report");
    // Opens with the task it was given — neither the stream nor the on-disk
    // transcript carries the sub-agent's own first message.
    expect(rendered.html.indexOf("long…")).toBeGreaterThan(-1);
    expect(rendered.html.indexOf("long…")).toBeLessThan(
      rendered.html.indexOf("the final report"),
    );
    expect(rendered.html).not.toContain("chat-tool-output");
    expect(rendered.html).not.toContain("chat-tool-args");
    // The collapsed summary line is untouched.
    expect(rendered.html).toContain('<span class="chat-tool-preview">Explore X</span>');
  });

  it("shows a placeholder while a resumed transcript loads", () => {
    const rendered = renderPart(agentTool(), true, run([], true));
    expect(rendered.html).toContain("Loading transcript…");
  });

  it("falls back to the ordinary tool view for an empty run", () => {
    // A backgrounded agent's tool output is a launch stub, not a report — an
    // empty panel would hide the only information there is.
    const rendered = renderPart(agentTool(), true, run([]));
    expect(rendered.component).toBe("ToolPart");
    expect(rendered.html).toContain("chat-tool-output");
    expect(rendered.html).not.toContain("chat-agent");
  });

  it("nests an agent inside an agent through the flat map", () => {
    const inner: Extract<ChatPart, { type: "tool" }> = {
      type: "tool", toolId: "t2", name: "Agent", args: {}, output: "", status: "done",
    };
    const agents = {
      ...run([{ id: "n1", role: "assistant", parts: [inner], createdAt: 0 }]),
      t2: { toolId: "t2", state: { ...emptyChatState(), messages: [assistant("d1", "deep")] } },
    };
    const html = renderPart(agentTool(), true, agents).html;
    expect(html.match(/class="chat-agent"/g)).toHaveLength(2);
    expect(html).toContain("deep");
  });
});

describe("renderMessage system turns", () => {
  const sys = (text: string): ChatMessage => ({
    id: "s1",
    role: "system",
    parts: [{ type: "text", text }],
    createdAt: 0,
  });

  it("renders a muted line, never a user bubble", () => {
    const r = renderMessage(sys("Background command finished"));
    expect(r.bubbleClassName).toBe("chat-system");
    expect(r.parts[0].component).toBe("SystemPart");
    expect(r.html).toBe('<div class="chat-system">Background command finished</div>');
    expect(r.html).not.toContain("chat-bubble");
  });

  it("escapes the machine-formatted text it carries", () => {
    expect(renderMessage(sys("<task-notification>x</task-notification>")).html).toContain(
      "&lt;task-notification&gt;",
    );
  });
});

describe("copyText", () => {
  it("copies raw markdown, joining text parts and skipping thinking", () => {
    expect(
      copyText([
        { type: "thinking", text: "hmm" },
        { type: "text", text: "# Title\n\n- **a**\n" },
        { type: "text", text: "`code`" },
      ]),
    ).toBe("# Title\n\n- **a**\n\n`code`");
  });
  it("falls back to thinking when that's all there is", () => {
    expect(copyText([{ type: "thinking", text: " deep thought " }])).toBe("deep thought");
  });
  it("names images instead of linking their auth-gated url", () => {
    expect(
      copyText([
        { type: "text", text: "see" },
        { type: "image", id: "x", mediaType: "image/png", name: "a.png", url: "/api/upload/x" },
      ]),
    ).toBe("see\n\n[image: a.png]");
  });
});

describe("spawnedSessionId", () => {
  const tool = (output?: string): Extract<ChatPart, { type: "tool" }> => ({
    type: "tool",
    toolId: "t",
    name: "mcp__agent-remote__spawn_session",
    args: {},
    status: "done",
    output,
  });
  it("reads the id from a spawn result", () => {
    expect(spawnedSessionId(tool('{"spawnedSession":"abc","status":"running"}'))).toBe("abc");
  });
  it("ignores other output", () => {
    expect(spawnedSessionId(tool())).toBeUndefined();
    expect(spawnedSessionId(tool("Spawn limit reached"))).toBeUndefined();
    expect(spawnedSessionId(tool('{"sessionId":"abc"}'))).toBeUndefined();
    expect(spawnedSessionId(tool('{"spawnedSession": broken'))).toBeUndefined();
  });
});
