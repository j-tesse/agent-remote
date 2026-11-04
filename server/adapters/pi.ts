import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HarnessConfig } from "../config.js";
import type {
  ChatAction,
  ChatEvent,
  ChatImageRef,
  ChatModel,
  ChatUiOption,
  ChatUiRequest,
} from "../../shared/protocol.js";
import { promptParts } from "../../shared/chat.js";
import { effortOption } from "./effort.js";
import type {
  ChatTranslator,
  HarnessAdapter,
  SessionOptions,
} from "./types.js";

// Adapter for pi (https://github.com/getpi/pi): runs headless via `pi --mode
// rpc` (JSONL over stdin/stdout), rendered as chat bubbles. The ONLY place that
// knows pi's RPC vocabulary; the translator maps it to/from the chat schema.
// Protocol ref: pi's docs/rpc.md. Framing is strict JSONL, LF-delimited
// (tolerate trailing CR). NOT Node readline — it also splits on U+2028/U+2029,
// valid inside JSON strings.
export function createPiAdapter(cfg: HarnessConfig): HarnessAdapter {
  return {
    id: "pi",
    name: "pi",
    // pi resumes via a caller-chosen `--session-id`: the session layer mints one
    // (also our resume key) and threads it in through `opts.resume`.
    resumable: true,
    // Catalog labels are raw served ids (`RedHatAI/gemma-4-31B-it-NVFP4`).
    llmModelNames: true,
    appendsSystemPrompt: true,
    invocation(opts: SessionOptions): { command: string; args: string[] } {
      const args = ["--mode", "rpc"];
      if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
      // `--session-id` creates the session if missing and reloads it (restoring
      // context) when it already exists — same flag for fresh and resumed runs.
      if (opts.resume) args.push("--session-id", opts.resume);
      return { command: cfg.command, args };
    },
    createChatTranslator(opts: SessionOptions): ChatTranslator {
      return new PiRpcTranslator(opts.cwd);
    },
  };
}

/** Loose shape of one parsed pi RPC stdout line. Only the fields we consume
 * are typed; everything else stays unknown. */
interface PiLine {
  type?: string;
  // message_start/update/end carry an object; extension_ui_request confirm and
  // notify reuse the same field name for a string body.
  message?: { role?: string } | string;
  assistantMessageEvent?: {
    type?: string;
    delta?: string;
    toolCall?: { id?: string; name?: string; arguments?: unknown };
  };
  // tool_execution_*
  toolCallId?: string;
  toolName?: string;
  partialResult?: { content?: unknown };
  result?: { content?: unknown };
  isError?: boolean;
  // queue_update
  steering?: string[];
  followUp?: string[];
  // extension_ui_request
  id?: string;
  method?: string;
  title?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  notifyType?: string;
  // response
  command?: string;
  success?: boolean;
  // get_commands → {commands}; get_available_models → {models}; get_state →
  // {model,…}; set_model → the Model object itself (no wrapper — verified live).
  data?: {
    commands?: { name?: string; description?: string }[];
    models?: PiModel[];
    model?: PiModel | null;
    thinkingLevel?: string;
  } & PiModel;
  // thinking_level_changed
  level?: string;
  // auto_retry_start / auto_retry_end / extension_error / compaction_end
  error?: string;
  errorMessage?: string;
  attempt?: number;
  maxAttempts?: number;
  finalError?: string;
  // agent_end: an automatic retry (transient error / overflow compaction) is
  // about to follow, so the run isn't finished — keep busy held until settled.
  willRetry?: boolean;
}

/** One pi Model object, trimmed to the fields the menu reads. pi's full shape
 * (api/baseUrl/cost/compat/…) is deliberately left unknown. */
interface PiModel {
  id?: string;
  name?: string;
  provider?: string;
  contextWindow?: number;
  reasoning?: boolean;
  /** Level → provider value; `null` removes a level, xhigh/max need an entry. */
  thinkingLevelMap?: Record<string, string | null>;
}

class PiRpcTranslator implements ChatTranslator {
  /** Session cwd — only for locating pi's project-scoped settings. */
  constructor(private readonly cwd = "") {}
  private lineBuffer = "";
  /** Current model as a composite `provider/id`, or null until pi says.
   * Held here because pi's `models` event carries the current selection and the
   * reducer's fold overwrites it — see the out-of-order note on `init`. */
  private currentModel: string | null = null;
  /** Whether the user has switched model in this session. Once they have, a
   * `get_state` reply is stale by definition and must not revert the menu. */
  private modelChosen = false;
  /** Thinking levels the current model offers (empty = no picker) + the level.
   * Held for the same reason as `currentModel`: the replies race. */
  private effortLevels: string[] = [];
  private currentEffort: string | null = null;
  /** Once pi has pushed `thinking_level_changed`, a get_state level is stale. */
  private effortSeen = false;
  /** Whether pi is currently running an agent loop; decides whether a prompt
   * must be sent with streamingBehavior (pi rejects a bare prompt mid-run).
   * Held from agent_start until agent_settled (NOT the earlier agent_end, which
   * may be followed by an automatic retry / compaction / queued continuation),
   * so the busy indicator doesn't flicker to idle mid-run. */
  private busy = false;
  /** Whether an assistant message is currently streaming (only assistant
   * message_start/end are surfaced; user/toolResult messages are not). */
  private assistantOpen = false;

  /** Query the slash commands (extension commands, prompt templates, skills)
   * and the model catalog + current selection once at startup, so the UI can
   * offer a `/` palette and a model switcher.
   *
   * pi answers these **out of order** (verified live: a `get_state` came back
   * ahead of a `set_model` sent before it), so nothing here may assume the
   * replies arrive in the order asked — see `currentModel`. */
  init(): string {
    return [
      { type: "get_commands" },
      { type: "get_available_models" },
      { type: "get_state" },
    ]
      .map((cmd) => `${JSON.stringify(cmd)}\n`)
      .join("");
  }

  /** Rebuild a resumed conversation from pi's on-disk session JSONL — the RPC
   * stream doesn't replay history on `--session-id` reload. Best-effort: any
   * read/parse failure yields an empty transcript (context is still restored). */
  async replayHistory(opts: SessionOptions): Promise<ChatEvent[]> {
    if (!opts.resume) return [];
    return readPiSessionHistory(opts.cwd, opts.resume);
  }

  push(chunk: string): ChatEvent[] {
    this.lineBuffer += chunk;
    const events: ChatEvent[] = [];
    for (;;) {
      const nl = this.lineBuffer.indexOf("\n");
      if (nl === -1) break;
      let line = this.lineBuffer.slice(0, nl);
      this.lineBuffer = this.lineBuffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      let parsed: PiLine;
      try {
        parsed = JSON.parse(line) as PiLine;
      } catch {
        continue; // Not protocol JSON (e.g. stray debug print); skip.
      }
      events.push(...this.translate(parsed));
    }
    return events;
  }

  encode(action: ChatAction): { data: string; events: ChatEvent[] } {
    switch (action.type) {
      case "prompt": {
        // pi's RPC `prompt`/`steer` accept an optional `images` array of
        // ImageContent blocks (base64). Include only images the server resolved.
        const images = piImages(action.images);
        const base = this.busy
          ? // Queue behind the current run; delivered between turns.
            { type: "prompt", message: action.text, streamingBehavior: "steer" }
          : { type: "prompt", message: action.text };
        const cmd = images.length ? { ...base, images } : base;
        return {
          data: `${JSON.stringify(cmd)}\n`,
          // Echo the prompt as a user bubble immediately: pi does not stream
          // user messages back over RPC.
          events: [
            {
              type: "user-message",
              message: {
                id: randomUUID(),
                role: "user",
                parts: promptParts(action.text, action.images),
                createdAt: Date.now(),
              },
            },
          ],
        };
      }
      case "abort":
        return { data: '{"type":"abort"}\n', events: [] };
      case "ui-response": {
        const cmd: Record<string, unknown> = {
          type: "extension_ui_response",
          id: action.requestId,
        };
        if (action.cancelled) cmd.cancelled = true;
        else if (action.confirmed !== undefined) cmd.confirmed = action.confirmed;
        else cmd.value = action.value;
        return {
          data: `${JSON.stringify(cmd)}\n`,
          // Clear the card right away; pi sends no acknowledgment.
          events: [{ type: "ui-request-done", requestId: action.requestId }],
        };
      }
      case "set-model": {
        // pi addresses a model by provider + id, so the menu id carries both.
        const target = parsePiModelId(action.model);
        if (!target) return { data: "", events: [] };
        return {
          data: `${JSON.stringify({
            type: "set_model",
            provider: target.provider,
            modelId: target.modelId,
          })}\n`,
          // No optimistic event: pi's reply confirms the switch (or reports
          // "Model not found", which the generic response branch surfaces).
          events: [],
        };
      }
      case "set-effort":
        return {
          data: `${JSON.stringify({ type: "set_thinking_level", level: action.effort })}\n`,
          // No optimistic event: pi pushes thinking_level_changed when it
          // changes, and a clamped no-op correctly leaves the menu alone.
          events: [],
        };
      default:
        return { data: "", events: [] };
    }
  }

  private translate(line: PiLine): ChatEvent[] {
    switch (line.type) {
      case "agent_start":
        this.busy = true;
        return [{ type: "busy", busy: true }];
      case "agent_end": {
        // One low-level run finished; its assistant message is closed. But if a
        // retry is queued, the loop continues — stay busy so the UI doesn't drop
        // to idle between the failure and the retry.
        this.assistantOpen = false;
        if (line.willRetry) return [];
        this.busy = false;
        return [{ type: "busy", busy: false }];
      }
      case "agent_settled":
        // Authoritative end of the whole run (no retry/compaction/queue left).
        // Idempotent with agent_end; also the safety net that guarantees busy
        // clears even after a retry or compaction continuation.
        this.busy = false;
        return [{ type: "busy", busy: false }];

      case "message_start":
        if (messageRole(line.message) !== "assistant") return [];
        this.assistantOpen = true;
        return [{ type: "assistant-start", messageId: randomUUID() }];
      case "message_end":
        if (messageRole(line.message) !== "assistant" || !this.assistantOpen)
          return [];
        this.assistantOpen = false;
        return [{ type: "assistant-end" }];

      case "message_update": {
        if (!this.assistantOpen) return [];
        const delta = line.assistantMessageEvent;
        switch (delta?.type) {
          case "text_start":
            return [{ type: "part-start", kind: "text" }];
          case "thinking_start":
            return [{ type: "part-start", kind: "thinking" }];
          // The kind must be carried through: pi reads a chunk's `content`
          // before its `reasoning*` fields, so a chunk straddling </think>
          // (common with speculative decoding, where one chunk spans several
          // tokens) yields text_start + text_delta and only *then* the
          // thinking_delta holding the reasoning tail. Routing that by arrival
          // order lands it in the answer bubble.
          case "text_delta":
            return delta.delta
              ? [{ type: "part-delta", kind: "text", delta: delta.delta }]
              : [];
          case "thinking_delta":
            return delta.delta
              ? [{ type: "part-delta", kind: "thinking", delta: delta.delta }]
              : [];
          case "toolcall_end": {
            const call = delta.toolCall;
            if (!call?.id) return [];
            return [
              {
                type: "tool-call",
                toolId: call.id,
                name: call.name ?? "tool",
                args: call.arguments,
              },
            ];
          }
          default:
            return [];
        }
      }

      case "tool_execution_start":
        if (!line.toolCallId) return [];
        return [{ type: "tool-update", toolId: line.toolCallId, output: "" }];
      case "tool_execution_update":
        if (!line.toolCallId) return [];
        return [
          {
            type: "tool-update",
            toolId: line.toolCallId,
            output: contentText(line.partialResult?.content),
          },
        ];
      case "tool_execution_end":
        if (!line.toolCallId) return [];
        return [
          {
            type: "tool-end",
            toolId: line.toolCallId,
            output: contentText(line.result?.content),
            isError: line.isError === true,
          },
        ];

      case "queue_update":
        return [
          {
            type: "queue",
            queued: [...(line.steering ?? []), ...(line.followUp ?? [])],
          },
        ];

      case "extension_ui_request":
        return this.translateUiRequest(line);

      case "response":
        // get_commands reply → surface the slash-command palette.
        if (line.command === "get_commands" && line.data?.commands) {
          return [
            {
              type: "commands",
              commands: line.data.commands
                .filter((c): c is { name: string; description?: string } =>
                  typeof c.name === "string" && c.name.length > 0,
                )
                .map((c) => ({ name: c.name, description: c.description })),
            },
          ];
        }
        // get_available_models reply → the model switcher's menu. Restate the
        // current model: the `models` fold overwrites it, so a list landing
        // after get_state would otherwise blank the selection.
        if (line.command === "get_available_models" && line.data?.models) {
          return [
            {
              type: "models",
              models: piModels(line.data.models, readEnabledPatterns(this.cwd)),
              current: this.currentModel,
            },
          ];
        }
        // get_state reply → which model the session started on. Skipped once the
        // user has switched: pi's replies race, so a get_state in flight when
        // the switch landed reports the *old* model and would revert the menu.
        if (line.command === "get_state" && line.success !== false) {
          const events = this.modelChanged(line.data?.model, false);
          if (!this.effortSeen && typeof line.data?.thinkingLevel === "string")
            this.currentEffort = line.data.thinkingLevel;
          // The model half is latched by modelChanged; only a model we adopted
          // may set the level list.
          if (!this.modelChosen && line.data?.model)
            events.push(...this.effortsFor(line.data.model));
          return events;
        }
        // set_model reply → `data` IS the Model object (not `{model}`).
        if (line.command === "set_model" && line.success !== false)
          return [
            ...this.modelChanged(line.data, true),
            ...(line.data ? this.effortsFor(line.data) : []),
          ];
        // Other command acknowledgments are uninteresting unless they failed.
        return line.success === false && line.error
          ? [{ type: "notice", level: "error", text: line.error }]
          : [];

      case "thinking_level_changed":
        if (typeof line.level !== "string") return [];
        this.effortSeen = true;
        this.currentEffort = line.level;
        // No picker shown → nothing to update.
        return this.effortLevels.length
          ? [{ type: "effort-changed", current: line.level }]
          : [];

      case "auto_retry_start":
        return [
          {
            type: "notice",
            level: "warning",
            text: `Retrying after error (attempt ${line.attempt ?? "?"}/${line.maxAttempts ?? "?"})…`,
          },
        ];
      case "auto_retry_end":
        // A retry either recovered or gave up after max attempts. Surface both
        // so a run that silently died after retries isn't a mystery.
        return line.success
          ? [
              {
                type: "notice",
                level: "info",
                text: `Recovered after retry (attempt ${line.attempt ?? "?"}).`,
              },
            ]
          : [
              {
                type: "notice",
                level: "error",
                text: `Retry failed after ${line.attempt ?? "?"} attempt(s): ${line.finalError ?? "unknown error"}`,
              },
            ];
      case "extension_error":
        return [
          {
            type: "notice",
            level: "warning",
            text: `Extension error: ${line.error ?? "unknown"}`,
          },
        ];
      case "compaction_start":
        return [
          { type: "notice", level: "info", text: "Compacting context…" },
        ];
      case "compaction_end":
        return line.errorMessage
          ? [
              {
                type: "notice",
                level: "error",
                text: `Compaction failed: ${line.errorMessage}`,
              },
            ]
          : [{ type: "notice", level: "info", text: "Context compacted." }];

      default:
        return [];
    }
  }

  /** Adopt a model pi reported. `chosen` marks it as the user's own pick, which
   * latches out later (racing) `get_state` replies. */
  private modelChanged(model: PiModel | null | undefined, chosen: boolean): ChatEvent[] {
    if (chosen) this.modelChosen = true;
    else if (this.modelChosen) return [];
    const id = model ? piModelId(model) : null;
    if (!id) return [];
    // A confirmed switch is always reported, even when it lands on the model
    // already in use: the user asked and pi answered, so the UI must settle on
    // that. Only an unsolicited state echo is deduped.
    if (!chosen && id === this.currentModel) return [];
    this.currentModel = id;
    return [{ type: "model-changed", current: id }];
  }

  /** Level list for `model`, emitted only when it changes. A model without
   * reasoning offers just "off" — no choice, so no picker. */
  private effortsFor(model: PiModel): ChatEvent[] {
    const all = piThinkingLevels(model);
    const levels = all.length > 1 ? all : [];
    if (levels.join() === this.effortLevels.join()) return [];
    this.effortLevels = levels;
    return [
      {
        type: "efforts",
        efforts: levels.map(effortOption),
        current: this.currentEffort,
      },
    ];
  }

  private translateUiRequest(line: PiLine): ChatEvent[] {
    if (!line.id) return [];
    switch (line.method) {
      case "confirm":
      case "select":
      case "input":
      case "editor": {
        const request: ChatUiRequest = {
          id: line.id,
          // pi's multi-line "editor" degrades to a plain input field.
          kind: line.method === "editor" ? "input" : line.method,
          title: line.title ?? "Agent request",
          message: typeof line.message === "string" ? line.message : undefined,
          options: piOptions(line.options),
          placeholder: line.placeholder ?? line.prefill,
        };
        return [{ type: "ui-request", request }];
      }
      case "notify": {
        const level =
          line.notifyType === "warning" || line.notifyType === "error"
            ? line.notifyType
            : "info";
        const text = typeof line.message === "string" ? line.message : "";
        return text ? [{ type: "notice", level, text }] : [];
      }
      default:
        // setStatus/setWidget/setTitle/set_editor_text: fire-and-forget TUI
        // affordances with no chat equivalent.
        return [];
    }
  }
}

// pi sends bare option strings and expects the chosen one echoed back verbatim,
// so the label doubles as the value. Refusal-ish labels get `reject` intent so
// the UI asks for a reason, as it does for claude's Deny.
const PI_REJECT = new Set(["deny", "no", "reject", "decline"]);
const PI_CANCEL = new Set(["cancel", "abort", "dismiss"]);

function piOptions(options: string[] | undefined): ChatUiOption[] | undefined {
  return options?.map((o) => {
    const key = o.trim().toLowerCase();
    return {
      value: o,
      label: o,
      intent: PI_REJECT.has(key)
        ? ("reject" as const)
        : PI_CANCEL.has(key)
          ? ("cancel" as const)
          : ("accept" as const),
    };
  });
}

// --- model menu -------------------------------------------------------------
//
// pi addresses a model by (provider, id), but `ChatModel.id` is a single opaque
// string, so the menu id is the composite `provider/id` — which is also pi's own
// `--model provider/id` syntax. It splits at the FIRST slash: a provider name
// never contains one, while ids routinely do ("deepseek-ai/DeepSeek-V4-Pro").
// The provider rides in `ChatModel.group`, not the label: the UI gives a
// grouped catalog its own provider box, so a suffix would just be redundant
// (and it's what made labels long enough to overflow the header).

// Providers that run on this machine. Listed first because they're free and
// always reachable; everything else follows alphabetically. Knowing which
// provider names are local is pi vocabulary, so it stays here — the UI only
// ever replays the order this array produces.
const LOCAL_PROVIDERS = ["vllm", "ollama", "llamacpp", "lmstudio"];

function providerRank(provider: string): number {
  const i = LOCAL_PROVIDERS.indexOf(provider);
  return i === -1 ? LOCAL_PROVIDERS.length : i;
}

/** Composite menu id for a pi model, or null if it can't be addressed. */
export function piModelId(m: PiModel): string | null {
  return m.id && m.provider ? `${m.provider}/${m.id}` : null;
}

/** Mirrors pi-ai's `getSupportedThinkingLevels`, from the Model object pi
 * already sends — saves a `get_available_thinking_levels` round trip per switch
 * (a translator can't issue one from a reply anyway). */
const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export function piThinkingLevels(m: PiModel): string[] {
  if (!m.reasoning) return ["off"];
  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = m.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/** Split a composite menu id back into pi's (provider, modelId) pair. */
export function parsePiModelId(
  id: string,
): { provider: string; modelId: string } | null {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return null;
  return { provider: id.slice(0, slash), modelId: id.slice(slash + 1) };
}

// --- enabled/disabled sections ----------------------------------------------
//
// pi's TUI narrows `/model` to `enabledModels` (settings) — a curation layer its
// RPC never exposes (see AGENTS.md). We show the whole catalog but split each
// provider into Enabled/Disabled, mirroring `resolveModelScopeFromModels`.
// A mis-match is cosmetic (the model still lists and still works), which is why
// approximating pi's matcher is an acceptable trade where *filtering* wasn't.

export const SECTION_ENABLED = "Enabled";
export const SECTION_DISABLED = "Disabled";

/** pi appends an optional `:<thinkingLevel>` to a pattern; it doesn't select. */
const THINKING_LEVELS = new Set([
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
]);

function stripThinking(pattern: string): string {
  const colon = pattern.lastIndexOf(":");
  if (colon === -1) return pattern;
  return THINKING_LEVELS.has(pattern.slice(colon + 1).toLowerCase())
    ? pattern.slice(0, colon)
    : pattern;
}

/** minimatch subset: `*`/`?` stop at `/` (so `anthropic/*` can't span one),
 * `**` spans. Enough for the documented `anthropic/*` / `*sonnet*` forms. */
function globToRe(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

const isGlob = (p: string) => /[*?[]/.test(p);
const ref = (m: PiModel) => `${m.provider}/${m.id}`.toLowerCase();

/** Models one `enabledModels` pattern selects, following pi's precedence:
 * canonical `provider/id` → bare `id` (only when unambiguous) → glob over both. */
function matchPattern(pattern: string, models: PiModel[]): PiModel[] {
  const p = stripThinking(pattern).trim().toLowerCase();
  if (!p) return [];
  const canonical = models.filter((m) => ref(m) === p);
  if (canonical.length === 1) return canonical;
  if (canonical.length > 1) return []; // pi rejects an ambiguous reference
  if (!isGlob(p)) {
    const byId = models.filter((m) => (m.id ?? "").toLowerCase() === p);
    return byId.length === 1 ? byId : [];
  }
  const re = globToRe(p);
  return models.filter((m) => re.test(ref(m)) || re.test((m.id ?? "").toLowerCase()));
}

/** Composite ids of every model pi's `enabledModels` patterns select. */
export function enabledModelIds(
  patterns: string[] | undefined,
  models: PiModel[],
): Set<string> {
  const ids = new Set<string>();
  for (const pattern of patterns ?? [])
    for (const m of matchPattern(pattern, models)) {
      const id = piModelId(m);
      if (id) ids.add(id);
    }
  return ids;
}

/** `enabledModels` as pi resolves it: the project file replaces the global one
 * wholesale (settings deep-merge, but arrays override). Best-effort — an
 * unreadable/absent file just means "no curation", i.e. one Enabled-less list. */
export function readEnabledPatterns(cwd: string): string[] | undefined {
  // No cwd = no session context (pure tests build the adapter bare); never
  // reach for the developer's own settings from there.
  if (!cwd) return undefined;
  const read = (path: string): string[] | undefined => {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        enabledModels?: unknown;
      };
      const list = parsed.enabledModels;
      return Array.isArray(list) && list.every((p) => typeof p === "string")
        ? (list as string[])
        : undefined;
    } catch {
      return undefined;
    }
  };
  return (
    read(join(cwd, ".pi", "settings.json")) ??
    read(join(homedir(), ".pi", "agent", "settings.json"))
  );
}

/** Tooltip detail: context window and whether the model reasons. */
function piModelDescription(m: PiModel): string {
  const bits: string[] = [];
  if (m.contextWindow) bits.push(`${Math.round(m.contextWindow / 1000)}K context`);
  if (m.reasoning) bits.push("reasoning");
  return bits.join(" · ");
}

/** pi's model catalog as menu entries: local providers first, then the rest
 * alphabetically, and within each provider the `enabledModels` ones first.
 * Entries pi can't address are dropped rather than guessed at. */
export function piModels(
  models: PiModel[],
  enabledPatterns?: string[],
): ChatModel[] {
  const enabled = enabledModelIds(enabledPatterns, models);
  // No curation configured → no sections at all, rather than calling every
  // model "Disabled" (pi would show them all too).
  const sectioned = enabled.size > 0;
  const entries: (ChatModel & { group: string; rank: number })[] = [];
  for (const m of models) {
    const id = piModelId(m);
    if (!id) continue;
    const on = enabled.has(id);
    entries.push({
      id,
      label: m.name || (m.id as string),
      description: piModelDescription(m),
      group: m.provider as string,
      rank: sectioned && !on ? 1 : 0,
      ...(sectioned
        ? { section: on ? SECTION_ENABLED : SECTION_DISABLED }
        : {}),
    });
  }
  // Stable, so a provider's models keep the order pi listed them in.
  return entries
    .sort(
      (a, b) =>
        providerRank(a.group) - providerRank(b.group) ||
        a.group.localeCompare(b.group) ||
        a.rank - b.rank,
    )
    .map(({ rank: _rank, ...m }) => m);
}

function messageRole(message: PiLine["message"]): string | undefined {
  return typeof message === "object" ? message?.role : undefined;
}

// --- resume: read pi's on-disk session transcript ---------------------------

/** One persisted content block inside a pi session `message` line. */
interface PiStoredBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}
/** One persisted `message` line in a pi session JSONL file. */
interface PiStoredMessage {
  type?: string;
  message?: {
    role?: string;
    content?: PiStoredBlock[];
    // toolResult lines carry the linkage/result at the message level.
    toolCallId?: string;
    isError?: boolean;
  };
}

/** Root of pi's session store (project subdirs live under here). */
function piSessionsRoot(): string {
  return join(homedir(), ".pi", "agent", "sessions");
}

/** pi mangles a project cwd into a session subdir name: `--` + path segments
 * joined by `-` + `--` (e.g. `/tmp/x-y` → `--tmp-x-y--`). */
function mangleCwd(cwd: string): string {
  return `--${cwd.split("/").filter(Boolean).join("-")}--`;
}

/** Locate the JSONL file for a session id: try the mangled project subdir
 * first, then fall back to scanning every subdir (ids are UUIDs — unique). */
function findSessionFile(cwd: string, sessionId: string): string | undefined {
  const root = piSessionsRoot();
  const suffix = `_${sessionId}.jsonl`;
  const inDir = (dir: string): string | undefined => {
    try {
      const name = readdirSync(dir).find((f) => f.endsWith(suffix));
      return name ? join(dir, name) : undefined;
    } catch {
      return undefined;
    }
  };
  const preferred = inDir(join(root, mangleCwd(cwd)));
  if (preferred) return preferred;
  let subdirs: string[];
  try {
    subdirs = readdirSync(root);
  } catch {
    return undefined;
  }
  for (const sub of subdirs) {
    const hit = inDir(join(root, sub));
    if (hit) return hit;
  }
  return undefined;
}

/** Parse a pi session file into normalized chat events, folding whole stored
/** Map resolved image refs to pi's ImageContent wire format for a prompt/steer
 * command. Images without server-resolved `data` are skipped. */
export function piImages(
  images?: ChatImageRef[],
): { type: "image"; data: string; mimeType: string }[] {
  return (images ?? [])
    .filter((i) => i.data)
    .map((i) => ({ type: "image", data: i.data as string, mimeType: i.mediaType }));
}

/** Replay a pi session's on-disk history as ChatEvents. Re-runs stored
 * messages through the same event vocabulary the live stream produces so
 * replayed bubbles match freshly-streamed ones. */
function readPiSessionHistory(cwd: string, sessionId: string): ChatEvent[] {
  const file = findSessionFile(cwd, sessionId);
  if (!file) return [];
  let lines: string[];
  try {
    lines = readFileSync(file, "utf8").split("\n");
  } catch {
    return [];
  }
  const events: ChatEvent[] = [];
  for (const raw of lines) {
    if (!raw) continue;
    let entry: PiStoredMessage;
    try {
      entry = JSON.parse(raw) as PiStoredMessage;
    } catch {
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const msg = entry.message;
    const content = Array.isArray(msg.content) ? msg.content : [];
    if (msg.role === "user") {
      const text = content
        .map((b) => (b.type === "text" ? (b.text ?? "") : ""))
        .join("");
      if (text)
        events.push({
          type: "user-message",
          message: {
            id: randomUUID(),
            role: "user",
            parts: [{ type: "text", text }],
            createdAt: Date.now(),
          },
        });
    } else if (msg.role === "assistant") {
      events.push({ type: "assistant-start", messageId: randomUUID() });
      for (const block of content) {
        if (block.type === "text" && block.text) {
          events.push({ type: "part-start", kind: "text" });
          events.push({ type: "part-delta", kind: "text", delta: block.text });
        } else if (block.type === "thinking" && block.thinking) {
          events.push({ type: "part-start", kind: "thinking" });
          events.push({
            type: "part-delta",
            kind: "thinking",
            delta: block.thinking,
          });
        } else if (block.type === "toolCall" && block.id) {
          events.push({
            type: "tool-call",
            toolId: block.id,
            name: block.name ?? "tool",
            args: block.arguments,
          });
        }
      }
      events.push({ type: "assistant-end" });
    } else if (msg.role === "toolResult" && msg.toolCallId) {
      events.push({
        type: "tool-end",
        toolId: msg.toolCallId,
        output: contentText(content),
        isError: msg.isError === true,
      });
    }
  }
  return events;
}

/** Flatten pi's tool-result content (array of text/image blocks) to text. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block: { type?: string; text?: string }) =>
      block?.type === "text" && typeof block.text === "string"
        ? block.text
        : "",
    )
    .join("");
}
