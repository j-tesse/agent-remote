// Single source of truth for turning a ChatPart/ChatMessage into displayed HTML.
// ChatView imports these primitives so the UI can't drift; server/chatLog.ts
// calls renderMessage() to capture exactly what the UI produces.

import { Marked } from "marked";
import type { AgentRun, ChatMessage, ChatPart } from "./protocol.js";

export const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// Markdown renderer for assistant text; raw HTML is escaped, not injected.
export const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html({ text }: { text: string }) {
      return escapeHtml(text);
    },
  },
});

/** Render assistant markdown to HTML (synchronous — no async extensions). */
export const renderMarkdown = (text: string): string =>
  md.parse(text, { async: false }) as string;

export const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n)}…` : s;

/** The one-line argument preview shown next to a tool's name. */
export function argsPreview(args: unknown): string {
  if (args && typeof args === "object") {
    // A single primary arg (e.g. bash's `command`) reads better than JSON.
    const values = Object.values(args as Record<string, unknown>);
    if (values.length === 1 && typeof values[0] === "string")
      return values[0] as string;
  }
  try {
    return args === undefined ? "" : JSON.stringify(args);
  } catch {
    return "";
  }
}

/** Last two path segments (`…/dir/file.ts`), for a compact but legible subject. */
export function shortenPath(p: string): string {
  const segs = p.split("/").filter(Boolean);
  return segs.length <= 2 ? p : `…/${segs.slice(-2).join("/")}`;
}

export interface DiffLine {
  sign: " " | "+" | "-";
  text: string;
  /** Intra-line highlights, set on a changed pair only: the row's sign says
   * add/del, `changed` says which runs of it actually differ. */
  words?: DiffWord[];
}
export interface DiffWord {
  text: string;
  changed?: boolean;
}
/** One row of a rendered diff: a line, or a stand-in for lines we don't show. */
export type DiffRow =
  | { kind: "line"; line: DiffLine }
  | { kind: "fold"; count?: number };

/** Unchanged lines kept either side of a change before they are folded away. */
export const DIFF_CONTEXT = 4;

/** One step of an LCS backtrace. `null` = the inputs are too big to diff (O(n·m)). */
type EditOp = { op: " " | "-" | "+"; a: number; b: number };
function editScript(a: string[], b: string[], limit: number): EditOp[] | null {
  if (a.length > limit && b.length > limit) return null;
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: EditOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) out.push({ op: " ", a: i, b: j }), i++, j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: "-", a: i++, b: j });
    else out.push({ op: "+", a: i, b: j++ });
  }
  while (i < n) out.push({ op: "-", a: i++, b: j });
  while (j < m) out.push({ op: "+", a: i, b: j++ });
  return out;
}

/** Minimal LCS line diff of two strings, for rendering an Edit as red/green
 * lines instead of two JSON-escaped blobs. Falls back to a plain remove-all /
 * add-all block when the inputs are large enough that O(n·m) would hurt. */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const ops = editScript(a, b, 500);
  if (!ops)
    return [
      ...a.map((text): DiffLine => ({ sign: "-", text })),
      ...b.map((text): DiffLine => ({ sign: "+", text })),
    ];
  return ops.map((o): DiffLine =>
    o.op === "-"
      ? { sign: "-", text: a[o.a] }
      : o.op === "+"
        ? { sign: "+", text: b[o.b] }
        : { sign: " ", text: a[o.a] },
  );
}

/** Words plus the whitespace between them, so a highlight never eats a space. */
const tokenize = (text: string): string[] => text.match(/\s+|\S+/g) ?? [];

/** Token-level diff of a changed pair, so a one-word change in a long line
 * doesn't paint the whole line. Null when the lines are too big to diff. */
export function wordDiff(
  oldText: string,
  newText: string,
): { old: DiffWord[]; new: DiffWord[] } | null {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  const ops = editScript(a, b, 200);
  if (!ops) return null;
  const old: DiffWord[] = [];
  const added: DiffWord[] = [];
  for (const o of ops) {
    if (o.op !== "+") old.push({ text: a[o.a], changed: o.op === "-" });
    if (o.op !== "-") added.push({ text: b[o.b], changed: o.op === "+" });
  }
  return { old, new: added };
}

/** Attach word-level highlights to every removed line immediately followed by
 * an added one — the rewritten-line case. Multi-line runs stay whole-line. */
export function markWordDiff(lines: DiffLine[]): DiffLine[] {
  const out = lines.slice();
  for (let i = 0; i < out.length - 1; i++) {
    const del = out[i];
    const add = out[i + 1];
    if (del.sign !== "-" || add.sign !== "+") continue;
    const words = wordDiff(del.text, add.text);
    if (!words) continue;
    out[i] = { ...del, words: words.old };
    out[i + 1] = { ...add, words: words.new };
    i++;
  }
  return out;
}

/** PR-review rows: keep a few lines of context around each change, fold the rest
 * into one "N unchanged lines" row. A fold without a count is a hunk break — we
 * know text sits there, not how much (the gaps of a multi-edit call). */
export function diffRows(lines: DiffLine[], context = DIFF_CONTEXT): DiffRow[] {
  // Nothing changed anywhere (a tool result shown as a diff of itself): the
  // whole thing is context, and hiding most of it would show a fold and nothing
  // else. Keep it as it is — the `near` test below can't know this.
  if (!lines.some((l) => l.sign !== " "))
    return lines.map((line) => ({ kind: "line", line }));
  // A short fragment stays whole. The point of a fold is to tame a tool result
  // that runs to a screenful; the same rule applied to a six-line edit context
  // would hide two lines behind a row that says it hid two lines.
  if (lines.length <= context * 4)
    return lines.map((line) => ({ kind: "line", line }));
  const changed = lines.map((l) => l.sign !== " ");
  const rows: DiffRow[] = [];
  let hidden: DiffLine[] = [];
  const flush = () => {
    // Hiding one or two lines saves nothing and reads as a rendering bug, so
    // only a run worth collapsing becomes a fold row.
    if (hidden.length < 2)
      rows.push(...hidden.map((line) => ({ kind: "line" as const, line })));
    else rows.push({ kind: "fold", count: hidden.length });
    hidden = [];
  };
  lines.forEach((line, i) => {
    const near = changed
      .slice(Math.max(0, i - context), i + context + 1)
      .some(Boolean);
    if (near) {
      flush();
      rows.push({ kind: "line", line });
    } else hidden.push(line);
  });
  flush();
  return rows;
}

/** The “…” standing in for context we aren't showing. */
const FOLD_GLYPH = "⋯";

/** The fold row's text. No count means a hunk break, not a measured gap. */
export function diffFoldLabel(count?: number): string {
  if (!count) return FOLD_GLYPH;
  return `${FOLD_GLYPH} ${count} unchanged ${count === 1 ? "line" : "lines"}`;
}

/** One diff row: a fixed +/− gutter (kept out of selected text) then the line,
 * its changed words marked when its pair was diffed at word level. */
export function renderDiffLine(line: DiffLine): string {
  const cls =
    line.sign === "+" ? "diff-add" : line.sign === "-" ? "diff-del" : "diff-ctx";
  const body = line.words
    ? line.words
        .map((w) =>
          w.changed
            ? `<span class="diff-word">${escapeHtml(w.text)}</span>`
            : escapeHtml(w.text),
        )
        .join("")
    : escapeHtml(line.text);
  const mark = `<span class="diff-mark">${escapeHtml(line.sign)}</span>`;
  return `<span class="${cls}">${mark}${body}</span>`;
}

/** Line tallies for the collapsed row, like a PR file list. */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.sign === "+") added++;
    else if (l.sign === "-") removed++;
  }
  return { added, removed };
}

/** How a tool's expanded body should be displayed. */
export type ToolBody =
  { kind: "diff"; path?: string; rows: DiffRow[]; added: number; removed: number }
  | { kind: "code"; label?: string; text: string }
  | { kind: "json"; text: string }
  | { kind: "none" };

/** A tool call's display model — the collapsed summary subject plus how to show
 * its args body. Field-driven (file_path/path, command, old/new_string, content)
 * so it's harness-agnostic: covers claude's Edit/Read/Write/Bash and pi's
 * lowercase read/write/bash alike. Both the HTML renderer here and ChatView's
 * ToolPart consume this, so the UI and the render log can't drift. */
export interface ToolView {
  /** Subject shown next to the tool name (path, command, …). */
  primary: string;
  /** Muted secondary detail (a Bash description, a Read line range). */
  secondary?: string;
  /** Changed-line tally on the collapsed row (diff bodies only). */
  stat?: { added: number; removed: number };
  body: ToolBody;
}

/** The two spellings of "replace this text with that": claude's Edit
 * (`old_string`/`new_string`) and pi's (`oldText`/`newText`, either at the top
 * level or as several in an `edits[]` array). Field-driven, so an MCP tool doing
 * the same thing is covered too. An empty side is legal (create / delete). */
function editPair(
  o: Record<string, unknown>,
): { oldText: string; newText: string } | null {
  const oldText = o.old_string ?? o.oldText;
  const newText = o.new_string ?? o.newText;
  return typeof oldText === "string" && typeof newText === "string"
    ? { oldText, newText }
    : null;
}

/** Every replacement a call makes: one, or the several of pi's `edits[]`. */
function editPairs(
  a: Record<string, unknown>,
): { oldText: string; newText: string }[] | null {
  const single = editPair(a);
  if (single) return [single];
  if (!Array.isArray(a.edits)) return null;
  const pairs = a.edits.flatMap((e) =>
    e && typeof e === "object" ? [editPair(e as Record<string, unknown>)] : [],
  ).filter((p): p is { oldText: string; newText: string } => p !== null);
  return pairs.length ? pairs : null;
}

/** One replacement's lines. An empty side is a pure insert/delete: diffing ""
 * against text would otherwise show the empty string as a removed blank line. */
function pairLines(p: { oldText: string; newText: string }): DiffLine[] {
  if (p.oldText === "")
    return p.newText.split("\n").map((text): DiffLine => ({ sign: "+", text }));
  if (p.newText === "")
    return p.oldText.split("\n").map((text): DiffLine => ({ sign: "-", text }));
  return markWordDiff(lineDiff(p.oldText, p.newText));
}

/** A diff body from one or more replacements. Several ones sit as separate hunks
 * with a count-less fold between them (their gap in the file is unknown). */
function diffBody(
  path: string | undefined,
  pairs: { oldText: string; newText: string }[],
): Extract<ToolBody, { kind: "diff" }> {
  const hunks = pairs.map(pairLines);
  const rows: DiffRow[] = [];
  hunks.forEach((lines, i) => {
    // Folded per hunk, not across all of them: an edit high in the file and one
    // low in it are separate gaps, and one of them being long shouldn't hide the
    // other's context.
    const folded = diffRows(lines);
    // The break row only separates. If a fold already borders the join — the
    // tail of the previous hunk or this hunk's own elided lead — it reads as the
    // break, and stacking a second one on top is noise.
    const gap = rows[rows.length - 1]?.kind === "fold" || folded[0]?.kind === "fold";
    if (i && !gap) rows.push({ kind: "fold" });
    rows.push(...folded);
  });
  return { kind: "diff", path, rows, ...diffStats(hunks.flat()) };
}

export function toolView(
  part: Extract<ChatPart, { type: "tool" }>,
): ToolView {
  const a = (part.args ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" ? v : undefined;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" ? v : undefined;
  const filePath = str(a.file_path) ?? str(a.path);
  const command = str(a.command);
  const description = str(a.description);
  const content = str(a.content);
  const offset = num(a.offset);
  const limit = num(a.limit);

  // Edit-like: a string replacement in a file → show a diff.
  const edits = editPairs(a);
  if (edits) {
    const body = diffBody(filePath, edits);
    return {
      primary: filePath ? shortenPath(filePath) : "edit",
      secondary: edits.length > 1 ? `${edits.length} edits` : undefined,
      stat:
        body.kind === "diff"
          ? { added: body.added, removed: body.removed }
          : undefined,
      body,
    };
  }
  // Write-like: new file content → show it as a code block, not JSON.
  if (content !== undefined)
    return {
      primary: filePath ? shortenPath(filePath) : "write",
      body: { kind: "code", label: filePath, text: content },
    };
  // Bash-like: a shell command. When the harness supplies a description of the
  // command's intent (claude does; pi doesn't), lead the body with it as a
  // colon-terminated first line, then the command on the following lines.
  if (command !== undefined)
    return {
      primary: truncate(command.replace(/\s+/g, " "), 80),
      secondary: description,
      body: {
        kind: "code",
        text: description ? `${description}:\n${command}` : command,
      },
    };
  // Read-like: a path with an optional line range; output carries the content.
  // Skip when the call is really a search (Grep/Glob carry `path` alongside a
  // `pattern`/`query`) — those render better through the field-driven subject.
  if (
    filePath !== undefined &&
    str(a.pattern) === undefined &&
    str(a.query) === undefined
  ) {
    const range =
      offset !== undefined
        ? `lines ${offset}${limit !== undefined ? `–${offset + limit}` : "+"}`
        : limit !== undefined
          ? `first ${limit} lines`
          : undefined;
    return { primary: shortenPath(filePath), secondary: range, body: { kind: "none" } };
  }
  // Any other tool (ToolSearch, WebFetch/WebSearch, Agent, Skill, Grep/Glob,
  // Task*, NotebookEdit, MCP tools, …): derive a legible subject from a
  // recognized arg field instead of dumping raw JSON. Field-driven, not
  // tool-name-driven, so custom/MCP tools are covered too; full args stay in
  // the body.
  let primaryField: string | undefined;
  let primaryVal: string | undefined;
  for (const f of SUBJECT_FIELDS) {
    const v = str(a[f]);
    if (v !== undefined) {
      primaryField = f;
      primaryVal = v;
      break;
    }
  }
  // No known field? Use the first string value so the subject is still legible.
  if (primaryVal === undefined)
    for (const [k, v] of Object.entries(a))
      if (typeof v === "string") {
        primaryField = k;
        primaryVal = v;
        break;
      }
  let secondaryVal: string | undefined;
  for (const f of SECONDARY_FIELDS) {
    if (f === primaryField) continue;
    const v = str(a[f]);
    if (v !== undefined) {
      secondaryVal = v;
      break;
    }
  }
  return {
    primary: primaryVal !== undefined ? subject(primaryVal) : "",
    secondary: secondaryVal !== undefined ? subject(secondaryVal) : undefined,
    body:
      part.args !== undefined
        ? { kind: "json", text: JSON.stringify(part.args, null, 2) }
        : { kind: "none" },
  };
}

/** Fields (in priority order) whose value makes the best collapsed subject for
 * an otherwise-unrecognized tool. Ordered so the most identifying arg wins:
 * `query` (ToolSearch/WebSearch), `url` (WebFetch), `pattern` (Grep/Glob),
 * `skill` (Skill), `description`/`subagent_type` (Agent), `task_id` (Task*),
 * `notebook_path` (NotebookEdit), etc. */
const SUBJECT_FIELDS = [
  "query",
  "url",
  "pattern",
  "description",
  "prompt",
  "skill",
  "command_name",
  "name",
  "title",
  "subagent_type",
  "notebook_path",
  "task_id",
  "taskId",
  "id",
  "message",
];

/** A muted second detail, when present and distinct from the primary field. */
const SECONDARY_FIELDS = [
  "subagent_type",
  "path",
  "glob",
  "status",
  "args",
  "prompt",
  "description",
];

/** Collapse whitespace and shorten a raw arg value into a one-line subject:
 * path-like values get their last two segments, others are truncated to 80. */
function subject(v: string): string {
  const s = v.replace(/\s+/g, " ").trim();
  return s.includes("/") && !s.includes(" ")
    ? truncate(shortenPath(s), 80)
    : truncate(s, 80);
}

/** The HTML for a tool body (mirrors ChatView's ToolBody rendering). */
function renderToolBody(body: ToolBody): string {
  switch (body.kind) {
    case "none":
      return "";
    case "json":
      return `<pre class="chat-tool-args">${escapeHtml(body.text)}</pre>`;
    case "code":
      return (
        `<div class="chat-tool-body">` +
        (body.label
          ? `<div class="chat-tool-path">${escapeHtml(body.label)}</div>`
          : "") +
        `<pre class="chat-tool-code">${escapeHtml(body.text)}</pre></div>`
      );
    case "diff": {
      // Path + "+N −M" header, the way a PR shows each changed file. Always
      // present: a diff body without one leaves the hunk orphaned.
      const head =
        `<div class="chat-tool-path chat-diff-head">` +
        `<span class="chat-diff-path">${escapeHtml(body.path ?? "edit")}</span>` +
        `<span class="chat-diff-stats">` +
        `<span class="diff-add">+${body.added}</span>` +
        `<span class="diff-del">−${body.removed}</span></span></div>`;
      // Row spans are display:block (see CSS) so they line-break themselves — no
      // newline separators, which in a <pre> would double-space the diff.
      const rows = body.rows
        .map((row) =>
          row.kind === "fold"
            ? `<span class="diff-fold">${escapeHtml(diffFoldLabel(row.count))}</span>`
            : renderDiffLine(row.line),
        )
        .join("");
      return (
        `<div class="chat-tool-body">${head}` +
        `<pre class="chat-tool-diff">${rows}</pre></div>`
      );
    }
  }
}

/** Status glyph shown on a tool part (matches ChatView's ToolPart). */
export function toolGlyph(status: string): string {
  return status === "done"
    ? "✓"
    : status === "error"
      ? "✕"
      : status === "running"
        ? "●"
        : "○";
}

/** One part's rendered form: which UI code path handles it, the top-level CSS
 * class the UI applies, and the HTML that path produces. */
export interface RenderedPart {
  type: ChatPart["type"];
  /** The React component / branch in ChatView that renders this part. */
  component: string;
  /** Top-level CSS class the UI applies to this part. */
  className: string;
  /** The HTML the UI produces for this part. */
  html: string;
}

/** A whole message's rendered form: the bubble class plus each part's HTML. */
export interface RenderedMessage {
  id: string;
  role: ChatMessage["role"];
  /** Class on the outer chat bubble. */
  bubbleClassName: string;
  parts: RenderedPart[];
  /** Concatenated part HTML — the bubble's inner HTML. */
  html: string;
}

/** One display group of an assistant message: a run of prose parts sharing a
 * bubble, or a single tool call standing as its own bubble. */
export type PartGroup =
  | { kind: "prose"; key: string; parts: ChatPart[] }
  | { kind: "tool"; key: string; part: Extract<ChatPart, { type: "tool" }> };

/** Split an assistant message into display groups. A turn is overwhelmingly
 * either prose or a tool call, so a tool gets its own bubble rather than a card
 * nested inside a near-empty one; a mixed turn just becomes several bubbles. */
export function groupParts(parts: ChatPart[]): PartGroup[] {
  const groups: PartGroup[] = [];
  parts.forEach((part, i) => {
    if (part.type === "tool") {
      // Keyed by toolId so React keeps its <details> open state as the turn grows.
      groups.push({ kind: "tool", key: `tool-${part.toolId}`, part });
      return;
    }
    const last = groups[groups.length - 1];
    if (last?.kind === "prose") last.parts.push(part);
    else groups.push({ kind: "prose", key: `prose-${i}`, parts: [part] });
  });
  return groups;
}

/** What a bubble's copy button puts on the clipboard: the raw markdown, not the
 * rendered HTML. Thinking is skipped unless it's all the bubble holds; images
 * become a `[image: name]` placeholder (their URL is auth-gated, useless elsewhere). */
export function copyText(parts: ChatPart[]): string {
  const pick = (types: ChatPart["type"][]) =>
    parts
      .flatMap((p) => {
        if (!types.includes(p.type)) return [];
        if (p.type === "text" || p.type === "thinking") return [p.text.trim()];
        if (p.type === "image") return [`[image: ${p.name ?? "image"}]`];
        return [];
      })
      .filter(Boolean)
      .join("\n\n");
  return pick(["text", "image"]) || pick(["thinking"]);
}

/** A page of prose, for the collapsed thinking summary's unit switch. */
export const WORDS_PER_PAGE = 500;
/** Past this many pages a word count stops being at a glance readable, so count
 * pages instead (600 words is a wall of text; "1.2 pages" isn't). */
export const PAGES_FROM = 1.2;

/** How much text there is: in words, or in pages once there are enough of them.
 * The collapsed thinking bubble leads with this — it's how much reading you're
 * opting out of before opening it. */
export function thoughtAmount(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (!words) return "";
  if (words < WORDS_PER_PAGE * PAGES_FROM)
    return `${words} ${words === 1 ? "word" : "words"}`;
  const pages = words / WORDS_PER_PAGE;
  // One decimal up to ten pages; past that the fraction is noise.
  const shown =
    pages < 10 ? (Math.round(pages * 10) / 10).toFixed(1) : String(Math.round(pages));
  return `${shown} pages`;
}

/** The collapsed thinking bubble's summary: what it is, and how much of it.
 * `live` while the model is still reasoning, so the count climbs as it types. */
export function thinkingSummary(
  text: string,
  live = false,
): { label: string; amount: string } {
  return { label: live ? "Thinking…" : "Thought for", amount: thoughtAmount(text) };
}

/** Render one part to the HTML the UI shows (see ChatView's Bubble/ToolPart).
 * `standalone` marks a tool that is its own bubble rather than nested in one
 * (the permission card embeds a nested one). */
export function renderPart(
  part: ChatPart,
  standalone = false,
  agents?: Record<string, AgentRun>,
): RenderedPart {
  switch (part.type) {
    case "text":
      return {
        type: "text",
        component: "Markdown",
        className: "chat-md",
        html: `<div class="chat-md">${renderMarkdown(part.text)}</div>`,
      };
    case "thinking": {
      // No reasoning text (claude) → a plain live "Thinking…" label; with text
      // (pi) → the collapsible transcript, collapsed to a label saying how much
      // reading it is. Mirrors ChatView's Bubble. Note the reducer strips empty
      // thinking parts once the next part starts, so the label form is mostly
      // transient and rarely lands in the render log.
      if (part.text.trim() === "")
        return {
          type: "thinking",
          component: "ThinkingPart",
          className: "chat-thinking-label",
          html: `<div class="chat-thinking-label">Thinking…</div>`,
        };
      const s = thinkingSummary(part.text);
      return {
        type: "thinking",
        component: "ThinkingPart",
        className: "chat-thinking",
        html:
          `<details class="chat-thinking"><summary>${escapeHtml(s.label)}` +
          (s.amount
            ? `<span class="chat-thinking-count">${escapeHtml(s.amount)}</span>`
            : "") +
          `</summary><div>${escapeHtml(part.text)}</div></details>`,
      };
    }
    case "image":
      return {
        type: "image",
        component: "ImagePart",
        className: "chat-image",
        html:
          `<img class="chat-image" src="${escapeHtml(part.url)}"` +
          ` alt="${escapeHtml(part.name ?? "image")}" loading="lazy" />`,
      };
    case "tool": {
      const glyph = toolGlyph(part.status);
      const view = toolView(part);
      const summary =
        `<summary><span class="chat-tool-glyph">${glyph}</span>` +
        `<span class="chat-tool-name">${escapeHtml(part.name)}</span>` +
        (view.primary
          ? `<span class="chat-tool-preview">${escapeHtml(view.primary)}</span>`
          : "") +
        (view.secondary
          ? `<span class="chat-tool-desc">${escapeHtml(view.secondary)}</span>`
          : "") +
        // Same collapsed +N −M tally ChatView shows, so the render log matches.
        (view.stat
          ? `<span class="chat-tool-stats">` +
            `<span class="diff-add">+${view.stat.added}</span>` +
            `<span class="diff-del">−${view.stat.removed}</span></span>`
          : "") +
        `</summary>`;
      const cls = standalone ? "chat-tool standalone" : "chat-tool";
      // A tool that spawned a sub-agent shows that agent's own chat session
      // instead of its args and a <pre> of the report — the report is already
      // the last nested bubble (see the reducer's agent-done).
      // An empty run keeps the ordinary tool view: the panel would say nothing
      // while the tool's own output (e.g. a background agent's launch stub) is
      // the only information there is.
      const run = agents?.[part.toolId];
      const nested = run && (run.loading || run.state.messages.length > 0);
      const inner = nested
        ? renderAgentPanel(run, agents ?? {}, agentPrompt(part))
        : renderToolBody(view.body) +
          (part.output
            ? `<pre class="chat-tool-output">${escapeHtml(part.output)}</pre>`
            : "");
      return {
        type: "tool",
        component: nested ? "AgentPart" : "ToolPart",
        className: cls,
        html: `<details class="${cls}" data-status="${part.status}">${summary}${inner}</details>`,
      };
    }
  }
}

/** Render a whole message the way ChatView's Bubble does. User bubbles show the
 * joined text of their text parts as plain (escaped) text; assistant bubbles
 * render each part. */
/** The task a sub-agent was given, from the spawning tool's own args. Neither
 * the live stream nor `getSubagentMessages` carries the sub-agent's opening user
 * message (it's the sidechain root), so the panel would otherwise start
 * mid-conversation — we already hold the prompt right here. */
export function agentPrompt(part: Extract<ChatPart, { type: "tool" }>): string {
  const prompt = (part.args as { prompt?: unknown } | undefined)?.prompt;
  return typeof prompt === "string" ? prompt : "";
}

/** The sub-agent's transcript as a scrollable panel of full turns, opening with
 * the task it was given. Recursion carries the flat root map through, so an
 * agent inside an agent nests again. */
function renderAgentPanel(
  run: AgentRun,
  agents: Record<string, AgentRun>,
  prompt = "",
): string {
  if (run.state.messages.length === 0)
    return `<div class="chat-agent empty">Loading transcript…</div>`;
  const opening = prompt
    ? `<div class="chat-turn user"><div class="chat-bubble user"><div class="chat-md">${renderMarkdown(prompt)}</div></div></div>`
    : "";
  const turns = run.state.messages
    .map((m) => {
      const rendered = renderMessage(m, agents);
      if (m.role === "system") return rendered.html; // already a standalone line
      return m.role === "user"
        ? `<div class="chat-turn user"><div class="chat-bubble user">${rendered.html}</div></div>`
        : `<div class="chat-turn assistant">${rendered.html}</div>`;
    })
    .join("");
  return `<div class="chat-agent">${opening}${turns}</div>`;
}

export function renderMessage(
  message: ChatMessage,
  agents?: Record<string, AgentRun>,
): RenderedMessage {
  // Neither party authored this one (a background-task notification, a peer
  // message). Muted single line in transcript order — it explains the reply that
  // follows without ever looking like something the user typed.
  if (message.role === "system") {
    const text = message.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("");
    const html = `<div class="chat-system">${escapeHtml(text)}</div>`;
    return {
      id: message.id,
      role: "system",
      bubbleClassName: "chat-system",
      parts: [
        { type: "text", component: "SystemPart", className: "chat-system", html },
      ],
      html,
    };
  }
  if (message.role === "user") {
    const text = message.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("");
    const images = message.parts.filter(
      (p): p is Extract<ChatPart, { type: "image" }> => p.type === "image",
    );
    // Markdown, same as an assistant bubble: prompts routinely carry lists,
    // code spans and paths, and raw HTML is escaped by the shared renderer.
    const textHtml = text ? `<div class="chat-md">${renderMarkdown(text)}</div>` : "";
    const imageHtml = images.map((p) => renderPart(p).html).join("");
    const html = textHtml + imageHtml;
    return {
      id: message.id,
      role: "user",
      bubbleClassName: "chat-bubble user",
      parts: [
        { type: "text", component: "Bubble", className: "chat-bubble user", html },
      ],
      html,
    };
  }
  // An assistant turn is a row of bubbles, not one: prose runs get a bubble
  // each, tool calls stand alone. `html` carries those wrappers so the render
  // log matches what ChatView actually shows.
  const parts: RenderedPart[] = [];
  const html = groupParts(message.parts)
    .map((g) => {
      if (g.kind === "tool") {
        const rendered = renderPart(g.part, true, agents);
        parts.push(rendered);
        return rendered.html;
      }
      const inner = g.parts
        .map((p) => {
          const rendered = renderPart(p);
          parts.push(rendered);
          return rendered.html;
        })
        .join("");
      return `<div class="chat-bubble assistant">${inner}</div>`;
    })
    .join("");
  return {
    id: message.id,
    role: "assistant",
    bubbleClassName: "chat-turn assistant",
    parts,
    html,
  };
}
