// Server-side chat render log (diagnostics): per finalized message, persists the
// original ChatMessage and its rendered form (shared/render.ts's renderMessage)
// so we can review how each message type is displayed.

import type { ChatMessage, ChatState } from "../shared/protocol.js";
import { renderMessage } from "../shared/render.js";
import { logChatRender } from "./db.js";

// Per-session signature of each already-logged message, so we only write on
// change (late tool results refresh; unchanged skipped). Cleared on session end.
const logged = new Map<string, Map<string, string>>();

/** Persist any new-or-changed finalized messages of a chat session. Cheap to
 * call on every (non-streaming) chat event: unchanged messages are skipped via
 * a JSON signature before any markdown is rendered. */
export function recordChatRenders(
  sessionId: string,
  state: ChatState,
  meta: { harnessId?: string; cwd?: string; folder?: string } = {},
): void {
  let seen = logged.get(sessionId);
  if (!seen) logged.set(sessionId, (seen = new Map()));
  for (const message of state.messages) {
    const original = JSON.stringify(message);
    // A tool call's sub-agent transcript is part of what's displayed, so it has
    // to be in the signature too — otherwise a growing nested transcript never
    // refreshes the row.
    const signature = original + agentSignature(message, state);
    if (seen.get(message.id) === signature) continue;
    seen.set(message.id, signature);
    logChatRender({
      sessionId,
      messageId: message.id,
      role: message.role,
      harnessId: meta.harnessId ?? null,
      cwd: meta.cwd ?? null,
      original,
      rendered: JSON.stringify(renderMessage(message, state.agents, meta.folder)),
    });
  }
}

/** Cheap change-detector for the sub-agent transcripts this message displays:
 * per referenced run, its message count and the size of the last one. */
function agentSignature(message: ChatMessage, state: ChatState): string {
  let sig = "";
  for (const part of message.parts) {
    if (part.type !== "tool") continue;
    const run = state.agents[part.toolId];
    if (!run) continue;
    const last = run.state.messages[run.state.messages.length - 1];
    sig += `|${part.toolId}:${run.state.messages.length}:${JSON.stringify(last ?? null).length}:${run.loading ? 1 : 0}`;
  }
  return sig;
}

/** Drop a finished session's dedupe state. */
export function forgetChatRenders(sessionId: string): void {
  logged.delete(sessionId);
}
