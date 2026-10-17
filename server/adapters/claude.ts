import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import {
  createSdkMcpServer,
  forkSession,
  getSessionMessages,
  getSubagentMessages,
  listSubagents,
  query,
  tool,
  type McpSdkServerConfigWithInstance,
  type SessionMessage,
  type EffortLevel,
  type ModelInfo,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type PermissionUpdateDestination,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SlashCommand,
  type UserDialogRequest,
  type UserDialogResult,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { HarnessConfig } from "../config.js";
import type {
  ChatAction,
  ChatEvent,
  ChatImageRef,
  ChatQuestion,
  ChatUiOption,
  ChatUsage,
  ChatUsageWindow,
  RewindPreview,
} from "../../shared/protocol.js";
import { promptParts } from "../../shared/chat.js";
import { truncate } from "../../shared/render.js";
import type {
  ChatSession,
  ChatSessionHandlers,
  HarnessAdapter,
  HostToolParam,
  HostToolSet,
  SessionOptions,
} from "./types.js";
import {
  DEFAULT_EFFORT,
  effortMenu,
  menuLabel,
  menuModels,
  pickDefault,
} from "./model-menu.js";

// Runtime permission-mode toggle (curated subset of PermissionMode, omits
// bypassPermissions/dontAsk). `id` is passed to query.setPermissionMode.
const PERMISSION_MODES: {
  id: PermissionMode;
  label: string;
  description: string;
}[] = [
  { id: "default", label: "Default", description: "Prompt for anything not auto-allowed" },
  { id: "plan", label: "Plan", description: "Plan only — no tools are executed" },
  { id: "acceptEdits", label: "Allow all edits", description: "Auto-accept file edits" },
  { id: "auto", label: "Auto", description: "A model classifier approves or denies prompts" },
];
const DEFAULT_MODE: PermissionMode = "default";

// Preferred default model, most-wanted first: Opus Plan Mode where the catalog
// offers it (enterprise), else plain Opus. pickDefault resolves this against the
// live catalog — never a substring match, since "opusplan" contains "opus".
const DEFAULT_MODELS = ["opusplan", "opus"];
// Seeds query({ model }) before the catalog is known, so it must be a row every
// catalog has: the bare "opus" alias, which tracks the latest Opus. When the
// catalog turns out to offer a better match, loadControlInfo switches to it.
const SEED_MODEL = "opus";

// Permission-card option ids, shared by the emitted card and the ui-response
// handler that maps one back to a decision, so the two never drift. These are
// `ChatUiOption.value` — stable decode keys, never displayed (labels/details
// are built per-call by permissionOptions).
const ALLOW = "Allow";
const DENY = "Deny";
const ALWAYS_ALLOW = "Always allow";
// For edit tools "always" flips the session into acceptEdits mode rather than
// installing a scoped rule (mirrors the TUI), so it gets a mode-oriented label.
const ALLOW_ALL_EDITS = "Allow all edits";

// Plan-approval labels. Claude in plan mode signals "plan ready" by calling the
// ExitPlanMode tool; we surface a `plan` card with these two paths (mirrors the
// TUI): accept the plan (exit plan mode + auto-accept edits) or keep planning
// (feed instructions back; stay in plan mode).
const ACCEPT_PLAN = "Accept plan";
const KEEP_PLANNING = "Keep planning";

// The tool Claude calls to leave plan mode; its input carries the plan text.
const EXIT_PLAN_TOOL = "ExitPlanMode";

// Tools whose "always" means switch to acceptEdits mode, not a per-call rule.
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// How long an "always" lasts. The SDK picks the destination; we only report it,
// so the button can't promise a scope we don't control.
const SCOPE_TEXT: Record<PermissionUpdateDestination, string> = {
  session: "this session",
  cliArg: "this session",
  localSettings: "saved to local settings",
  projectSettings: "saved to project settings",
  userSettings: "saved to user settings",
};

/** The rules one suggested update would install, e.g. `Bash(git add:*)`.
 * Undefined when there's nothing legible (removals, empty rule lists). */
function describeUpdate(u: PermissionUpdate): string | undefined {
  if (u.type !== "addRules" && u.type !== "replaceRules") return undefined;
  const rules = u.rules
    .filter((r) => r.toolName)
    .map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName));
  return rules.length ? rules.join(", ") : undefined;
}

/** What "Always allow" actually sends back as `updatedPermissions`.
 *
 * The SDK's `suggestions` are ALTERNATIVES (the TUI's separate buttons), not a
 * bundle: a Bash call yields an addRules, an addDirectories AND a setMode. Only
 * the rule updates mean "always allow this call" — returning the lot would also
 * flip the session into acceptEdits and grant a directory behind one click. */
export function alwaysAllowUpdates(
  suggestions: PermissionUpdate[] | undefined,
): PermissionUpdate[] {
  return (suggestions ?? []).filter((u) => describeUpdate(u));
}

/** One line describing what an "Always allow" would do — the rule(s) plus where
 * they're written — for the button's detail row. The TUI names the rule;
 * without this the button is an unexplained blank cheque. */
export function describeSuggestions(
  suggestions: PermissionUpdate[] | undefined,
): string | undefined {
  const updates = alwaysAllowUpdates(suggestions);
  if (!updates.length) return undefined;
  const subject = updates.map((u) => describeUpdate(u)).join(", ");
  return `${truncate(subject, 80)} · ${SCOPE_TEXT[updates[0].destination]}`;
}

/** Build a permission card's choices. `value`s are the fixed decode keys; the
 * always-choice is offered for edit tools (mode flip) or when the SDK computed
 * a scoped rule, matching the TUI. */
export function permissionOptions(
  toolName: string,
  suggestions: PermissionUpdate[] | undefined,
): ChatUiOption[] {
  const options: ChatUiOption[] = [
    { value: ALLOW, label: ALLOW, intent: "accept" },
  ];
  if (EDIT_TOOLS.has(toolName))
    options.push({
      value: ALLOW_ALL_EDITS,
      label: ALLOW_ALL_EDITS,
      detail: `Auto-accept file edits · ${SCOPE_TEXT.session}`,
      intent: "always",
    });
  else if (alwaysAllowUpdates(suggestions).length)
    options.push({
      value: ALWAYS_ALLOW,
      label: ALWAYS_ALLOW,
      detail: describeSuggestions(suggestions),
      intent: "always",
    });
  options.push({ value: DENY, label: DENY, intent: "reject" });
  return options;
}

// CLI dialog kind for AskUserQuestion. Declaring it in supportedDialogKinds
// (+ onUserDialog) routes the tool through the structured question dialog
// instead of a raw permission card; we answer with a PermissionResult whose
// updatedInput carries the chosen answers (as the TUI does).
const ASK_QUESTION_DIALOG = "permission_ask_user_question";

interface AskQuestion {
  question?: string;
  header?: string;
  multiSelect?: boolean;
  options?: { label?: string; description?: string }[];
}

// Parse AskUserQuestion input (`{ questions: [...] }`) into ChatQuestion[],
// dropping malformed entries. Shared by the canUseTool and onUserDialog paths.
function parseQuestions(input: unknown): ChatQuestion[] {
  const raw = (input as { questions?: unknown })?.questions;
  if (!Array.isArray(raw)) return [];
  return (raw as AskQuestion[])
    .filter((q) => typeof q.question === "string" && Array.isArray(q.options))
    .map((q) => ({
      question: q.question as string,
      header: q.header,
      multiSelect: q.multiSelect === true,
      options: (q.options ?? [])
        .filter((o) => typeof o.label === "string")
        .map((o) => ({ label: o.label as string, description: o.description })),
    }));
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// Ordered rate-limit window key → label/duration map; also the display order.
// Windows absent from the SDK response are skipped. `ms` is the window's length
// (the key vocabulary is claude's, so it's decoded here, not in the client).
const USAGE_WINDOWS: { key: string; label: string; ms: number }[] = [
  { key: "five_hour", label: "Current session (5h)", ms: 5 * HOUR_MS },
  { key: "seven_day", label: "Week — all models", ms: 7 * DAY_MS },
  { key: "seven_day_opus", label: "Week — Opus", ms: 7 * DAY_MS },
  { key: "seven_day_sonnet", label: "Week — Sonnet", ms: 7 * DAY_MS },
  { key: "seven_day_oauth_apps", label: "Week — OAuth apps", ms: 7 * DAY_MS },
];

interface UsageWindowRaw {
  utilization?: number | null;
  resets_at?: string | null;
}
interface UsageResponseRaw {
  session?: { total_cost_usd?: number };
  subscription_type?: string | null;
  rate_limits_available?: boolean;
  rate_limits?: Record<string, UsageWindowRaw | null | undefined> | null;
}

// Normalize the SDK's experimental `/usage` payload into the harness-agnostic
// ChatUsage. Only windows present in the response are surfaced; utilization is
// clamped to 0–100. When plan rate limits don't apply (API-key / local / 3rd-
// party) `available` is false and `windows` is empty.
function normalizeUsage(data: unknown): ChatUsage {
  const d = (data ?? {}) as UsageResponseRaw;
  const available = d.rate_limits_available === true;
  const limits = d.rate_limits ?? {};
  const windows: ChatUsageWindow[] = available
    ? USAGE_WINDOWS.flatMap(({ key, label, ms }) => {
        const w = limits[key];
        if (!w) return [];
        const util =
          typeof w.utilization === "number"
            ? Math.max(0, Math.min(100, w.utilization))
            : null;
        return [
          {
            key,
            label,
            utilization: util,
            resetsAt: w.resets_at ?? null,
            windowMs: ms,
          },
        ];
      })
    : [];
  return {
    available,
    subscriptionType: d.subscription_type ?? null,
    windows,
    sessionCostUsd:
      typeof d.session?.total_cost_usd === "number" ? d.session.total_cost_usd : 0,
    at: Date.now(),
  };
}

// Claude Code adapter. Drives the Claude Agent SDK (which owns its own
// subprocess and exposes canUseTool / setModel / supportedCommands), so it's a
// ChatSession, not a ChatTranslator like pi. All Claude/SDK specifics stay here.
// Billing: no ANTHROPIC_API_KEY → the CLI auths from the user's subscription.
//
// `overrides` lets the registry build a second instance (id "claude-local")
// whose `cfg.env` points the CLI at a local endpoint (vLLM) for token-free
// end-to-end testing; the production instance leaves env unset so the
// subscription/OAuth path is untouched.
/**
 * Resolve a locally-installed Claude Code CLI so the SDK drives it instead of
 * its own bundled binary. The SDK ships a version-pinned native `claude` (an
 * optional dep) and uses it unless `pathToClaudeCodeExecutable` is set; that
 * bundled copy can lag the CLI the user actually installed, so its model catalog
 * (e.g. whether "Opus 5" exists) trails behind. Preferring the on-$PATH binary
 * keeps the model list — and everything else — in step with the user's `claude`.
 *
 * Returns an absolute path when `command` resolves to an executable (an explicit
 * path that exists, or a bare name found on $PATH), else undefined → SDK falls
 * back to its bundled binary. `.js`/`.mjs`/etc. are rejected: the SDK treats
 * those as node scripts to run, but here we only want to hand it a native binary.
 */
export function resolveLocalCli(command: string): string | undefined {
  const usable = (p: string): boolean => {
    if (/\.(js|mjs|cjs|ts|tsx|jsx)$/i.test(p) || !existsSync(p)) return false;
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (command.includes("/")) {
    const abs = isAbsolute(command) ? command : join(process.cwd(), command);
    return usable(abs) ? abs : undefined;
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && usable(join(dir, command))) return join(dir, command);
  }
  return undefined;
}

export function createClaudeAdapter(
  cfg: HarnessConfig,
  overrides?: { id?: string; name?: string },
): HarnessAdapter {
  const id = overrides?.id ?? "claude";
  // Point the SDK at the user's installed CLI when present (see resolveLocalCli);
  // fall back to the SDK's bundled binary otherwise. Resolved once at startup.
  const localCli = resolveLocalCli(cfg.command);
  console.log(
    localCli
      ? `[${id}] using local Claude CLI at ${localCli}`
      : `[${id}] local Claude CLI "${cfg.command}" not found on PATH; using SDK bundled binary`,
  );
  return {
    id,
    name: overrides?.name ?? "Claude Code",
    // The CLI emits its own `prompt_suggestion` (see promptSuggestions:true in
    // ClaudeChatSession) → the generic suggestion generator skips this harness.
    nativePromptSuggestions: true,
    // Unused for the chat path (SDK spawns its own executable) but interface-required.
    invocation(_opts: SessionOptions): { command: string; args: string[] } {
      return { command: cfg.command, args: [] };
    },
    createChatSession(opts: SessionOptions): ChatSession {
      return new ClaudeChatSession(opts, cfg.env, localCli);
    },
  };
}

function zodParam(p: HostToolParam): z.ZodType {
  let t: z.ZodType =
    p.type === "number"
      ? z.number()
      : p.enum?.length
        ? z.enum(p.enum as [string, ...string[]])
        : z.string();
  t = t.describe(p.description);
  return p.optional ? t.optional() : t;
}

/** SDK name of a host tool (`mcp__<server>__<tool>`). */
const hostToolName = (set: HostToolSet, name: string) => `mcp__${set.name}__${name}`;

/** `query()` options exposing a HostToolSet via an in-process MCP server. */
export function hostToolOptions(set: HostToolSet): {
  mcpServers: Record<string, McpSdkServerConfigWithInstance>;
} {
  const server = createSdkMcpServer({
    name: set.name,
    instructions: set.instructions,
    tools: set.tools.map((t) =>
      tool(
        t.name,
        t.description,
        Object.fromEntries(
          Object.entries(t.params).map(([k, p]) => [k, zodParam(p)]),
        ),
        async (args) => {
          try {
            const text = await t.run(args as Record<string, unknown>);
            return { content: [{ type: "text", text }] };
          } catch (e) {
            return {
              content: [{ type: "text", text: (e as Error).message }],
              isError: true,
            };
          }
        },
      ),
    ),
  });
  return { mcpServers: { [set.name]: server } };
}

class ClaudeChatSession implements ChatSession {
  private handlers?: ChatSessionHandlers;
  private q?: Query;
  /** Recreated per launch — a rewind tears the query down and starts another. */
  private abort = new AbortController();
  private pushInput?: (msg: SDKUserMessage) => void;
  private closeInput?: () => void;
  private closed = false;
  private errored = false;
  /** Bumped when a rewind swaps the query out. The old consume loop unwinds
   * asynchronously after its abort; comparing generations lets it exit quietly
   * instead of reporting an error and ending the session. */
  private generation = 0;
  /** Live SDK session id (our resume key), from `system`/`init`. */
  private sessionId?: string;
  /** Current model/mode, so a relaunch resumes with the user's picks. */
  private model?: string;
  private mode: PermissionMode = DEFAULT_MODE;
  /** Effort override (undefined = the CLI's configured default). */
  private effort?: EffortLevel;
  /** Full catalog, for the per-model effort levels on a switch. */
  private catalog: ModelInfo[] = [];
  /** Ids of every `user-message` we've emitted, in order (live + replayed).
   * A rewind target is one of these; its position is the fallback way to find
   * the matching transcript entry when the exact uuid isn't known. */
  private promptIds: string[] = [];
  /** messageId → SDK transcript uuid, when we learned it exactly. Cleared on a
   * rewind relaunch: forkSession remaps every uuid, so the cache goes stale and
   * later rewinds fall back to positional lookup. */
  private promptUuids = new Map<string, string>();
  /** messageId → the exact text we sent, so the CLI's echo can be matched by
   * content rather than by order (see pairPromptUuid). */
  private promptText = new Map<string, string>();
  /** Turn in progress (drives the busy indicator). */
  private busy = false;
  /** Streaming state per conversation thread: `""` is the main one, a sub-agent
   * uses its spawning tool-call id. Block indices and the echo flag are
   * per-thread — concurrent sub-agents would otherwise clobber each other and
   * the main turn. */
  private streams = new Map<string, StreamCtx>();
  /** Sub-agent runs announced so far, with the labels last broadcast for each —
   * so a repeat announcement is only sent when something actually changed. */
  private agentToolIds = new Map<
    string,
    { agentType?: string; description?: string }
  >();
  /** tool-call id → on-disk sub-agent id for a resumed session; built once. */
  private subagents?: Record<string, SubagentEntry>;
  /** uuid → provenance for the resumed transcript (see parseOrigins): the one
   * field getSessionMessages drops, and the only way to tell a replayed prompt
   * from an injected notification. */
  private origins = new Map<string, TurnOrigin>();
  /** Pending permission decisions keyed by ChatUiRequest id. */
  private permResolvers = new Map<
    string,
    (decision: PermDecision, note?: string) => void
  >();
  /** Pending AskUserQuestion dialogs keyed by ChatUiRequest id; resolved with
   * the answers map, or null when cancelled. */
  private dialogResolvers = new Map<
    string,
    (answers: Record<string, string> | null) => void
  >();

  constructor(
    private opts: SessionOptions,
    /** Extra env for the CLI subprocess (claude-local points at vLLM). */
    private env?: Record<string, string>,
    /** Locally-installed Claude CLI to drive instead of the SDK's bundled
     * binary (see resolveLocalCli); undefined → SDK uses its own copy. */
    private cliPath?: string,
  ) {}

  start(handlers: ChatSessionHandlers): void {
    this.handlers = handlers;
    // Fixed synchronous lists — emit now so the toggles are present from first
    // render (and survive the relaunch a rewind does).
    this.emit({
      type: "capabilities",
      capabilities: { rewind: true, rewindFiles: true },
    });
    this.emit({ type: "modes", modes: PERMISSION_MODES, current: DEFAULT_MODE });
    this.launch({ resume: this.opts.resume });
  }

  /** Build the SDK query and start consuming it. Called once on start and again
   * after a rewind (with the forked session as `resume`); `restart` skips the
   * transcript replay and the model/command fetch, which a rewind must not redo
   * (clients keep their truncated transcript and their model selection). */
  private launch(opts: { resume?: string; restart?: boolean }): void {
    const input = createPushStream<SDKUserMessage>();
    this.pushInput = input.push;
    this.closeInput = input.close;
    this.abort = new AbortController();
    // Adopt the resumed/forked id up front: the CLI only emits `system`/`init`
    // once a prompt is pushed, so waiting for it would leave a resumed session
    // unable to rewind until the user sent something first.
    if (opts.resume) this.sessionId = opts.resume;

    const q = query({
      prompt: input.stream,
      options: {
        cwd: this.opts.cwd,
        // default = auto-allow read-only, consult canUseTool for the rest.
        // Switchable at runtime via set-mode → setPermissionMode.
        permissionMode: this.mode,
        model: this.model ?? SEED_MODEL,
        ...(this.effort ? { effort: this.effort } : {}),
        // Snapshot files before edits so a rewind can offer to restore them
        // (Query.rewindFiles is gated on this).
        enableFileCheckpointing: true,
        // resume restores the model's context but does NOT stream history back —
        // we rebuild the visible transcript ourselves in replayHistory.
        ...(opts.resume ? { resume: opts.resume } : {}),
        // Drive the user's installed CLI when found (keeps the model catalog in
        // step with their `claude`); else the SDK uses its bundled binary.
        ...(this.cliPath ? { pathToClaudeCodeExecutable: this.cliPath } : {}),
        // Configured env (claude-local → vLLM). The SDK REPLACES the subprocess
        // env rather than merging, so spread process.env to keep PATH/HOME/etc.
        ...(this.env ? { env: { ...process.env, ...this.env } } : {}),
        // Backend host tools (spawn/drive other sessions) as an in-process MCP
        // server. Rebuilt per launch: a server instance binds one transport.
        ...(this.opts.hostTools ? hostToolOptions(this.opts.hostTools) : {}),
        includePartialMessages: true,
        // Without this the SDK forwards only a sub-agent's tool_use/tool_result
        // blocks (a heartbeat); with it the whole nested conversation arrives,
        // tagged by parent_tool_use_id, so we can render it as a nested session.
        forwardSubagentText: true,
        // Predicted next-prompt suggestions (the TUI's follow-up hint). Emitted
        // as a `prompt_suggestion` SDK message after each turn (never the first);
        // mapped to a `prompt-suggestion` ChatEvent. Nearly free (rides the
        // parent's prompt cache).
        promptSuggestions: true,
        abortController: this.abort,
        // Declaring canUseTool is what makes Claude send structured permission
        // requests instead of silently sandboxing/denying.
        canUseTool: (toolName, toolInput, { suggestions }) =>
          new Promise<PermissionResult>((resolve) => {
            // Read-only host tools skip the card. Here, not via `allowedTools`,
            // which the SDK warns shadows canUseTool.
            const ht = this.opts.hostTools;
            if (ht?.tools.some((t) => t.readOnly && hostToolName(ht, t.name) === toolName)) {
              resolve({ behavior: "allow", updatedInput: toolInput });
              return;
            }
            // AskUserQuestion is a question, not a permission: render a structured
            // `questions` card and answer via updatedInput.answers (as the TUI
            // does). Routed here because the CLI doesn't reliably fire
            // onUserDialog for it in the SDK path; canUseTool always fires.
            if (toolName === "AskUserQuestion") {
              const questions = parseQuestions(toolInput);
              if (!questions.length) {
                resolve({ behavior: "allow", updatedInput: toolInput });
                return;
              }
              const qid = randomUUID();
              this.dialogResolvers.set(qid, (answers) => {
                if (!answers) {
                  resolve({ behavior: "deny", message: "Cancelled by user" });
                  return;
                }
                resolve({
                  behavior: "allow",
                  updatedInput: { ...(toolInput as object), answers },
                });
              });
              this.emit({
                type: "ui-request",
                request: {
                  id: qid,
                  kind: "questions",
                  title:
                    questions.length > 1
                      ? "Claude has a few questions"
                      : "Claude has a question",
                  questions,
                },
              });
              return;
            }
            // Plan approval: ExitPlanMode isn't a normal permission — render a
            // dedicated `plan` card. Accept (allow) exits plan mode and flips to
            // acceptEdits so the follow-through auto-accepts; Keep planning
            // (deny) feeds the typed instructions back and stays in plan mode.
            if (toolName === EXIT_PLAN_TOOL) {
              const planId = randomUUID();
              const plan =
                typeof (toolInput as { plan?: unknown })?.plan === "string"
                  ? ((toolInput as { plan: string }).plan)
                  : "";
              this.permResolvers.set(planId, (decision, note) => {
                if (decision === "deny") {
                  resolve({
                    behavior: "deny",
                    message: note?.trim() || "Keep planning.",
                  });
                } else {
                  resolve({ behavior: "allow", updatedInput: toolInput });
                  this.applyMode("acceptEdits");
                }
              });
              this.emit({
                type: "ui-request",
                request: {
                  id: planId,
                  kind: "plan",
                  title: "Claude proposed a plan",
                  message: plan,
                  options: [
                    { value: ACCEPT_PLAN, label: ACCEPT_PLAN, intent: "accept" },
                    {
                      value: KEEP_PLANNING,
                      label: KEEP_PLANNING,
                      intent: "reject",
                    },
                  ],
                },
              });
              return;
            }
            const id = randomUUID();
            const isEdit = EDIT_TOOLS.has(toolName);
            this.permResolvers.set(id, (decision, note) => {
              if (decision === "deny") {
                // A note becomes the deny message the CLI feeds back to the model.
                resolve({
                  behavior: "deny",
                  message: note?.trim() || "Denied by user",
                });
              } else if (decision === "always" && isEdit) {
                // Allow this call, then switch to acceptEdits so later edits
                // stop prompting (mode toggle updates via applyMode's event).
                resolve({ behavior: "allow", updatedInput: toolInput });
                this.applyMode("acceptEdits");
              } else if (decision === "always") {
                // Rule updates only (see alwaysAllowUpdates). The CLI persists
                // them at the destination it suggested — in practice
                // `.claude/settings.local.json` — which is what the button's
                // detail row promises.
                resolve({
                  behavior: "allow",
                  updatedInput: toolInput,
                  updatedPermissions: alwaysAllowUpdates(suggestions),
                });
              } else {
                resolve({ behavior: "allow", updatedInput: toolInput });
              }
            });
            this.emit({
              type: "ui-request",
              request: {
                id,
                kind: "select",
                title: `Allow ${toolName}?`,
                // Rich, harness-agnostic view (diff/code/path) instead of raw
                // arg JSON — the client renders it via the shared toolView.
                tool: { name: toolName, args: toolInput },
                options: permissionOptions(toolName, suggestions),
              },
            });
          }),
        // Fallback if a future CLI routes AskUserQuestion via onUserDialog (it
        // doesn't today — handled in canUseTool above). Only listed kinds emit.
        supportedDialogKinds: [ASK_QUESTION_DIALOG],
        onUserDialog: (request) => this.handleUserDialog(request),
      },
    });
    this.q = q;
    if (opts.restart) return void this.consume(q, this.generation);
    // The live stream doesn't replay history on resume, so rebuild it from disk.
    if (opts.resume) void this.replayHistory(opts.resume);
    void this.consume(q, this.generation);
    // Eager fetch: models/commands resolve on connect (no prompt needed), so the
    // switcher and palette are ready before the first message.
    void this.loadControlInfo(q);
  }

  /** Switch permission mode and reflect it in the UI. Shared by the set-mode
   * action and the "Allow all edits" decision. */
  private applyMode(mode: PermissionMode): void {
    this.q
      ?.setPermissionMode(mode)
      .then(() => {
        this.mode = mode;
        this.emit({ type: "mode-changed", current: mode });
      })
      .catch((e: Error) =>
        this.emit({
          type: "notice",
          level: "error",
          text: `Mode switch failed: ${e.message}`,
        }),
      );
  }

  private emitEfforts(model: string | undefined): void {
    const info = this.catalog.find((m) => m.value === model);
    this.emit({ type: "efforts", ...effortMenu(info, this.effort) });
  }

  private async loadControlInfo(q: Query): Promise<void> {
    try {
      const [models, commands] = await Promise.all([
        q.supportedModels(),
        q.supportedCommands(),
      ]);
      // Apply the menu policy (latest-per-family, prior major on a bump), then
      // resolve DEFAULT_MODELS against it; fall back to the first row.
      // Deriving `current` from the pruned menu keeps it in sync with what's shown.
      const menu = menuModels(models);
      let current = pickDefault(menu, DEFAULT_MODELS) ?? menu[0];
      // The seed was a guess made before the catalog was known. If the catalog
      // offers something better, actually switch — otherwise the header would
      // claim Opus Plan Mode while the CLI ran plain Opus (a behaviour gap, not a
      // cosmetic one). Tracked on the instance so a rewind relaunch keeps it.
      // Own try/catch: a catalog that refuses the switch must still get its model
      // list and slash commands, and must keep reporting what's really running.
      if (!this.model && current && current.value !== SEED_MODEL) {
        try {
          await q.setModel(current.value);
          this.model = current.value;
        } catch {
          current = menu.find((m: ModelInfo) => m.value === SEED_MODEL) ?? current;
        }
      }
      this.emit({
        type: "models",
        models: menu.map((m: ModelInfo) => ({
          id: m.value,
          label: menuLabel(m),
          description: m.description,
        })),
        current: current?.value ?? null,
      });
      this.catalog = models;
      this.emitEfforts(current?.value);
      this.emit({
        type: "commands",
        commands: commands.map((c: SlashCommand) => ({
          name: c.name,
          description: c.description,
        })),
      });
    } catch {
      // Non-fatal: the session still works without a model/command list.
    }
  }

  /** Render AskUserQuestion as a structured dialog and return the picks as the
   * CLI's PermissionResult (answers in updatedInput.answers). Other kinds
   * cancel, so the CLI applies its default. */
  private handleUserDialog(
    request: UserDialogRequest,
  ): Promise<UserDialogResult> {
    return new Promise<UserDialogResult>((resolve) => {
      const payload = request.payload as Record<string, unknown>;
      const questions =
        request.dialogKind === ASK_QUESTION_DIALOG
          ? parseQuestions(payload)
          : [];
      if (!questions.length) {
        resolve({ behavior: "cancelled" });
        return;
      }
      const id = randomUUID();
      this.dialogResolvers.set(id, (answers) => {
        if (!answers) {
          resolve({ behavior: "cancelled" });
          return;
        }
        resolve({
          behavior: "completed",
          result: {
            behavior: "allow",
            updatedInput: { questions: payload.questions, answers },
          },
        });
      });
      this.emit({
        type: "ui-request",
        request: {
          id,
          kind: "questions",
          title:
            questions.length > 1
              ? "Claude has a few questions"
              : "Claude has a question",
          questions,
        },
      });
    });
  }

  action(action: ChatAction): void {
    switch (action.type) {
      case "prompt": {
        this.pushInput?.({
          type: "user",
          message: { role: "user", content: buildUserContent(action.text, action.images) },
          parent_tool_use_id: null,
        });
        const id = randomUUID();
        this.promptIds.push(id);
        // Remember what we sent so its CLI echo can be matched by text, not by
        // arrival order (see pairPromptUuid).
        this.promptText.set(id, action.text.trim());
        this.emit({
          type: "user-message",
          message: {
            id,
            role: "user",
            parts: promptParts(action.text, action.images),
            createdAt: Date.now(),
          },
        });
        break;
      }
      case "abort":
        this.q?.interrupt().catch(() => {});
        break;
      case "ui-response": {
        // AskUserQuestion dialogs resolve with answers.
        const dialog = this.dialogResolvers.get(action.requestId);
        if (dialog) {
          this.dialogResolvers.delete(action.requestId);
          this.emit({ type: "ui-request-done", requestId: action.requestId });
          dialog(action.cancelled ? null : (action.answers ?? {}));
          return;
        }
        const resolve = this.permResolvers.get(action.requestId);
        if (!resolve) return;
        this.permResolvers.delete(action.requestId);
        this.emit({ type: "ui-request-done", requestId: action.requestId });
        const denied =
          action.cancelled === true ||
          action.confirmed === false ||
          action.value === DENY ||
          // Keep planning is a rejection of ExitPlanMode (feeds instructions back).
          action.value === KEEP_PLANNING;
        const decision: PermDecision = denied
          ? "deny"
          : action.value === ALWAYS_ALLOW || action.value === ALLOW_ALL_EDITS
            ? "always"
            : "allow";
        resolve(decision, action.note);
        break;
      }
      case "rewind":
        void this.rewind(action.messageId, action.restoreFiles === true);
        break;
      case "rewind-preview":
        void this.previewRewind(action.messageId);
        break;
      case "set-model":
        this.model = action.model === "default" ? undefined : action.model;
        this.q
          ?.setModel(action.model === "default" ? undefined : action.model)
          .then(() => {
            this.emit({ type: "model-changed", current: action.model });
            // Levels are per model.
            this.emitEfforts(action.model);
          })
          .catch((e: Error) =>
            this.emit({
              type: "notice",
              level: "error",
              text: `Model switch failed: ${e.message}`,
            }),
          );
        break;
      case "set-mode":
        this.applyMode(action.mode as PermissionMode);
        break;
      case "set-effort": {
        const effort =
          action.effort === DEFAULT_EFFORT
            ? undefined
            : (action.effort as EffortLevel);
        // null clears the flag layer → back to the configured default.
        this.q
          ?.applyFlagSettings({ effortLevel: effort ?? null })
          .then(() => {
            this.effort = effort;
            this.emit({ type: "effort-changed", current: action.effort });
          })
          .catch((e: Error) =>
            this.emit({
              type: "notice",
              level: "error",
              text: `Effort switch failed: ${e.message}`,
            }),
          );
        break;
      }
      case "usage":
        void this.reportUsage();
        break;
      case "load-agent":
        void this.loadAgent(action.toolId);
        break;
    }
  }

  /** Fill a resumed session's sub-agent transcript from its own on-disk JSONL.
   * Lazy (driven by the client expanding the bubble): the live stream only ever
   * carried the runs of this process, and a session can hold dozens. */
  private async loadAgent(toolId: string): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    this.emit({ type: "agent-start", toolId, loading: true });
    try {
      const agentId = (await this.subagentIndex())[toolId]?.agentId;
      if (!agentId) return;
      const messages = await getSubagentMessages(sessionId, agentId, {
        dir: this.opts.cwd,
      });
      for (const m of messages) {
        if (this.closed) return;
        const content = (m.message as { content?: unknown } | undefined)?.content;
        if (m.type === "assistant") {
          this.replayAssistantMessage(content, m.uuid, toolId);
        } else if (m.type === "user") {
          this.handleToolResults(content, toolId);
          this.replayUserMessage(content, m.uuid, toolId);
        }
      }
    } catch (err) {
      this.emit({
        type: "notice",
        level: "error",
        text: `Couldn't load sub-agent transcript: ${(err as Error).message}`,
      });
    } finally {
      // Always clears `loading` — an empty run just falls back to the tool output.
      this.emit({ type: "agent-done", toolId });
    }
  }

  /** tool-call id → {sub-agent id, labels}, from the sidecar meta files the CLI
   * writes beside each transcript. The SDK lists sub-agent ids but never says
   * which tool call they came from, and that join is the whole point. Cached per
   * session (a rewind forks to a new id and clears it). */
  private async subagentIndex(): Promise<Record<string, SubagentEntry>> {
    if (this.subagents) return this.subagents;
    const index: Record<string, SubagentEntry> = {};
    const sessionId = this.sessionId;
    if (!sessionId) return index;
    const dir = await subagentDir(this.opts.cwd, sessionId);
    if (!dir) return (this.subagents = index);
    for (const agentId of await listSubagents(sessionId, { dir: this.opts.cwd })) {
      const meta = await readAgentMeta(dir, agentId);
      if (meta?.toolUseId) index[meta.toolUseId] = { agentId, meta };
    }
    return (this.subagents = index);
  }

  /** Fetch the structured `/usage` data (session cost + plan rate-limit
   * utilization windows) and emit it as a normalized `usage` event. Best-effort:
   * any error surfaces as a notice and leaves the prior snapshot in place. */
  private async reportUsage(): Promise<void> {
    const q = this.q;
    if (!q) return;
    try {
      const data = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
      this.emit({ type: "usage", usage: normalizeUsage(data) });
    } catch (e) {
      this.emit({
        type: "notice",
        level: "error",
        text: `Usage unavailable: ${(e as Error).message}`,
      });
    }
  }

  close(): void {
    this.closed = true;
    this.teardown();
  }

  /** Stop the current query and release everything waiting on it. Shared by
   * close() and the rewind relaunch — only `closed` distinguishes them. */
  private teardown(): void {
    this.closeInput?.();
    this.abort.abort();
    // Release dangling prompts so the SDK loop can unwind.
    for (const resolve of this.permResolvers.values()) resolve("deny");
    this.permResolvers.clear();
    for (const resolve of this.dialogResolvers.values()) resolve(null);
    this.dialogResolvers.clear();
  }

  private emit(event: ChatEvent): void {
    this.handlers?.onEvent(event);
  }

  /** Emit into the main transcript (`parent` null) or, for a sub-agent message,
   * into that agent's nested transcript. The message-building helpers below all
   * take a `parent` and route through here, so one code path serves both. */
  private emitFor(parent: string | null, event: ChatEvent): void {
    if (parent == null) this.emit(event);
    else this.emit({ type: "agent-event", toolId: parent, event });
  }

  /** Streaming state for a thread, created on first use. */
  private streamCtx(parent: string | null): StreamCtx {
    const key = parent ?? "";
    let ctx = this.streams.get(key);
    if (!ctx) this.streams.set(key, (ctx = { toolBlocks: new Map(), streamed: false }));
    return ctx;
  }

  /** Announce a sub-agent the first time we see anything belonging to it (and
   * refresh its labels when a later message carries them). Idempotent in the
   * reducer, so `task_started` and the lazy path can both call it. */
  private noteAgent(
    toolId: string,
    meta: { agentType?: string; description?: string } = {},
  ): void {
    // Every forwarded sub-agent message repeats its labels; only broadcast when
    // something is actually new, or a long run re-emits per message.
    const known = this.agentToolIds.get(toolId);
    if (
      known &&
      (!meta.agentType || meta.agentType === known.agentType) &&
      (!meta.description || meta.description === known.description)
    )
      return;
    this.agentToolIds.set(toolId, {
      agentType: meta.agentType ?? known?.agentType,
      description: meta.description ?? known?.description,
    });
    this.emit({ type: "agent-start", toolId, ...meta });
  }

  /** Read the session's on-disk transcript (user + assistant entries, in order). */
  private async transcript(): Promise<SessionMessage[]> {
    if (!this.sessionId) return [];
    return getSessionMessages(this.sessionId, { dir: this.opts.cwd });
  }

  /** Load the provenance getSessionMessages drops, so replayed turns can be told
   * apart. Best-effort: on any failure everything stays human (prior behaviour). */
  private async loadOrigins(sessionId: string): Promise<void> {
    try {
      const file = await sessionFile(this.opts.cwd, sessionId);
      if (file) this.origins = parseOrigins(await readFile(file, "utf8"));
    } catch {
      // Unreadable transcript — no provenance, no reclassification.
    }
  }

  /** Find the transcript uuid of one of our user-message ids. Prefer the uuid
   * captured from the CLI's echo; otherwise fall back to position among the
   * transcript's prose user entries (which is how rewinds after a fork resolve,
   * since forkSession remaps every uuid). */
  private async promptUuid(messageId: string): Promise<string | undefined> {
    const exact = this.promptUuids.get(messageId);
    if (exact) return exact;
    const idx = this.promptIds.indexOf(messageId);
    if (idx === -1) return undefined;
    // Refresh provenance: notifications land in the file while the session runs,
    // and counting one as a prompt shifts every position below.
    if (this.sessionId) await this.loadOrigins(this.sessionId);
    // MUST use the same predicate replayUserMessage does, or the two lists drift
    // and a rewind forks the session at the wrong entry: a session with
    // background-task notifications has prose user entries that are not prompts.
    const prompts = (await this.transcript()).filter(
      (m) =>
        m.type === "user" &&
        isHumanTurn({ origin: this.origins.get(m.uuid) }) &&
        userText((m.message as { content?: unknown } | undefined)?.content),
    );
    return prompts[idx]?.uuid;
  }

  /** Dry-run the file half of a rewind so the confirm dialog can say what it
   * would touch. Never mutates anything. */
  private async previewRewind(messageId: string): Promise<void> {
    const preview = await this.rewindFiles(messageId, true);
    this.emit({ type: "rewind-preview", preview });
  }

  /** Run (or dry-run) the file restore for a rewind target. */
  private async rewindFiles(
    messageId: string,
    dryRun: boolean,
  ): Promise<RewindPreview> {
    try {
      const uuid = await this.promptUuid(messageId);
      if (!uuid || !this.q)
        return { messageId, canRewind: false, error: "Prompt not found in this session's history" };
      const result = await this.q.rewindFiles(uuid, { dryRun });
      return {
        messageId,
        canRewind: result.canRewind,
        error: result.error,
        filesChanged: result.filesChanged,
        insertions: result.insertions,
        deletions: result.deletions,
      };
    } catch (e) {
      return { messageId, canRewind: false, error: (e as Error).message };
    }
  }

  /** Rewind the conversation to just before `messageId`: interrupt whatever is
   * running, optionally restore files, fork the transcript at the preceding
   * entry and relaunch on the fork. The pre-rewind session file is untouched,
   * so it stays resumable as a safety net. */
  private async rewind(messageId: string, restoreFiles: boolean): Promise<void> {
    if (this.closed) return;
    const fail = (text: string) =>
      this.emit({ type: "notice", level: "error", text: `Rewind failed: ${text}` });
    const sessionId = this.sessionId;
    if (!sessionId) return fail("session not ready");

    let uuid: string | undefined;
    try {
      uuid = await this.promptUuid(messageId);
    } catch (e) {
      return fail((e as Error).message);
    }
    if (!uuid) return fail("that prompt isn't in this session's history");

    // Stop the current turn first: the rest of this operates on a settled
    // transcript, and the user asked to abandon whatever is running.
    await this.q?.interrupt().catch(() => {});
    if (this.closed) return;

    let restored: RewindPreview | undefined;
    if (restoreFiles) {
      restored = await this.rewindFiles(messageId, false);
      // A failed file restore isn't fatal — say so and rewind the conversation.
      if (!restored.canRewind)
        this.emit({
          type: "notice",
          level: "warning",
          text: `Files not restored${restored.error ? `: ${restored.error}` : ""}`,
        });
    }

    // Fork up to the entry *before* the prompt — inclusive slice, so this is the
    // state the user saw when they typed it. Nothing before it → an empty fork,
    // i.e. relaunch fresh.
    let forked: string | undefined;
    try {
      const entries = await this.transcript();
      const prev = entries[entries.findIndex((m) => m.uuid === uuid) - 1];
      if (prev)
        forked = (
          await forkSession(sessionId, {
            dir: this.opts.cwd,
            upToMessageId: prev.uuid,
          })
        ).sessionId;
    } catch (e) {
      return fail((e as Error).message);
    }
    if (this.closed) return;

    // Swap the query out under the same session id: the browser tab, its
    // ChatState and the manager's session all survive.
    this.generation++;
    this.teardown();
    this.busy = false;
    this.streams.clear();
    // forkSession gives the relaunch a new session id and remaps every uuid, so
    // both caches keyed against the old one are stale.
    this.subagents = undefined;
    this.origins = new Map();
    const idx = this.promptIds.indexOf(messageId);
    if (idx !== -1) this.promptIds = this.promptIds.slice(0, idx);
    this.promptUuids.clear(); // forkSession remapped every uuid
    this.launch({ resume: forked, restart: true });
    // The CLI only emits `system`/`init` once a prompt is pushed, so adopt the
    // fork's id now: until then the old key would still be the session's, and
    // closing the tab would resurface the un-rewound conversation in /resume.
    this.sessionId = forked;
    if (forked) this.handlers?.onResumable?.(forked);

    this.emit({ type: "rewind", messageId });
    const files =
      restored?.canRewind && restored.filesChanged?.length
        ? `, restored ${restored.filesChanged.length} file${restored.filesChanged.length === 1 ? "" : "s"}`
        : "";
    this.emit({
      type: "notice",
      level: "info",
      text: `Rewound to an earlier prompt${files}. The previous conversation is still resumable.`,
    });
  }

  private async consume(q: Query, generation: number): Promise<void> {
    try {
      for await (const msg of q) this.handleMessage(msg);
    } catch (err) {
      // A superseded query (rewind) always ends by abort — not a session error.
      if (!this.closed && generation === this.generation) {
        this.errored = true;
        this.emit({
          type: "notice",
          level: "error",
          text: (err as Error).message,
        });
      }
    } finally {
      if (generation === this.generation) this.handlers?.onExit(this.errored ? 1 : 0);
    }
  }

  /** Flip the main thread busy (idempotent — a turn has several triggers). */
  private markBusy(): void {
    if (this.busy) return;
    this.busy = true;
    this.emit({ type: "busy", busy: true });
  }

  private handleMessage(msg: SDKMessage): void {
    // Everything a sub-agent produces is tagged with the tool call that spawned
    // it; route it into that nested transcript instead of the main one.
    const meta = subagentMeta(msg);
    const parent = meta?.parentToolId ?? null;
    if (meta) this.noteAgent(meta.parentToolId, meta);

    switch (msg.type) {
      case "stream_event":
        this.handleStreamEvent(msg.event as StreamEvent, parent);
        break;
      case "system":
        // init carries the session id (our resume key) + resumed permission mode.
        if (msg.subtype === "init") {
          this.sessionId = msg.session_id;
          this.handlers?.onResumable?.(msg.session_id);
          if (msg.permissionMode) {
            this.mode = msg.permissionMode;
            this.emit({ type: "mode-changed", current: msg.permissionMode });
          }
        } else if (msg.subtype === "compact_boundary") {
          // Context was compacted: history is replaced by a summary (manual
          // /compact or auto when the window fills). Surface it as a notice so
          // the transcript marks the boundary instead of silently dropping
          // history — harness-agnostic, the UI already renders notices.
          const meta = msg.compact_metadata;
          const tokens =
            typeof meta?.post_tokens === "number"
              ? ` (${meta.pre_tokens} → ${meta.post_tokens} tokens)`
              : "";
          const how = meta?.trigger === "auto" ? "auto" : "manual";
          this.emit({
            type: "notice",
            level: "info",
            text: `Compacted context${tokens} [${how}]`,
          });
        } else if (msg.subtype === "status") {
          // Compaction emits NO assistant stream — so `message_start`, the only
          // other thing that flips busy, never fires and the session looked idle
          // for the ~13s the CLI spent summarizing: /compact read as doing
          // nothing, then as a hang. The status message is the sole live signal.
          if (msg.status === "compacting") {
            this.markBusy();
            // Same wording as pi's compaction_start — this is the shared idiom.
            this.emit({
              type: "notice",
              level: "info",
              text: "Compacting context…",
            });
          }
          if (msg.compact_result === "failed")
            // Report it rather than leaving the user wondering why /compact did
            // nothing (no compact_boundary follows a failure).
            this.emit({
              type: "notice",
              level: "error",
              text: `Compaction failed${msg.compact_error ? `: ${msg.compact_error}` : ""}`,
            });
        } else if (msg.subtype === "task_started") {
          // Earliest, most explicit sub-agent signal (the lazy noteAgent above
          // covers harnesses/paths that never send it).
          const task = msg as unknown as TaskMessage;
          if (task.tool_use_id)
            this.noteAgent(task.tool_use_id, {
              agentType: task.subagent_type,
              description: task.description,
            });
        } else if (msg.subtype === "task_notification") {
          // A background task finished. For a sub-agent that's its report, which
          // belongs in the nested transcript; for anything else (a backgrounded
          // shell command) it's a turn the conversation received, so it shows as
          // a system line. This is the LIVE source for both: the injected user
          // turn the CLI writes carries no `origin` over the wire — only on disk,
          // which is what the resume path reads (see parseOrigins).
          const task = msg as unknown as TaskMessage;
          if (task.tool_use_id && this.agentToolIds.has(task.tool_use_id))
            this.emit({
              type: "agent-done",
              toolId: task.tool_use_id,
              report: task.summary,
            });
          else this.systemMessage(taskLine(task));
        }
        break;
      case "user": {
        const content = (msg.message as { content?: unknown } | undefined)
          ?.content;
        this.handleToolResults(content, parent);
        if (parent) {
          // A sub-agent's own prompt IS shown (it opens its nested transcript);
          // on the main thread the live echo is skipped, since the prompt bubble
          // was already emitted by the `prompt` action.
          this.replayUserMessage(content, undefined, parent);
        } else if ("isReplay" in msg && msg.isReplay) {
          // Vestigial safety net — the SDK doesn't emit isReplay on resume.
          this.replayUserMessage(content);
        } else if (msg.uuid && userText(content)) {
          // The CLI's echo of a prompt we sent — the only place its transcript
          // uuid surfaces, and what a rewind needs to slice the session at.
          // Matched by text: injected turns (task notifications) look identical
          // here, since the live message carries no `origin`.
          this.pairPromptUuid(msg.uuid, userText(content));
        }
        break;
      }
      case "assistant":
        // Live turns are built from deltas; ignore the SDK's whole-message echo.
        // A whole message with no preceding deltas is rebuilt as a safety net.
        if (!this.streamCtx(parent).streamed)
          this.replayAssistantMessage(
            (msg.message as { content?: unknown } | undefined)?.content,
            msg.uuid,
            parent,
          );
        break;
      case "result":
        // Turn finished (success, error, or interrupt) — clear busy. Sub-agents
        // are bounded by the turn, so their threads go too.
        this.busy = false;
        this.streams.clear();
        this.emit({ type: "busy", busy: false });
        break;
      case "prompt_suggestion":
        // Predicted next user prompt (arrives just after `result`). Surface it as
        // a composer hint; the reducer clears it on the next prompt.
        // Claude's CLI emits a single suggestion; the schema is a list (the
        // synthesized generator may offer several) so wrap it as one.
        if (typeof msg.suggestion === "string" && msg.suggestion.trim())
          this.emit({
            type: "prompt-suggestion",
            suggestions: [msg.suggestion.trim()],
          });
        break;
    }
  }

  /** Rebuild a resumed conversation's transcript from its on-disk JSONL (the
   * live stream doesn't replay it), folding whole messages through the same
   * helpers the live path uses so history bubbles match freshly-streamed ones. */
  private async replayHistory(sessionId: string): Promise<void> {
    await this.loadOrigins(sessionId);
    let messages;
    try {
      messages = await getSessionMessages(sessionId, { dir: this.opts.cwd });
    } catch (err) {
      this.emit({
        type: "notice",
        level: "error",
        text: `Couldn't load conversation history: ${(err as Error).message}`,
      });
      return;
    }
    // Announce the sub-agent runs that have a transcript on disk BEFORE walking
    // the messages: the stub is what tells the client a bubble is worth
    // expanding, and the loop below needs agentToolIds to know which
    // notifications already belong to a run.
    try {
      const index = await this.subagentIndex();
      for (const [toolId, entry] of Object.entries(index))
        this.noteAgent(toolId, {
          agentType: entry.meta.agentType,
          description: entry.meta.description,
        });
    } catch {
      // Best-effort: no stubs just means those bubbles keep the plain output.
    }
    for (const m of messages) {
      if (this.closed) return;
      const content = (m.message as { content?: unknown } | undefined)?.content;
      if (m.type === "assistant") {
        this.replayAssistantMessage(content, m.uuid);
      } else if (m.type === "user") {
        // May carry tool_result blocks and/or genuine prose — emit both. A turn
        // the human didn't author replays as a system line, never a user bubble
        // (and never becomes a rewind target) — same rule as the live path.
        this.handleToolResults(content);
        const entry = { origin: this.origins.get(m.uuid), message: m.message };
        if (isHumanTurn(entry)) {
          this.replayUserMessage(content, m.uuid);
        } else {
          // A sub-agent's notification is its run's report — it belongs to the
          // nested transcript (where the live path put it), not out here.
          const owner = notificationToolId(userText(content));
          if (!owner || !this.agentToolIds.has(owner))
            this.systemMessage(systemTurnText(entry));
        }
      }
    }
  }

  /** Emit a turn nobody in the conversation authored as a `system` message.
   * Deliberately NOT pushed to promptIds/promptUuids — it isn't a rewind target,
   * and counting it would shift every positional lookup. */
  private systemMessage(text: string, parent: string | null = null): void {
    if (!text) return;
    this.emitFor(parent, {
      type: "user-message",
      message: {
        id: randomUUID(),
        role: "system",
        parts: [{ type: "text", text }],
        createdAt: Date.now(),
      },
    });
  }

  /** Rebuild a replayed user prompt into a bubble (only genuine user text).
   * Replays carry their transcript uuid, so rewind targets resolve exactly. */
  private replayUserMessage(
    content: unknown,
    uuid?: string,
    parent: string | null = null,
  ): void {
    const text = userText(content);
    if (!text) return;
    const id = uuid ?? randomUUID();
    // Rewind identity is main-thread only: a sub-agent's prompts are not
    // targets, and mixing them into promptIds would shift every position.
    if (!parent) {
      this.promptIds.push(id);
      if (uuid) this.promptUuids.set(id, uuid);
    }
    this.emitFor(parent, {
      type: "user-message",
      message: {
        id,
        role: "user",
        parts: [{ type: "text", text }],
        createdAt: Date.now(),
      },
    });
  }

  /** Attach a transcript uuid to the prompt this echo belongs to.
   *
   * Matched by TEXT, not by arrival order: the CLI injects other prose user
   * turns into the conversation (a background task reporting completion), and
   * the live SDK message carries no `origin` to tell them apart — see
   * isHumanTurn. Pairing blind would hand a notification's uuid to a real
   * prompt, and a rewind would then fork the session at the wrong turn.
   * No match → no pairing, and promptUuid falls back to position. */
  private pairPromptUuid(uuid: string, echo: string): void {
    for (const id of this.promptIds) {
      if (!this.promptUuids.has(id) && this.promptText.get(id) === echo) {
        this.promptUuids.set(id, uuid);
        return;
      }
    }
  }

  /** Rebuild a whole assistant message into a bubble via the live delta events. */
  private replayAssistantMessage(
    content: unknown,
    uuid: string,
    parent: string | null = null,
  ): void {
    if (!Array.isArray(content)) return;
    this.emitFor(parent, { type: "assistant-start", messageId: uuid });
    for (const block of content as ContentBlock[]) {
      if (block?.type === "text" && typeof block.text === "string") {
        this.emitFor(parent, { type: "part-start", kind: "text" });
        this.emitFor(parent, {
          type: "part-delta",
          kind: "text",
          delta: block.text,
        });
      } else if (
        block?.type === "thinking" &&
        typeof block.thinking === "string"
      ) {
        this.emitFor(parent, { type: "part-start", kind: "thinking" });
        this.emitFor(parent, {
          type: "part-delta",
          kind: "thinking",
          delta: block.thinking,
        });
      } else if (block?.type === "tool_use" && block.id) {
        this.emitFor(parent, {
          type: "tool-call",
          toolId: block.id,
          name: block.name ?? "tool",
          args: block.input,
        });
      }
    }
    this.emitFor(parent, { type: "assistant-end" });
  }

  private handleStreamEvent(
    event: StreamEvent | undefined,
    parent: string | null = null,
  ): void {
    const ctx = this.streamCtx(parent);
    switch (event?.type) {
      case "message_start": {
        ctx.toolBlocks.clear();
        // Mark the turn streamed so its whole-message echo is ignored.
        ctx.streamed = true;
        // busy tracks the whole turn, which a sub-agent runs inside of.
        if (!parent) this.markBusy();
        this.emitFor(parent, { type: "assistant-start", messageId: randomUUID() });
        break;
      }
      case "content_block_start": {
        const block = event.content_block;
        if (block?.type === "text")
          this.emitFor(parent, { type: "part-start", kind: "text" });
        else if (block?.type === "thinking")
          this.emitFor(parent, { type: "part-start", kind: "thinking" });
        else if (block?.type === "tool_use" && typeof event.index === "number")
          ctx.toolBlocks.set(event.index, {
            id: block.id ?? randomUUID(),
            name: block.name ?? "tool",
            initialInput: block.input,
            json: "",
          });
        break;
      }
      case "content_block_delta": {
        const delta = event.delta;
        if (delta?.type === "text_delta" && delta.text)
          this.emitFor(parent, {
            type: "part-delta",
            kind: "text",
            delta: delta.text,
          });
        else if (delta?.type === "thinking_delta" && delta.thinking)
          this.emitFor(parent, {
            type: "part-delta",
            kind: "thinking",
            delta: delta.thinking,
          });
        else if (
          delta?.type === "input_json_delta" &&
          typeof event.index === "number"
        ) {
          const tool = ctx.toolBlocks.get(event.index);
          if (tool) tool.json += delta.partial_json ?? "";
        }
        break;
      }
      case "content_block_stop": {
        if (typeof event.index !== "number") break;
        const tool = ctx.toolBlocks.get(event.index);
        if (!tool) break;
        ctx.toolBlocks.delete(event.index);
        this.emitFor(parent, {
          type: "tool-call",
          toolId: tool.id,
          name: tool.name,
          args: parseToolArgs(tool),
        });
        break;
      }
      case "message_stop":
        this.emitFor(parent, { type: "assistant-end" });
        break;
    }
  }

  private handleToolResults(content: unknown, parent: string | null = null): void {
    if (!Array.isArray(content)) return;
    for (const block of content as ToolResultBlock[]) {
      if (block?.type !== "tool_result" || !block.tool_use_id) continue;
      // NB: the Agent tool's result is deliberately NOT treated as the report.
      // For a backgrounded sub-agent it's only the "launched successfully" stub
      // (the answer arrives later via task_notification), and for a foreground
      // one the forwarded conversation already ends with the answer.
      this.emitFor(parent, {
        type: "tool-end",
        toolId: block.tool_use_id,
        output: contentText(block.content),
        isError: block.is_error === true,
      });
    }
  }
}

type UserContent = SDKUserMessage["message"]["content"];

/** Build the SDK user-message content for a prompt: a bare string when there
 * are no images, otherwise an array of text + base64 image content blocks (the
 * Anthropic content-block shape the Claude Agent SDK accepts). Images without
 * resolved `data` (server never loaded them) are skipped. */
export function buildUserContent(
  text: string,
  images?: ChatImageRef[],
): UserContent {
  const withData = (images ?? []).filter((i) => i.data);
  if (withData.length === 0) return text;
  const blocks: Exclude<UserContent, string> = [];
  if (text) blocks.push({ type: "text", text });
  for (const img of withData) {
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: img.mediaType as "image/png",
        data: img.data as string,
      },
    });
  }
  return blocks;
}

/** Pushable async iterator: the SDK consumes `stream` as prompt input while we
 * `push` user messages and `close` to end the session. */
function createPushStream<T>(): {
  stream: AsyncGenerator<T>;
  push: (value: T) => void;
  close: () => void;
} {
  const buffer: T[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  async function* stream(): AsyncGenerator<T> {
    while (true) {
      while (buffer.length) yield buffer.shift()!;
      if (done) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = null;
    }
  }
  return {
    stream: stream(),
    push(value) {
      buffer.push(value);
      wake?.();
    },
    close() {
      done = true;
      wake?.();
    },
  };
}

/** How the user answered a permission card. */
type PermDecision = "allow" | "always" | "deny";

interface ToolBlock {
  id: string;
  name: string;
  initialInput: unknown;
  json: string;
}

/** Streaming state of one conversation thread (the main one, or a sub-agent). */
interface StreamCtx {
  /** Streaming tool-use blocks keyed by block index; args arrive as
   * input_json_delta fragments. */
  toolBlocks: Map<number, ToolBlock>;
  /** Set on `message_start`. Lets us ignore the SDK's whole-message echo of a
   * turn we already built from deltas. */
  streamed: boolean;
}

/** The `system`/`task_*` sub-agent lifecycle messages, loosely typed. */
interface TaskMessage {
  tool_use_id?: string;
  subagent_type?: string;
  description?: string;
  summary?: string;
}

/** The sidecar the CLI writes beside each sub-agent transcript. `toolUseId` is
 * the join we need and the only place it exists — the SDK lists sub-agent ids
 * but never says which tool call they came from. */
export interface AgentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
}

/** Parse an `agent-<id>.meta.json`, tolerating junk (best-effort diagnostics). */
export function parseAgentMeta(raw: string): AgentMeta | null {
  try {
    const meta = JSON.parse(raw) as AgentMeta;
    if (!meta || typeof meta !== "object") return null;
    return {
      agentType: typeof meta.agentType === "string" ? meta.agentType : undefined,
      description:
        typeof meta.description === "string" ? meta.description : undefined,
      toolUseId: typeof meta.toolUseId === "string" ? meta.toolUseId : undefined,
    };
  } catch {
    return null;
  }
}

/** One sub-agent transcript on disk: its id plus the labels from its sidecar. */
interface SubagentEntry {
  agentId: string;
  meta: AgentMeta;
}

/** Sub-agent transcripts live at
 * `~/.claude/projects/<projectKey>/<sessionId>/subagents/agent-<agentId>.jsonl`
 * (documented by the SDK). The project key is a mangled cwd, so rather than
 * reproduce that mangling we find the project dir holding this session — trying
 * the obvious key first, then scanning. */
async function subagentDir(
  cwd: string | undefined,
  sessionId: string,
): Promise<string | null> {
  return projectPath(cwd, (key) =>
    join(key, sessionId, "subagents"),
  );
}

/** The session's own transcript file, for the fields `getSessionMessages`
 * drops (see loadOrigins). */
async function sessionFile(
  cwd: string | undefined,
  sessionId: string,
): Promise<string | null> {
  return projectPath(cwd, (key) => join(key, `${sessionId}.jsonl`));
}

/** Resolve a path under the project dir holding this session, trying the key the
 * cwd mangles to before scanning. Keeps the CLI's cwd-mangling out of our code:
 * we probe rather than reproduce it. */
async function projectPath(
  cwd: string | undefined,
  rel: (projectKey: string) => string,
): Promise<string | null> {
  const projects = join(homedir(), ".claude", "projects");
  const at = (key: string) => join(projects, rel(key));
  const hint = cwd ? cwd.replace(/[^a-zA-Z0-9]/g, "-") : "";
  if (hint && existsSync(at(hint))) return at(hint);
  try {
    for (const key of await readdir(projects))
      if (existsSync(at(key))) return at(key);
  } catch {
    // No projects dir (or unreadable) — nothing to restore.
  }
  return null;
}

async function readAgentMeta(
  dir: string,
  agentId: string,
): Promise<AgentMeta | null> {
  try {
    return parseAgentMeta(
      await readFile(join(dir, `agent-${agentId}.meta.json`), "utf8"),
    );
  } catch {
    return null; // Best-effort: a missing sidecar just means no join.
  }
}

/** uuid → provenance, scraped from a session's own JSONL.
 *
 * `getSessionMessages` returns a `SessionMessage` that DROPS `origin`, so on the
 * resume path the SDK gives us no way to tell a prompt from an injected
 * background-task notification — which is exactly where the misattribution shows
 * (live, the SDK message still carries it). The CLI writes the field to disk, so
 * we read it back ourselves rather than guess from the message text.
 *
 * Best-effort by design: an unreadable/absent file yields an empty map and every
 * turn stays human, i.e. today's behaviour. */
export function parseOrigins(jsonl: string): Map<string, TurnOrigin> {
  const origins = new Map<string, TurnOrigin>();
  for (const line of jsonl.split("\n")) {
    if (!line.startsWith("{") || !line.includes('"origin"')) continue;
    try {
      const entry = JSON.parse(line) as { uuid?: unknown; origin?: TurnOrigin };
      if (typeof entry.uuid === "string" && entry.origin?.kind)
        origins.set(entry.uuid, entry.origin);
    } catch {
      // Truncated/!JSON line (the file is appended to live) — skip it.
    }
  }
  return origins;
}

/** Provenance stamp the CLI puts on a conversation turn (SDKMessageOrigin). */
interface TurnOrigin {
  kind?: unknown;
  body?: unknown;
}

/** One line for a finished background task. `summary` is the CLI's own
 * human-readable sentence; the status is only worth saying when it isn't a
 * plain completion. */
export function taskLine(task: {
  summary?: string;
  status?: string;
  description?: string;
}): string {
  const text = (task.summary ?? task.description ?? "").trim();
  if (!text) return task.status ? `Background task ${task.status}.` : "";
  return task.status && task.status !== "completed"
    ? `${text} (${task.status})`
    : text;
}

/** The tool call a notification envelope refers to, when it names one. Lets the
 * resume path skip a sub-agent's notification — live it went into the nested
 * transcript as that run's report, so replaying it as a system line too would
 * make a resumed session disagree with the one it's restoring. */
export function notificationToolId(text: string): string | undefined {
  return /<tool-use-id>([\s\S]*?)<\/tool-use-id>/.exec(text)?.[1]?.trim();
}

/** Did the human author this user turn?
 *
 * The CLI injects other things into the conversation as `user` entries — a
 * background task reporting completion, a peer/channel message — and marks them
 * with a non-`human` `origin.kind`. They look exactly like prompts otherwise
 * (prose content, their own uuid), so without this they render as bubbles the
 * user never sent AND, worse, count as rewind targets: `promptIds` and
 * `promptUuid`'s positional fallback would disagree and a rewind would fork the
 * session at the wrong turn.
 *
 * Absent origin means human: genuine prompts on the SDK path carry no origin at
 * all (verified against a real transcript), so only an explicit non-human
 * provenance is ever excluded. */
export function isHumanTurn(msg: unknown): boolean {
  const kind = (msg as { origin?: { kind?: unknown } } | null)?.origin?.kind;
  return kind === undefined || kind === null || kind === "human";
}

/** The readable line for a turn the human didn't author. Prefers what the SDK
 * already decoded (`origin.body`, the peer envelope stripped), then a
 * notification's own `<summary>`, and only then the raw text — these arrive as
 * machine-formatted blocks that would otherwise dump XML into the transcript. */
export function systemTurnText(msg: unknown): string {
  const m = msg as
    | { origin?: { body?: unknown }; message?: { content?: unknown } }
    | null
    | undefined;
  const body = m?.origin?.body;
  if (typeof body === "string" && body.trim()) return body.trim();
  const raw = userText(m?.message?.content);
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(raw)?.[1]?.trim();
  return summary || raw;
}

/** Which sub-agent an SDK message belongs to, or null for the main thread.
 * Every message variant carries `parent_tool_use_id`; the assistant/user ones
 * additionally name the agent kind and its task. */
export function subagentMeta(
  msg: unknown,
): { parentToolId: string; agentType?: string; description?: string } | null {
  const m = msg as {
    parent_tool_use_id?: unknown;
    subagent_type?: unknown;
    task_description?: unknown;
  } | null;
  const parent = m?.parent_tool_use_id;
  if (typeof parent !== "string" || !parent) return null;
  return {
    parentToolId: parent,
    agentType: typeof m?.subagent_type === "string" ? m.subagent_type : undefined,
    description:
      typeof m?.task_description === "string" ? m.task_description : undefined,
  };
}

function parseToolArgs(tool: ToolBlock): unknown {
  if (tool.json) {
    try {
      return JSON.parse(tool.json);
    } catch {
      // Fall back to whatever was present at block start.
    }
  }
  return tool.initialInput;
}

/** A content block of a replayed assistant message (loose shape — we read only
 * the fields we render). */
interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

/** Extract the user-authored text from a message's content (string, or an array
 * of text blocks). Tool-result blocks are ignored — they aren't user prose. */
function userText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((block: { type?: string; text?: string }) =>
      block?.type === "text" && typeof block.text === "string" ? block.text : "",
    )
    .join("")
    .trim();
}

/** Flatten tool-result content — a string or an array of text blocks. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: { type?: string; text?: string }) =>
      block?.type === "text" && typeof block.text === "string" ? block.text : "",
    )
    .join("");
}

// --- Loose shapes of the Anthropic stream events we read off SDK messages ----

interface StreamEvent {
  type?: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string; input?: unknown };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
  };
}

interface ToolResultBlock {
  type?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}
