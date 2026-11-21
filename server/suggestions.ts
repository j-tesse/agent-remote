// Harness-agnostic next-prompt suggestions. Some harnesses (Claude) emit their
// own predicted follow-up prompt via a `prompt-suggestion` ChatEvent; others
// (pi, and future harnesses) don't. This server-global subscriber fills that gap
// for the ones that don't: when a chat turn settles, it renders the recent
// transcript and asks the optional LLM endpoint to predict the developer's next
// message, then surfaces it as the composer's suggestion chip — exactly the same
// ChatState.promptSuggestion path the native harnesses feed.
//
// Best-effort/fail-safe like the rest of the LLM assist: no endpoint, an empty
// transcript, or any error simply yields no suggestion. Harnesses that declare
// `nativePromptSuggestions` are skipped so we never double-generate. Because it
// runs in the backend (driven from index.ts), a suggestion appears even with no
// browser connected — the chip is there when a client next attaches.
import type { SessionManager } from "./sessions/manager.js";
import type { HarnessAdapter } from "./adapters/types.js";
import type { ChatMessage, ChatState } from "../shared/protocol.js";
import { llmStatus, suggestNextPrompt } from "./llm.js";

/** How much recent conversation to feed the predictor (chars, from the end). */
const MAX_TRANSCRIPT_CHARS = 4_000;
/** How many trailing messages to consider. */
const MAX_TRANSCRIPT_MESSAGES = 10;

// How each role is named to the LLM. `system` is a turn the conversation
// received but neither party authored (a background-task notification) — it must
// not be labelled Assistant, or the model reads machine output as its own words.
const TRANSCRIPT_SPEAKER: Record<ChatMessage["role"], string> = {
  user: "User",
  assistant: "Assistant",
  system: "System",
};

/** Flatten a message's visible text (text parts; a terse marker for tool calls).
 * Thinking is omitted — it's not what the developer reacts to. Shared with
 * autopr.ts's turn digest so both read a message the same way. */
export function messageText(msg: ChatMessage): string {
  const chunks: string[] = [];
  for (const part of msg.parts) {
    if (part.type === "text" && part.text.trim()) chunks.push(part.text.trim());
    else if (part.type === "tool") chunks.push(`[used tool: ${part.name}]`);
  }
  return chunks.join("\n");
}

/** Render the tail of the conversation as a plain `User:`/`Assistant:` script,
 * newest-biased and bounded. Shared by the suggestion prompt, the PR supervisor
 * and Continuity Mode — the last of which widens the window, since it has to
 * answer what the agent actually asked rather than guess a follow-up. Exported
 * for testing. */
export function buildSuggestionTranscript(
  state: ChatState,
  opts?: { maxMessages?: number; maxChars?: number },
): string {
  const maxMessages = opts?.maxMessages ?? MAX_TRANSCRIPT_MESSAGES;
  const maxChars = opts?.maxChars ?? MAX_TRANSCRIPT_CHARS;
  const recent = state.messages.slice(-maxMessages);
  const lines: string[] = [];
  for (const msg of recent) {
    const text = messageText(msg);
    if (!text) continue;
    lines.push(`${TRANSCRIPT_SPEAKER[msg.role]}: ${text}`);
  }
  const transcript = lines.join("\n\n");
  return transcript.length > maxChars
    ? transcript.slice(-maxChars)
    : transcript;
}

/** Whether a settled session is a good moment to offer a suggestion: idle, no
 * pending card, nothing already queued or suggested, and a real exchange has
 * happened (≥1 user prompt and ≥1 assistant reply with content). Exported for
 * testing. */
export function shouldSuggest(state: ChatState): boolean {
  if (state.busy) return false;
  if (state.pendingRequests.length > 0) return false;
  if (state.queued.length > 0 || state.scheduled.length > 0) return false;
  if (state.promptSuggestions.length > 0) return false;
  const hasUser = state.messages.some((m) => m.role === "user");
  const hasAssistant = state.messages.some(
    (m) => m.role === "assistant" && messageText(m).length > 0,
  );
  return hasUser && hasAssistant;
}

/** Subscribe the backend suggestion generator to the manager. Returns an
 * unsubscribe. Call once at boot (from index.ts). */
export function attachSuggestions(
  manager: SessionManager,
  adapters: Map<string, HarnessAdapter>,
): () => void {
  // Per-session single-flight token, bumped whenever a new turn begins or the
  // session ends, so a slow prediction from a prior turn can't overwrite fresher
  // state when it finally resolves.
  const gen = new Map<string, number>();
  const bump = (sessionId: string) =>
    gen.set(sessionId, (gen.get(sessionId) ?? 0) + 1);

  return manager.subscribe({
    onStarted() {},
    onOutput() {},
    onExit(sessionId) {
      bump(sessionId);
    },
    onRemoved(sessionId) {
      gen.delete(sessionId);
    },
    onChatEvent(sessionId, event) {
      if (event.type !== "busy") return;
      // A new turn invalidates any in-flight prediction from the previous one.
      if (event.busy) {
        bump(sessionId);
        return;
      }
      // Turn settled: maybe synthesize a suggestion — unless this harness makes
      // its own, the endpoint is down, or it isn't a sensible moment.
      const info = manager.sessionInfo(sessionId);
      const adapter = info && adapters.get(info.harnessId);
      if (!adapter || adapter.nativePromptSuggestions) return;
      if (!llmStatus().available) return;
      const state = manager.chatState(sessionId);
      if (!state || !shouldSuggest(state)) return;

      const token = gen.get(sessionId) ?? 0;
      void suggestNextPrompt(buildSuggestionTranscript(state))
        .then((suggestions) => {
          if (suggestions.length === 0) return;
          // Stale? A newer turn started, or the session ended, meanwhile.
          if ((gen.get(sessionId) ?? 0) !== token) return;
          const cur = manager.chatState(sessionId);
          if (!cur || cur.busy || cur.promptSuggestions.length > 0) return;
          manager.postPromptSuggestions(sessionId, suggestions);
        })
        .catch(() => {});
    },
  });
}
