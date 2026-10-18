import { randomUUID } from "node:crypto";
import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessConfig } from "../config.js";
import type {
  ChatAction,
  ChatEvent,
  ChatMode,
  ChatUiOption,
  ChatUiRequest,
} from "../../shared/protocol.js";
import type { ChatTranslator, HarnessAdapter, SessionOptions } from "./types.js";

// Adapter for aider (https://aider.chat). Aider has no RPC mode, so a Python
// bridge (aider-bridge.py) drives its scripting API under aider's own
// interpreter and speaks a small JSONL protocol. ALL aider vocabulary lives in
// this file + the bridge; the translator maps it onto the chat schema. The
// interesting half is the reply stream: aider edits files with SEARCH/REPLACE
// blocks inside its prose, which `AiderReplyParser` lifts into `Edit` tool
// parts so they render as diffs via the shared `toolView`.

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), "aider-bridge.py");

/** Fixed flags: the SEARCH/REPLACE format we parse, and no TTY/desktop affordances
 * (pretty output, prompt_toolkit, update/analytics prompts, .gitignore edits).
 * `cfg.args` comes after, so a user can still override (argparse: last wins). */
export const AIDER_ARGS = [
  "--edit-format", "diff-fenced",
  "--editor-edit-format", "editor-diff-fenced",
  "--no-pretty",
  "--no-fancy-input",
  "--no-check-update",
  "--no-show-release-notes",
  "--no-analytics",
  "--no-gitignore",
  "--no-notifications",
];

export function createAiderAdapter(cfg: HarnessConfig): HarnessAdapter {
  // The bridge must import aider, so it runs under the interpreter aider's own
  // launcher names (uv/pipx install it into a private venv).
  const python = resolveAiderPython(cfg.command);
  console.log(
    python
      ? `[aider] using ${python} (from "${cfg.command}")`
      : `[aider] "${cfg.command}" not found or not a Python launcher; trying python3`,
  );
  return {
    id: "aider",
    name: "Aider",
    invocation(_opts: SessionOptions) {
      return {
        command: python ?? "python3",
        args: ["-u", BRIDGE, ...AIDER_ARGS, ...(cfg.args ?? [])],
        env: cfg.env,
      };
    },
    createChatTranslator(): ChatTranslator {
      return new AiderTranslator();
    },
  };
}

// --- interpreter discovery ---------------------------------------------------

/** Interpreter named by a launcher's shebang (`#!/venv/bin/python`,
 * `#!/usr/bin/env python3`), or undefined if it isn't a Python launcher. */
export function shebangPython(firstLine: string): string | undefined {
  const m = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(firstLine);
  if (!m) return undefined;
  const [, prog, arg] = m;
  const interp = prog.endsWith("/env") ? arg : prog;
  return interp && /python[\d.]*$/.test(interp) ? interp : undefined;
}

function resolveAiderPython(command: string): string | undefined {
  const onPath = (): string | undefined => {
    if (command.includes("/")) return isAbsolute(command) ? command : join(process.cwd(), command);
    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
      const p = join(dir, command);
      try {
        accessSync(p, constants.X_OK);
        return p;
      } catch {
        /* keep looking */
      }
    }
    return undefined;
  };
  try {
    const launcher = onPath();
    if (!launcher) return undefined;
    const head = readFileSync(realpathSync(launcher), "utf8").slice(0, 512);
    return shebangPython(head.split("\n")[0]);
  } catch {
    return undefined;
  }
}

// --- wire shapes ---------------------------------------------------------------

interface BridgeLine {
  type?: string;
  text?: string;
  level?: "info" | "warning" | "error";
  // hello / coder
  model?: string;
  editFormat?: string;
  mode?: string;
  modes?: string[];
  reasoningTags?: string[];
  commands?: { name?: string; description?: string }[];
  announcements?: string[];
  // reply_start / reply_end
  reflection?: string;
  applied?: boolean;
  written?: string[];
  error?: string | null;
  content?: string | null;
  // confirm / ask
  id?: string;
  question?: string;
  subject?: string | null;
  group?: boolean;
  explicitYes?: boolean;
  allowNever?: boolean;
  default?: string;
}

const MODE_INFO: Record<string, Omit<ChatMode, "id">> = {
  code: { label: "Code", description: "Edit files with SEARCH/REPLACE blocks" },
  ask: { label: "Ask", description: "Answer questions without editing files" },
  architect: {
    label: "Architect",
    description: "Main model plans, editor model writes the edits",
  },
};

// aider's per-reply chatter that the transcript already shows another way.
const DROP_INFO = [/^Tokens: /, /^Applied edit to /, /^Did not apply edit /];

export class AiderTranslator implements ChatTranslator {
  private lineBuffer = "";
  private tags: string[] = [];
  /** No turn may start before `hello`, so prompts sent during startup queue. */
  private ready = false;
  private busy = false;
  private queued: string[] = [];
  private reply: AiderReplyParser | null = null;
  private openCards = new Set<string>();
  /** Info lines printed outside a reply: a command's output (/ls, /tokens…). */
  private turnOutput: string[] = [];
  private turnHadReply = false;
  /** Startup chatter before `hello`, folded into the announcement notice. */
  private startupInfo: string[] = [];
  private mode: string | null = null;

  push(chunk: string): ChatEvent[] {
    this.lineBuffer += chunk;
    const events: ChatEvent[] = [];
    for (;;) {
      const nl = this.lineBuffer.indexOf("\n");
      if (nl === -1) break;
      const line = this.lineBuffer.slice(0, nl).replace(/\r$/, "");
      this.lineBuffer = this.lineBuffer.slice(nl + 1);
      if (!line) continue;
      let parsed: BridgeLine;
      try {
        parsed = JSON.parse(line) as BridgeLine;
      } catch {
        continue;
      }
      events.push(...this.translate(parsed));
    }
    return events;
  }

  encode(action: ChatAction): { data: string; events: ChatEvent[] } {
    const send = (msg: object) => `${JSON.stringify(msg)}\n`;
    switch (action.type) {
      case "prompt": {
        const events: ChatEvent[] = [];
        if (action.images?.length)
          events.push({
            type: "notice",
            level: "warning",
            text: "Aider sessions don't accept pasted images; sent the text only.",
          });
        // The user bubble is emitted on `turn_start`, not here: aider can't
        // steer, so a prompt sent mid-turn runs after it and must sit in the
        // queue rather than land in the transcript out of order.
        if (this.busy || !this.ready) {
          this.queued.push(action.text);
          events.push({ type: "queue", queued: [...this.queued] });
        }
        return { data: send({ type: "prompt", text: action.text }), events };
      }
      case "abort":
        return { data: send({ type: "abort" }), events: [] };
      case "ui-response": {
        this.openCards.delete(action.requestId);
        return {
          data: send({
            type: "ui_response",
            id: action.requestId,
            ...(action.cancelled ? { cancelled: true } : {}),
            ...(action.value !== undefined ? { value: action.value } : {}),
          }),
          events: [{ type: "ui-request-done", requestId: action.requestId }],
        };
      }
      case "set-mode":
        return { data: send({ type: "set_mode", mode: action.mode }), events: [] };
      default:
        return { data: "", events: [] };
    }
  }

  private translate(line: BridgeLine): ChatEvent[] {
    switch (line.type) {
      case "hello":
      case "coder":
        return this.coderInfo(line);
      case "turn_start": {
        this.busy = true;
        this.turnOutput = [];
        this.turnHadReply = false;
        const text = line.text ?? "";
        const events: ChatEvent[] = [{ type: "busy", busy: true }];
        const i = this.queued.indexOf(text);
        if (i !== -1) {
          this.queued.splice(i, 1);
          events.push({ type: "queue", queued: [...this.queued] });
        }
        events.push({
          type: "user-message",
          message: {
            id: randomUUID(),
            role: "user",
            parts: [{ type: "text", text }],
            createdAt: Date.now(),
          },
        });
        return events;
      }
      case "reply_start": {
        const events: ChatEvent[] = [];
        if (this.reply) events.push(...this.closeReply({}));
        this.turnHadReply = true;
        if (line.reflection)
          events.push({
            type: "user-message",
            message: {
              id: randomUUID(),
              role: "system",
              parts: [{ type: "text", text: `Aider: ${firstLine(line.reflection)}` }],
              createdAt: Date.now(),
            },
          });
        this.reply = new AiderReplyParser(this.tags);
        events.push({ type: "assistant-start", messageId: randomUUID() });
        return events;
      }
      case "delta":
        return this.reply && line.text ? this.reply.push(line.text) : [];
      case "reply_end":
        return this.closeReply(line);
      case "output":
        return this.output(line);
      case "confirm":
        return line.id ? this.card(confirmRequest(line)) : [];
      case "ask":
        return line.id
          ? this.card({
              id: line.id,
              kind: "input",
              title: line.question ?? "Aider asks",
              message: line.subject ?? undefined,
              placeholder: line.default || undefined,
            })
          : [];
      case "queue_cleared":
        this.queued = [];
        return [{ type: "queue", queued: [] }];
      case "turn_end": {
        const events: ChatEvent[] = [];
        if (this.reply) events.push(...this.closeReply({}));
        // An interrupted wait leaves its card behind; nothing will answer it now.
        for (const id of this.openCards) events.push({ type: "ui-request-done", requestId: id });
        this.openCards.clear();
        const out = this.turnOutput.join("\n").replace(/^\n+|\s+$/g, "");
        this.turnOutput = [];
        if (out && !this.turnHadReply) {
          // A pure command (/ls, /tokens, /diff…): its output IS the reply.
          events.push(
            { type: "assistant-start", messageId: randomUUID() },
            { type: "part-start", kind: "text" },
            { type: "part-delta", kind: "text", delta: fenced(out) },
            { type: "assistant-end" },
          );
        } else if (out) events.push({ type: "notice", level: "info", text: out });
        this.busy = false;
        events.push({ type: "busy", busy: false });
        return events;
      }
      case "fatal":
        return [{ type: "notice", level: "error", text: line.error ?? "aider failed to start" }];
      default:
        return [];
    }
  }

  private coderInfo(line: BridgeLine): ChatEvent[] {
    const events: ChatEvent[] = [];
    this.tags = (line.reasoningTags ?? []).filter((t) => /^[\w.-]+$/.test(t));
    if (line.type === "hello") this.ready = true;
    events.push({
      type: "commands",
      commands: (line.commands ?? [])
        .filter((c): c is { name: string; description?: string } => !!c.name)
        .map((c) => ({ name: c.name, description: c.description || undefined })),
    });
    const modes = (line.modes ?? []).map((id) => ({ id, ...(MODE_INFO[id] ?? { label: id }) }));
    if (modes.length) events.push({ type: "modes", modes, current: line.mode ?? null });
    else if (line.mode && line.mode !== this.mode)
      events.push({ type: "mode-changed", current: line.mode });
    this.mode = line.mode ?? this.mode;
    const lines = [...this.startupInfo, ...(line.announcements ?? [])].filter((l) => l.trim());
    this.startupInfo = [];
    if (lines.length) events.push({ type: "notice", level: "info", text: lines.join("\n") });
    return events;
  }

  private output(line: BridgeLine): ChatEvent[] {
    const raw = (line.text ?? "").replace(/\s+$/, "");
    const text = raw.trim();
    if (!text) return [];
    if (line.level === "error" || line.level === "warning")
      return [{ type: "notice", level: line.level, text }];
    if (DROP_INFO.some((re) => re.test(text))) return [];
    // A commit is worth a marker in the transcript; the rest of a reply's
    // chatter (repo-map, edit-error doc links) isn't.
    if (this.reply) return /^Commit [0-9a-f]{7,}/.test(text) ? [{ type: "notice", level: "info", text }] : [];
    if (!this.ready) this.startupInfo.push(text);
    else if (this.busy) this.turnOutput.push(raw);
    else return [{ type: "notice", level: "info", text }];
    return [];
  }

  private card(request: ChatUiRequest): ChatEvent[] {
    this.openCards.add(request.id);
    return [{ type: "ui-request", request }];
  }

  private closeReply(line: BridgeLine): ChatEvent[] {
    const reply = this.reply;
    if (!reply) return [];
    this.reply = null;
    const events: ChatEvent[] = [];
    if (line.content) events.push(...reply.push(line.content));
    events.push(...reply.end());
    for (const edit of reply.edits) {
      const r = editOutcome(edit, {
        applied: line.applied === true,
        written: line.written ?? [],
        error: line.error ?? null,
      });
      events.push({ type: "tool-end", toolId: edit.toolId, ...r });
    }
    events.push({ type: "assistant-end" });
    return events;
  }
}

function confirmRequest(line: BridgeLine): ChatUiRequest {
  const options: ChatUiOption[] = [{ value: "y", label: "Yes", intent: "accept" }];
  if (line.group && !line.explicitYes)
    options.push({ value: "a", label: "Yes to all", intent: "always" });
  options.push({ value: "n", label: "No", intent: "cancel" });
  if (line.group) options.push({ value: "s", label: "Skip all", intent: "cancel" });
  if (line.allowNever) options.push({ value: "d", label: "Don't ask again", intent: "cancel" });
  const question = line.question ?? "Aider asks";
  const subject = line.subject ?? undefined;
  // Give the card the same rich view the transcript uses where we can.
  const tool = subject && /^Run shell commands?\?/.test(question)
    ? { name: "Bash", args: { command: subject } }
    : undefined;
  return {
    id: line.id as string,
    kind: "select",
    title: question,
    message: tool ? undefined : subject,
    options,
    tool,
  };
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  const t = line.replace(/^#+\s*/, "").trim();
  return t.length > 200 ? `${t.slice(0, 199)}…` : t;
}

function fenced(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

// --- reply stream → parts ---------------------------------------------------------

export interface AiderEdit {
  toolId: string;
  path: string;
  search: string;
  replace: string;
}

// Same markers aider's own parser accepts (editblock_coder.py HEAD/DIVIDER/UPDATED).
const HEAD = /^<{5,9} SEARCH>?\s*$/;
const DIVIDER = /^={5,9}\s*$/;
const UPDATED = /^>{5,9} REPLACE\s*$/;
// A partial line that may still turn into HEAD.
const HEAD_PREFIX = /^<{1,9}(?: (?:S(?:E(?:A(?:R(?:C(?:H>?)?)?)?)?)?)?)?$/;

const isFence = (line: string) => line.trimStart().startsWith("```");
const isFenceOnly = (line: string) => /^\s*`{3,}\s*$/.test(line);

/** Mirrors aider's `strip_filename`: the path a header line names, if any. */
export function stripFilename(line: string): string | undefined {
  let f = line.trim();
  if (f === "...") return undefined;
  if (f.startsWith("```")) {
    const c = f.replace(/^`+/, "");
    return c && (c.includes(".") || c.includes("/")) ? c : undefined;
  }
  f = f.replace(/:+$/, "").replace(/^#+/, "").trim();
  f = f.replace(/^`+|`+$/g, "").replace(/^\*+|\*+$/g, "");
  return f || undefined;
}

/** Could this line still be part of a block header (blank / fence / filename)?
 * Such lines are held back until we know, so a header never flashes as prose. */
function holdable(line: string, partial: boolean): boolean {
  const t = line.trim();
  if (!t) return true;
  // A fence (or a partial one: "`", "``") with an optional info string.
  if (t.startsWith("`") && !/\s/.test(t)) return true;
  if (partial && HEAD_PREFIX.test(t)) return true;
  const core = t.replace(/^#+\s*/, "").replace(/:+$/, "").replace(/^[`*]+|[`*]+$/g, "");
  return core.length > 0 && core.length <= 200 && !/\s/.test(core);
}

/** Streams one aider reply into chat events: reasoning (aider's tag wrapper)
 * → thinking parts, SEARCH/REPLACE blocks → `Edit` tool calls, everything else
 * → text. Lines that might open a block are held back briefly; prose streams
 * through as it arrives. */
export class AiderReplyParser {
  readonly edits: AiderEdit[] = [];
  private kind: "text" | "thinking" | "tool" | null = null;
  // tag layer
  private raw = "";
  private thinking = false;
  // line layer
  private line = "";
  private committed = false;
  private held: string[] = [];
  private block: { path: string; phase: "search" | "replace"; search: string[]; replace: string[]; header: string[] } | null = null;
  private lastPath: string | undefined;
  private dropFence = false;
  private out: ChatEvent[] = [];

  constructor(private readonly tags: string[] = []) {}

  push(text: string): ChatEvent[] {
    this.raw += text;
    this.drainTags(false);
    return this.take();
  }

  end(): ChatEvent[] {
    this.drainTags(true);
    this.endLines();
    return this.take();
  }

  private take(): ChatEvent[] {
    const out = this.out;
    this.out = [];
    return out;
  }

  // --- tag layer: <tag>…</tag> → thinking ---

  private drainTags(final: boolean) {
    for (;;) {
      // aider opens with its own tag but may close with the model's, so any
      // configured tag name matches either side.
      const marks = this.tags.map((t) => (this.thinking ? `</${t}>` : `<${t}>`));
      let at = -1;
      let len = 0;
      for (const m of marks) {
        const i = this.raw.indexOf(m);
        if (i !== -1 && (at === -1 || i < at)) [at, len] = [i, m.length];
      }
      if (at === -1) {
        // Hold a tail that may be the start of a tag split across deltas.
        let keep = 0;
        if (!final)
          for (const m of marks)
            for (let n = Math.min(m.length - 1, this.raw.length); n > keep; n--)
              if (this.raw.endsWith(m.slice(0, n))) keep = n;
        this.route(this.raw.slice(0, this.raw.length - keep));
        this.raw = this.raw.slice(this.raw.length - keep);
        return;
      }
      this.route(this.raw.slice(0, at));
      this.raw = this.raw.slice(at + len);
      this.thinking = !this.thinking;
      if (this.thinking) this.flushLines();
    }
  }

  private route(text: string) {
    if (!text) return;
    if (!this.thinking) return this.feed(text);
    // aider pads its tags with blank lines.
    const delta = this.kind === "thinking" ? text : text.replace(/^\s+/, "");
    if (!delta) return;
    if (this.kind !== "thinking") this.out.push({ type: "part-start", kind: "thinking" });
    this.kind = "thinking";
    this.out.push({ type: "part-delta", kind: "thinking", delta });
  }

  // --- line layer: SEARCH/REPLACE → Edit ---

  private emitText(text: string) {
    if (!text) return;
    if (this.kind !== "text") this.out.push({ type: "part-start", kind: "text" });
    this.kind = "text";
    this.out.push({ type: "part-delta", kind: "text", delta: text });
  }

  private flushHeld() {
    for (const l of this.held) this.emitText(`${l}\n`);
    this.held = [];
  }

  private feed(text: string) {
    let i = 0;
    while (i < text.length) {
      const nl = text.indexOf("\n", i);
      const seg = nl === -1 ? text.slice(i) : text.slice(i, nl);
      if (this.committed) this.emitText(nl === -1 ? seg : `${seg}\n`);
      this.line += seg;
      if (nl === -1) {
        if (!this.committed && !this.block && !holdable(this.line, true)) {
          // Prose: stream it now rather than wait for the line to end.
          this.dropFence = false;
          this.flushHeld();
          this.emitText(this.line);
          this.committed = true;
        }
        return;
      }
      const line = this.line;
      this.line = "";
      if (this.committed) this.committed = false;
      else this.completeLine(line);
      i = nl + 1;
    }
  }

  private completeLine(line: string) {
    const t = line.trim();
    const block = this.block;
    if (block) {
      if (block.phase === "search") {
        if (DIVIDER.test(t)) block.phase = "replace";
        else block.search.push(line);
      } else if (UPDATED.test(t) || DIVIDER.test(t)) this.finishBlock();
      else block.replace.push(line);
      return;
    }
    if (HEAD.test(t)) return this.startBlock(line);
    if (this.dropFence && isFenceOnly(line)) {
      this.dropFence = false;
      return;
    }
    if (t) this.dropFence = false;
    if (holdable(line, false)) {
      this.held.push(line);
      if (this.held.length > 3) this.emitText(`${this.held.shift()}\n`);
      return;
    }
    this.flushHeld();
    this.emitText(`${line}\n`);
  }

  private startBlock(headLine: string) {
    // aider's find_filename: walk back ≤3 lines, continuing only through fences.
    let path: string | undefined;
    let cut = this.held.length;
    for (let k = this.held.length - 1, n = 0; k >= 0 && n < 3; k--, n++) {
      const cand = stripFilename(this.held[k]);
      if (cand || isFence(this.held[k])) cut = k;
      if (cand && !path) path = cand;
      if (!isFence(this.held[k])) break;
    }
    // diff-fenced puts the opening fence *before* the filename.
    if (cut > 0 && isFence(this.held[cut - 1]) && !stripFilename(this.held[cut - 1])) cut--;
    const header = this.held.slice(cut);
    this.held = this.held.slice(0, cut);
    this.flushHeld();
    path ??= this.lastPath;
    this.lastPath = path;
    this.block = { path: path ?? "(unknown file)", phase: "search", search: [], replace: [], header: [...header, headLine] };
  }

  private finishBlock() {
    const b = this.block!;
    this.block = null;
    const edit: AiderEdit = {
      toolId: randomUUID(),
      path: b.path,
      search: b.search.join("\n"),
      replace: b.replace.join("\n"),
    };
    this.edits.push(edit);
    this.out.push({
      type: "tool-call",
      toolId: edit.toolId,
      name: "Edit",
      args: { file_path: edit.path, old_string: edit.search, new_string: edit.replace },
    });
    this.kind = "tool";
    this.dropFence = true;
  }

  /** Text before a thinking span must not wait behind held header lines. */
  private flushLines() {
    if (this.block) return;
    if (!this.committed && this.line) {
      this.held.push(this.line);
      this.line = "";
    }
    this.committed = false;
    this.flushHeld();
  }

  private endLines() {
    // The reply's last line has no newline; it must not gain one.
    const tail = this.committed ? "" : this.line;
    this.line = "";
    this.committed = false;
    if (tail && this.block) this.completeLine(tail);
    else if (tail && HEAD.test(tail.trim())) this.startBlock(tail);
    else if (tail) this.held.push(tail);
    const b = this.block;
    if (b) {
      // Unterminated block: show what came, raw, rather than lose it.
      this.block = null;
      const raw = [...b.header, ...b.search, ...(b.phase === "replace" ? ["=======", ...b.replace] : [])];
      this.flushHeld();
      this.emitText(fenced(raw.join("\n")));
      return;
    }
    if (this.dropFence) this.held = this.held.filter((l) => !isFenceOnly(l));
    // Trailing blank lines are noise.
    while (this.held.length && !this.held[this.held.length - 1].trim()) this.held.pop();
    const last = tail && this.held.at(-1) === tail ? this.held.pop() : undefined;
    this.flushHeld();
    if (last) this.emitText(last);
  }
}

// --- edit results ----------------------------------------------------------------

const NO_MATCH = "## SearchReplaceNoExactMatch: This SEARCH block failed to exactly match lines in ";

/** Failed blocks from aider's apply error (it lists each with its SEARCH text). */
export function failedBlocks(error: string): { path: string; search: string; section: string }[] {
  return error
    .split(NO_MATCH)
    .slice(1)
    .map((chunk) => {
      const nl = chunk.indexOf("\n");
      const path = chunk.slice(0, nl).trim();
      const m = /<{5,9} SEARCH\n([\s\S]*?)={5,9}\n/.exec(chunk);
      const section = `${NO_MATCH}${chunk}`.split(/\n(?=# |## )/)[0].trim();
      return { path, search: m?.[1] ?? "", section };
    });
}

const norm = (s: string) => s.split("\n").map((l) => l.trimEnd()).join("\n").trim();
const normPath = (p: string) => p.trim().replace(/^\.\//, "");

/** Whether one parsed edit landed, from the bridge's apply report. */
export function editOutcome(
  edit: AiderEdit,
  result: { applied: boolean; written: string[]; error: string | null },
): { output: string; isError: boolean } {
  if (!result.applied)
    return { output: "Not applied (the reply was interrupted or aider re-prompted).", isError: true };
  const path = normPath(edit.path);
  if (result.error) {
    const failed = failedBlocks(result.error).find(
      (f) => normPath(f.path) === path && norm(f.search) === norm(edit.search),
    );
    if (failed) return { output: failed.section, isError: true };
    if (!result.written.map(normPath).includes(path))
      return { output: result.error.slice(0, 4000), isError: true };
  }
  return { output: `Applied edit to ${edit.path}`, isError: false };
}
