// Chat-state reducer run identically by server and client. The server folds
// adapter events into per-session ChatState (browser gets one snapshot, not an
// event log); the browser applies the same reducer to live events.

import type {
  AgentRun,
  AssistantSettings,
  ChatEvent,
  ChatImageRef,
  ChatMessage,
  ChatPart,
  ChatState,
} from "./protocol.js";

/** The parts of a user prompt bubble: the text (if any) followed by one image
 * part per attached image. Image parts carry only a lightweight reference
 * (never base64) plus the auth-gated serve URL. Shared by the harness adapters
 * (echoing the just-sent prompt) so the transcript shows what was sent. */
export function promptParts(text: string, images?: ChatImageRef[]): ChatPart[] {
  const parts: ChatPart[] = [];
  if (text) parts.push({ type: "text", text });
  for (const img of images ?? []) {
    parts.push({
      type: "image",
      id: img.id,
      mediaType: img.mediaType,
      name: img.name,
      url: `/api/upload/${img.id}`,
    });
  }
  // A prompt with neither text nor images shouldn't happen, but keep a text
  // part so the bubble is never empty.
  if (parts.length === 0) parts.push({ type: "text", text });
  return parts;
}

/** Assistant-mode instruction that means "skip the LLM, accept every permission
 * card". Deliberately a plain phrase: the dialog's checkbox just writes it into
 * the instructions, so typing it by hand works identically. */
export const ALLOW_EVERYTHING = "allow everything";

/** Is assistant mode in blanket-accept mode? (Trailing punctuation tolerated so
 * "Allow everything." counts.) */
export function isAllowEverything(instructions: string | undefined): boolean {
  return (
    (instructions ?? "").trim().toLowerCase().replace(/[.!]+$/, "").trim() ===
    ALLOW_EVERYTHING
  );
}

/** Auto-accept grace window: 2s (trivial card) … 10s (a screenful) — the time
 * a watching human gets to take over — times a user-set scale
 * (`permissions.delayScale`, 0–2). Scales the whole curve, floor included;
 * clamped here since it's client-set. */
export const AUTO_DELAY_MAX_SCALE = 2;
/** What the UI shows as the 100% wait: roughly a typical permission card's,
 * not the cap. Display anchor only — the curve below is what's applied. */
export const AUTO_DELAY_TYPICAL_SEC = 5;
/** Content size that earns the full window (~a screenful of tool args). */
const AUTO_ACTION_REF_CHARS = 681;

export function autoActionDelayMs(chars: number, scale?: number): number {
  const k = Number.isFinite(scale)
    ? Math.min(AUTO_DELAY_MAX_SCALE, Math.max(0, scale!))
    : 1;
  const ratio = Math.min(1, Math.max(0, chars) / AUTO_ACTION_REF_CHARS);
  return Math.round((2 + 8 * ratio) * k * 1000);
}

/** The master switch is derived, never stored independently: AI mode is on iff
 * some capability is. The manager recomputes it on every `set-assistant` so a
 * client can't desync it from the checklist. */
export function deriveAssistantEnabled(s: AssistantSettings): boolean {
  return (
    s.permissions.enabled ||
    s.questions.enabled ||
    s.autoPr.enabled ||
    s.continuity.enabled
  );
}

/** Does this configuration need the LLM endpoint to do anything? Auto-PR runs
 * without it, blanket-accept permissions bypass it, questions always need it —
 * and continuity can't write a prompt without it at all. */
export function assistantNeedsLlm(s: AssistantSettings): boolean {
  if (s.questions.enabled || s.continuity.enabled) return true;
  return s.permissions.enabled && !isAllowEverything(s.permissions.instructions);
}

/** Nothing said, nothing running, nothing waiting — safe to close as a side
 * effect (resume replacing the tab it was launched from). Draft/notices don't
 * count: the draft is usually just the `/resume` that launched it. */
export function isEmptyChat(s: ChatState): boolean {
  return (
    s.messages.length === 0 &&
    !s.streaming &&
    !s.busy &&
    s.pendingRequests.length === 0 &&
    s.queued.length === 0
  );
}

/** Bounds to keep memory in check on long-running sessions. */
const MAX_MESSAGES = 200;
const MAX_TOOL_OUTPUT = 20_000;
const MAX_NOTICES = 20;
const MAX_TRACES = 20;
const MAX_AGENTS = 30;

export function emptyChatState(): ChatState {
  return {
    messages: [],
    streaming: null,
    busy: false,
    pendingRequests: [],
    queued: [],
    notices: [],
    models: [],
    currentModel: null,
    modelNames: {},
    modes: [],
    currentMode: null,
    efforts: [],
    currentEffort: null,
    commands: [],
    usage: null,
    promptSuggestions: [],
    // Every capability starts OFF, so the derived master switch does too and
    // nothing is auto-answered until it's ticked. Their sub-options are
    // pre-set to the settings a user who ticks one almost always wants:
    // blanket-accept permissions, and auto-merge for auto-PR. Inert while the
    // capability above them is off. Mirrored by DEFAULT_ASSISTANT in App.tsx.
    assistant: {
      enabled: false,
      permissions: { enabled: false, instructions: ALLOW_EVERYTHING },
      questions: { enabled: false, instructions: "", onlyIfSure: false },
      autoPr: { enabled: false, instructions: "", autoMerge: true },
      continuity: { enabled: false, instructions: "", newSession: "after-pr" },
    },
    autoDecisions: {},
    assistantTraces: [],
    capabilities: {},
    rewindPreview: null,
    draft: "",
    autoPrompt: null,
    agents: {},
  };
}

/** Apply one event, returning a new state object (structural sharing where
 * possible so React consumers re-render cheaply). Unknown/ill-timed events
 * are ignored rather than thrown: the stream comes from an external process. */
export function applyChatEvent(state: ChatState, event: ChatEvent): ChatState {
  switch (event.type) {
    case "user-message": {
      const messages = capMessages([...state.messages, event.message]);
      // A system turn (a notification the conversation received) is transcript
      // only: it isn't a prompt, so it must not consume the armed auto-prompt or
      // invalidate the suggestions the last real turn produced.
      if (event.message.role === "system") return { ...state, messages };
      return {
        ...state,
        messages,
        // A new prompt makes the prior turn's suggestions stale — drop them.
        promptSuggestions: [],
        // A prompt sent is an armed auto-prompt spent, whoever sent it.
        autoPrompt: null,
      };
    }

    case "busy": {
      if (event.busy) return { ...state, busy: true };
      // Going idle: flush any half-streamed assistant message into history so
      // an abort (which may skip assistant-end) never leaves it stuck — but
      // only if it has visible content (empty parts → no blank bubble).
      const flushed = state.streaming
        ? { ...state.streaming, parts: finalizeParts(state.streaming.parts) }
        : null;
      const messages =
        flushed && flushed.parts.length > 0
          ? capMessages([...state.messages, flushed])
          : state.messages;
      return { ...state, busy: false, streaming: null, queued: [], messages };
    }

    case "assistant-start":
      return {
        ...state,
        // If a previous streaming message was never closed, keep it.
        messages: state.streaming
          ? capMessages([...state.messages, state.streaming])
          : state.messages,
        streaming: {
          id: event.messageId,
          role: "assistant",
          parts: [],
          createdAt: Date.now(),
        },
      };

    case "part-start": {
      if (!state.streaming) return state;
      const part: ChatPart = { type: event.kind, text: "" };
      return {
        ...state,
        streaming: {
          ...state.streaming,
          parts: [...dropEmptyThinking(state.streaming.parts), part],
        },
      };
    }

    case "part-delta": {
      const msg = state.streaming;
      if (!msg) return state;
      // Route to the last part of the delta's own kind, not to whatever part
      // happens to be last. A harness that reads a mixed reasoning+content
      // chunk field-by-field can emit a thinking delta *after* the text part
      // has opened; appending by position would splice reasoning into the
      // answer. Every kind's deltas still land in that kind's newest part, so
      // interleaved thinking/text blocks stay in their own bubbles.
      let idx = -1;
      for (let i = msg.parts.length - 1; i >= 0; i--) {
        if (msg.parts[i].type === event.kind) {
          idx = i;
          break;
        }
      }
      const parts = msg.parts.slice();
      if (idx === -1) {
        // No part of this kind open yet (the harness skipped part-start).
        // Start one rather than dropping the text on the floor.
        parts.push({ type: event.kind, text: event.delta });
      } else {
        const target = parts[idx];
        if (target.type !== "text" && target.type !== "thinking") return state;
        parts[idx] = { ...target, text: target.text + event.delta };
      }
      return { ...state, streaming: { ...msg, parts } };
    }

    case "tool-call": {
      if (!state.streaming) return state;
      const part: ChatPart = {
        type: "tool",
        toolId: event.toolId,
        name: event.name,
        args: event.args,
        output: "",
        status: "pending",
      };
      return {
        ...state,
        streaming: {
          ...state.streaming,
          parts: [...dropEmptyThinking(state.streaming.parts), part],
        },
      };
    }

    case "assistant-end": {
      if (!state.streaming) return state;
      const parts = finalizeParts(state.streaming.parts);
      // A turn that reduces to nothing (only an empty thinking/text part) must
      // not leave a blank bubble in history — drop it entirely.
      if (parts.length === 0) return { ...state, streaming: null };
      return {
        ...state,
        messages: capMessages([...state.messages, { ...state.streaming, parts }]),
        streaming: null,
      };
    }

    case "tool-update":
      return updateToolPart(state, event.toolId, (part) => ({
        ...part,
        output: capOutput(event.output),
        status: "running",
      }));

    case "tool-end":
      return updateToolPart(state, event.toolId, (part) => ({
        ...part,
        output: capOutput(event.output),
        status: event.isError ? "error" : "done",
      }));

    case "agent-start": {
      const prev = state.agents[event.toolId];
      const run: AgentRun = {
        // Metadata only ever fills in — a repeat start must never reset a
        // transcript that's already streaming.
        ...(prev ?? { toolId: event.toolId, state: emptyChatState() }),
        agentType: event.agentType ?? prev?.agentType,
        description: event.description ?? prev?.description,
        loading: event.loading ?? prev?.loading,
      };
      return { ...state, agents: capAgents({ ...state.agents, [event.toolId]: run }) };
    }

    case "agent-event": {
      const run = agentRun(state, event.toolId);
      return {
        ...state,
        agents: capAgents({
          ...state.agents,
          [event.toolId]: { ...run, state: applyChatEvent(run.state, event.event) },
        }),
      };
    }

    case "agent-done": {
      const run = agentRun(state, event.toolId);
      return {
        ...state,
        agents: capAgents({
          ...state.agents,
          [event.toolId]: {
            ...run,
            loading: false,
            state: withReport(run.state, event.report),
          },
        }),
      };
    }

    case "queue":
      return { ...state, queued: event.queued };

    case "ui-request":
      return {
        ...state,
        pendingRequests: [
          ...state.pendingRequests.filter((r) => r.id !== event.request.id),
          event.request,
        ],
      };

    case "ui-request-done":
      return {
        ...state,
        pendingRequests: state.pendingRequests.filter(
          (r) => r.id !== event.requestId,
        ),
        autoDecisions: without(state.autoDecisions, event.requestId),
      };

    case "notice":
      // Anchored like a trace, so it keeps its place in the transcript instead
      // of being pinned under it: a compaction/resume line must stay where it
      // happened, with later turns rendering below it.
      return {
        ...state,
        notices: [
          ...state.notices,
          {
            level: event.level,
            text: event.text,
            at: Date.now(),
            anchorMessageId:
              state.streaming?.id ??
              state.messages[state.messages.length - 1]?.id,
          },
        ].slice(-MAX_NOTICES),
      };

    case "models":
      return { ...state, models: event.models, currentModel: event.current };

    case "model-changed":
      return { ...state, currentModel: event.current };

    case "model-names":
      return { ...state, modelNames: event.names };

    case "modes":
      return { ...state, modes: event.modes, currentMode: event.current };

    case "mode-changed":
      return { ...state, currentMode: event.current };

    case "efforts":
      return { ...state, efforts: event.efforts, currentEffort: event.current };

    case "effort-changed":
      return { ...state, currentEffort: event.current };

    case "commands":
      return { ...state, commands: event.commands };

    case "usage":
      return { ...state, usage: event.usage };

    case "prompt-suggestion":
      return { ...state, promptSuggestions: event.suggestions };

    case "assistant-config":
      return { ...state, assistant: event.settings };

    case "draft":
      return state.draft === event.text ? state : { ...state, draft: event.text };

    case "auto-prompt":
      return { ...state, autoPrompt: event.prompt };

    case "auto-prompt-cleared":
      // Id-matched: a clear racing a freshly-armed prompt must not kill it.
      return state.autoPrompt?.id === event.id
        ? { ...state, autoPrompt: null }
        : state;

    case "assistant-decision":
      return {
        ...state,
        autoDecisions: {
          ...state.autoDecisions,
          [event.decision.requestId]: event.decision,
        },
      };

    case "assistant-decision-cleared":
      return {
        ...state,
        autoDecisions: without(state.autoDecisions, event.requestId),
      };

    case "assistant-trace": {
      // Anchor the trace to the turn it explains: the message currently
      // streaming when the card fired (its tool call lives there), falling back
      // to the latest message. This survives the streaming→finalized handoff
      // (same message id), so the bubble stays inline beside that turn in both
      // phases — and is clock-independent (no timestamp interleaving).
      // A caller-supplied anchor is only honoured if that turn is still in the
      // transcript: auto-PR pins one for a run that spans minutes, and a stale
      // id would render nowhere (or, worse, sink to the end and let every later
      // message slide in above it). Unanchored means "before any message".
      if (event.trace.update) {
        const i = state.assistantTraces.findIndex(
          (t) => t.requestId === event.trace.requestId,
        );
        if (i >= 0) {
          const prev = state.assistantTraces[i];
          const traces = state.assistantTraces.slice();
          traces[i] = { ...event.trace, at: prev.at, anchorMessageId: prev.anchorMessageId };
          return { ...state, assistantTraces: traces };
        }
      }
      const pinned = event.trace.anchorMessageId;
      const known =
        pinned !== undefined &&
        (pinned === state.streaming?.id ||
          state.messages.some((m) => m.id === pinned));
      const anchorMessageId = known
        ? pinned
        : (state.streaming?.id ??
          state.messages[state.messages.length - 1]?.id);
      return {
        ...state,
        assistantTraces: [
          ...state.assistantTraces,
          { ...event.trace, anchorMessageId },
        ].slice(-MAX_TRACES),
      };
    }

    case "capabilities":
      return { ...state, capabilities: event.capabilities };

    case "rewind-preview":
      return { ...state, rewindPreview: event.preview };

    case "rewind": {
      // The harness has truncated its own context back to just before this
      // prompt; mirror that here. Everything in flight belonged to the dropped
      // turns, so it all goes — session-level state (models/modes/commands/
      // capabilities/assistant config) is unaffected by a rewind.
      const idx = state.messages.findIndex((m) => m.id === event.messageId);
      if (idx === -1) return state;
      const messages = state.messages.slice(0, idx);
      const kept = new Set(messages.map((m) => m.id));
      return {
        ...state,
        messages,
        streaming: null,
        busy: false,
        queued: [],
        pendingRequests: [],
        promptSuggestions: [],
        autoDecisions: {},
        autoPrompt: null,
        rewindPreview: null,
        assistantTraces: state.assistantTraces.filter(
          (t) => t.anchorMessageId !== undefined && kept.has(t.anchorMessageId),
        ),
        // A notice about a dropped turn goes with it; one that predates every
        // message (session start) still leads the surviving transcript.
        notices: state.notices.filter(
          (n) =>
            n.anchorMessageId === undefined || kept.has(n.anchorMessageId),
        ),
        agents: reachableAgents(messages, state.agents),
      };
    }

    // Unknown/newer event (e.g. a server ahead of this client during a deploy):
    // leave state untouched rather than returning undefined and crashing the UI.
    default:
      return state;
  }
}

/** The run for this tool call, created empty if the adapter routed a nested
 * event before (or without) announcing the agent. */
function agentRun(state: ChatState, toolId: string): AgentRun {
  return state.agents[toolId] ?? { toolId, state: emptyChatState() };
}

/** Keep the newest runs. Insertion order is the map's own key order, so the
 * oldest keys fall off the front. */
function capAgents(agents: Record<string, AgentRun>): Record<string, AgentRun> {
  const keys = Object.keys(agents);
  if (keys.length <= MAX_AGENTS) return agents;
  const next: Record<string, AgentRun> = {};
  for (const key of keys.slice(-MAX_AGENTS)) next[key] = agents[key];
  return next;
}

/** Make sure the sub-agent's final report is the last bubble. The report is
 * usually already there (it IS the sub-agent's last assistant message) — append
 * only when the transcript is empty or ends with something else, so a run whose
 * text was never forwarded still shows its answer. */
function withReport(state: ChatState, report: string | undefined): ChatState {
  const text = (report ?? "").trim();
  if (!text) return state;
  const last = state.messages[state.messages.length - 1];
  if (last?.role === "assistant" && messageText(last).trim().endsWith(text))
    return state;
  return {
    ...state,
    messages: capMessages([
      ...state.messages,
      {
        id: `report-${state.messages.length}`,
        role: "assistant",
        parts: [{ type: "text", text }],
        createdAt: Date.now(),
      },
    ]),
  };
}

function messageText(message: ChatMessage): string {
  return message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/** Runs still referenced by a tool call in the surviving transcript, followed
 * transitively into those runs' own transcripts (an agent that spawned an
 * agent). Everything else belonged to the rewound turns. */
function reachableAgents(
  messages: ChatMessage[],
  agents: Record<string, AgentRun>,
): Record<string, AgentRun> {
  const kept: Record<string, AgentRun> = {};
  const queue = toolIds(messages);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    const run = agents[id];
    if (!run || kept[id]) continue;
    kept[id] = run;
    queue.push(...toolIds(run.state.messages));
  }
  return kept;
}

function toolIds(messages: ChatMessage[]): string[] {
  return messages.flatMap((m) =>
    m.parts.filter((p) => p.type === "tool").map((p) => p.toolId),
  );
}

/** Return a copy of `map` without `key` (unchanged if the key is absent). */
function without<T>(
  map: Record<string, T>,
  key: string,
): Record<string, T> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

/** Drop content-less thinking parts. A thinking part with no text (claude never
 * streams its reasoning back — see adapters/claude.ts) is only ever a live
 * "Thinking…" indicator; once the next part starts or the turn ends it carries
 * nothing, so we remove it rather than leave an empty collapsible behind. pi's
 * thinking always has text by then and is kept. */
function dropEmptyThinking(parts: ChatPart[]): ChatPart[] {
  return parts.filter(
    (p) => !(p.type === "thinking" && p.text.trim() === ""),
  );
}

/** Finalize a streaming turn's parts before it lands in history: drop empty
 * thinking parts (as above) and empty text parts (a whitespace-only text part
 * renders as an empty <div>). Callers drop the whole message if nothing
 * remains, so blank assistant bubbles never reach the transcript. */
function finalizeParts(parts: ChatPart[]): ChatPart[] {
  return dropEmptyThinking(parts).filter(
    (p) => !(p.type === "text" && p.text.trim() === ""),
  );
}

function capMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.length > MAX_MESSAGES
    ? messages.slice(-MAX_MESSAGES)
    : messages;
}

function capOutput(output: string): string {
  return output.length > MAX_TOOL_OUTPUT
    ? output.slice(-MAX_TOOL_OUTPUT)
    : output;
}

/** Update the tool part with the given id wherever it lives — usually the
 * streaming message, but tool results can arrive after assistant-end, so
 * search finished messages from the end too. */
function updateToolPart(
  state: ChatState,
  toolId: string,
  update: (part: Extract<ChatPart, { type: "tool" }>) => ChatPart,
): ChatState {
  const patch = (msg: ChatMessage): ChatMessage | null => {
    for (let i = msg.parts.length - 1; i >= 0; i--) {
      const part = msg.parts[i];
      if (part.type === "tool" && part.toolId === toolId) {
        const parts = [...msg.parts];
        parts[i] = update(part);
        return { ...msg, parts };
      }
    }
    return null;
  };

  if (state.streaming) {
    const patched = patch(state.streaming);
    if (patched) return { ...state, streaming: patched };
  }
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const patched = patch(state.messages[i]);
    if (patched) {
      const messages = [...state.messages];
      messages[i] = patched;
      return { ...state, messages };
    }
  }
  return state;
}
