// Backend AI-assistant mode. When a chat session has assistant mode enabled
// (ChatState.assistant, toggled from the UI via `set-assistant`), the SERVER is
// the sole decider for its permission/question cards: it evaluates each via the
// optional LLM, BROADCASTS the verdict (so every client renders the same
// countdown ring it always has), and — after the grace window — APPLIES it.
// Because the decider lives here (driven from index.ts), not in the frontend,
// it keeps running with no browser open, so an unattended session doesn't stall.
//
// A connected user still intervenes exactly as before: interacting with the card
// sends `cancel-assistant` (→ an `assistant-decision-cleared` event this module
// observes) which cancels the pending auto-response; answering the card manually
// resolves it (→ `ui-request-done`) and likewise cancels. `deny` never auto-acts
// — it's surfaced for a human to confirm, matching the prior UX.
//
// Harness-agnostic: it only reads ChatState and drives the manager, like a UI.
import type { SessionManager } from "./sessions/manager.js";
import type {
  AssistantDecision,
  AssistantTrace,
  ChatUiRequest,
} from "../shared/protocol.js";
import { evaluate, llmStatus } from "./llm.js";
import { autoActionDelayMs, isAllowEverything } from "../shared/chat.js";

// Trace text for blanket-accept (no LLM was queried, but the transcript still
// shows an auditable bubble per auto-acceptance).
const ALLOW_EVERYTHING_REASON = '"allow everything" mode';
const ALLOW_EVERYTHING_PROMPT =
  'No LLM was consulted: assistant instructions are "allow everything", so every permission request is accepted automatically.';
const ALLOW_EVERYTHING_RESPONSE = '{"allow": true}';

function requestContentChars(req: ChatUiRequest): number {
  if (req.kind === "questions") return JSON.stringify(req.questions ?? []).length;
  const toolChars = req.tool ? JSON.stringify(req.tool).length : 0;
  return toolChars || (req.message ?? req.title ?? "").length;
}

/** Is this request still awaiting an answer? (A client may have answered it, or
 * cancelled the auto-action, meanwhile.) */
function stillPending(
  manager: SessionManager,
  sessionId: string,
  requestId: string,
): boolean {
  return !!manager
    .chatState(sessionId)
    ?.pendingRequests.some((r) => r.id === requestId);
}

/** Apply an auto-acting verdict to the session, exactly as a browser would. */
function apply(
  manager: SessionManager,
  sessionId: string,
  req: ChatUiRequest,
  decision: AssistantDecision,
): void {
  if (decision.action === "confirm") {
    manager.chatAction(sessionId, {
      type: "ui-response",
      requestId: req.id,
      confirmed: true,
    });
  } else if (decision.action === "accept" && decision.value != null) {
    manager.chatAction(sessionId, {
      type: "ui-response",
      requestId: req.id,
      value: decision.value,
    });
  } else if (decision.action === "answer" && decision.answers) {
    manager.chatAction(sessionId, {
      type: "ui-response",
      requestId: req.id,
      answers: decision.answers,
    });
  }
}

/** Subscribe the backend auto-decider to the manager. Returns an unsubscribe.
 * Call once at boot (from index.ts). */
export function attachAssistant(manager: SessionManager): () => void {
  // Grace timers per pending request; `handled` dedupes evaluation per id. A
  // request is dropped from both when it resolves or its verdict is cleared.
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // Value = the session hold: a card the decider will answer isn't waiting on a
  // human, so wait_session must not report it as such.
  const handled = new Map<string, () => void>();
  const unhandle = (requestId: string) => {
    handled.get(requestId)?.();
    handled.delete(requestId);
  };

  const drop = (requestId: string) => {
    const t = timers.get(requestId);
    if (t) clearTimeout(t);
    timers.delete(requestId);
    unhandle(requestId);
  };

  return manager.subscribe({
    onStarted() {},
    onOutput() {},
    onExit() {},
    onChatEvent(sessionId, event) {
      // A resolved request, or a user-cancelled verdict, cancels our timer.
      if (
        event.type === "ui-request-done" ||
        event.type === "assistant-decision-cleared"
      ) {
        drop(event.requestId);
        return;
      }
      if (event.type !== "ui-request") return;
      const req = event.request;
      if (handled.has(req.id)) return;

      const settings = manager.chatState(sessionId)?.assistant;
      if (!settings?.enabled) return;

      const isPermission = req.kind === "select" || req.kind === "confirm";
      const isQuestions = req.kind === "questions";
      // Blanket-accept mode: permission cards skip the LLM entirely (so it also
      // works with no endpoint); questions still need one.
      const allowAll =
        isAllowEverything(settings.permissions.instructions) && isPermission;
      if (!allowAll && !llmStatus().available) return;

      // Plan acceptance stays human-driven (see AGENTS.md); `input` too.
      const want =
        (isPermission && settings.permissions.enabled) ||
        (isQuestions && settings.questions.enabled);
      if (!want) return;

      handled.set(
        req.id,
        manager.holdAssistant(sessionId, isPermission ? "permissions" : "questions"),
      );
      // Grace window scales with card size; permission cards honour the
      // user's scale, questions keep the default.
      const delayMs = autoActionDelayMs(
        requestContentChars(req),
        isPermission ? settings.permissions.delayScale : undefined,
      );

      // Broadcast a verdict and schedule its application after the grace window
      // (shared by the LLM path and blanket-accept).
      const commit = (decision: AssistantDecision) => {
        manager.postAssistantDecision(sessionId, decision);
        // `deny` never auto-acts — a human confirms it (matches prior UX).
        if (decision.action === "deny") {
          unhandle(req.id);
          return;
        }
        const t = setTimeout(() => {
          timers.delete(req.id);
          unhandle(req.id);
          // A connected human may have taken over during the grace window.
          if (stillPending(manager, sessionId, req.id))
            apply(manager, sessionId, req, decision);
        }, delayMs);
        t.unref?.();
        timers.set(req.id, t);
      };

      if (allowAll) {
        const decision = toDecision(
          req,
          { action: "allow", reason: ALLOW_EVERYTHING_REASON },
          delayMs,
        );
        if (!decision) {
          unhandle(req.id);
          return;
        }
        // Still trace it, so the transcript records every auto-acceptance.
        manager.postAssistantTrace(sessionId, {
          requestId: req.id,
          kind: req.kind as "confirm" | "select",
          toolId: req.toolId,
          prompt: ALLOW_EVERYTHING_PROMPT,
          response: ALLOW_EVERYTHING_RESPONSE,
          outcome: "allow",
          reason: ALLOW_EVERYTHING_REASON,
          summary: `Allowed — ${ALLOW_EVERYTHING_REASON}`,
          at: Date.now(),
        });
        commit(decision);
        return;
      }

      void evaluate({
        kind: req.kind as "confirm" | "select" | "questions",
        tool: req.tool,
        options: req.options,
        questions: req.questions,
        // Each capability follows its own instructions box.
        instructions: isPermission
          ? settings.permissions.instructions
          : settings.questions.instructions,
        workspace: manager.sessionFolder(sessionId),
        onlyIfSure: settings.questions.onlyIfSure,
        capabilities: {
          permissions: settings.permissions.enabled,
          questions: settings.questions.enabled,
        },
      })
        .then((verdict) => {
          // Whenever the LLM was actually queried, surface what it saw and said
          // as a collapsible AI-mode bubble — visible with or without a browser.
          if (verdict.trace) {
            manager.postAssistantTrace(sessionId, {
              requestId: req.id,
              kind: req.kind as "confirm" | "select" | "questions",
              toolId: req.toolId,
              prompt: verdict.trace.prompt,
              thoughts: verdict.trace.thoughts,
              response: verdict.trace.response,
              outcome: outcomeOf(verdict),
              reason: verdict.reason,
              summary: summarizeVerdict(verdict),
              at: Date.now(),
            });
          }
          if (!verdict.available || !verdict.action || verdict.action === "none") {
            unhandle(req.id);
            return;
          }
          // Gone already? (a client answered or cancelled during evaluation)
          if (!stillPending(manager, sessionId, req.id) || !handled.has(req.id)) {
            drop(req.id);
            return;
          }

          const decision = toDecision(req, verdict, delayMs);
          if (!decision) {
            unhandle(req.id);
            return;
          }
          // Broadcast so every client shows the countdown (or the deny hint).
          commit(decision);
        })
        .catch(() => {
          unhandle(req.id);
        });
    },
  });
}

/** Structured outcome for the trace bubble's colored verdict word. */
function outcomeOf(verdict: {
  available: boolean;
  action?: string;
}): AssistantTrace["outcome"] {
  if (!verdict.available) return "error";
  switch (verdict.action) {
    case "allow":
      return "allow";
    case "deny":
      return "deny";
    case "answer":
      return "answer";
    default:
      return "abstain";
  }
}

/** One-line outcome summary for the AI-mode trace bubble header. */
function summarizeVerdict(verdict: {
  available: boolean;
  action?: string;
  reason?: string;
  answers?: Record<string, string>;
}): string {
  if (!verdict.available) return "No response from endpoint";
  switch (verdict.action) {
    case "allow":
      return verdict.reason ? `Allowed — ${verdict.reason}` : "Allowed";
    case "deny":
      return verdict.reason ? `Denied — ${verdict.reason}` : "Denied";
    case "answer":
      return "Answered";
    default:
      return "Abstained (left for you)";
  }
}

/** Map the LLM verdict to a broadcastable decision, or null if inapplicable. */
function toDecision(
  req: ChatUiRequest,
  verdict: { action?: string; reason?: string; answers?: Record<string, string> },
  delayMs: number,
): AssistantDecision | null {
  if (verdict.action === "allow") {
    if (req.kind === "confirm")
      return { requestId: req.id, action: "confirm", delayMs };
    // Plain approval only — never the "always" choice, which would install a
    // standing rule off one LLM verdict.
    const accept = (req.options ?? []).find((o) => o.intent === "accept");
    if (!accept) return null;
    return { requestId: req.id, action: "accept", value: accept.value, delayMs };
  }
  if (verdict.action === "deny")
    return { requestId: req.id, action: "deny", reason: verdict.reason ?? "", delayMs };
  if (verdict.action === "answer" && verdict.answers)
    return {
      requestId: req.id,
      action: "answer",
      answers: verdict.answers,
      delayMs,
    };
  return null;
}
