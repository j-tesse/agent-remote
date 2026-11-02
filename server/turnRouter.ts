// Where a settled chat turn goes. Two AI-assistant capabilities want the same
// moment — the turn ending — so the decision belongs to neither: this
// server-global subscriber owns the hook and routes between them.
//
//   turn settles → shouldRouteTurn → buildTurnDigest
//     → llm.routeTurn (PR stage, if auto-PR on)   → "auto-pr" → runAutoPr
//     → llm.routeTurn (continuity stage, if on)   → "continuity" → runContinuity
//     → otherwise stop
// Auto-PR is asked first so finished work is submitted before the loop moves on.
//
// It also owns everything the two runners share: the single-flight lock (a
// session is never PR-ing and continuing at once), the anchor pinning their
// AI-mode notes to the turn that triggered them, and the note/failed helpers.
// Like assistant.ts it runs in the backend (driven from index.ts), so the loop
// continues with no browser open.
import type { SessionManager } from "./sessions/manager.js";
import type { AssistantTrace, ChatState, TraceCheck } from "../shared/protocol.js";
import type { AutoPrConfig } from "./config.js";
import type { LlmTrace } from "./llm.js";
import { llmStatus, routeTurn } from "./llm.js";
import { messageText } from "./suggestions.js";
import { runAutoPr } from "./autopr.js";
import { runContinuity } from "./continuity.js";

/** How much of each side of the exchange the router sees (chars, from the end —
 * the agent's verdict is in its closing lines, not its opening ones). */
const MAX_DIGEST_CHARS = 2_000;

function tail(text: string): string {
  return text.length > MAX_DIGEST_CHARS ? text.slice(-MAX_DIGEST_CHARS) : text;
}

/** How much of a failure's first line fits on a note's single line. */
const MAX_REASON_CHARS = 160;

/** First non-empty line of a command's output, for the inline reason (the whole
 * output goes in the note's expandable `detail`). Exported for testing. */
export function firstLine(text: string): string | undefined {
  const line = text.split("\n").find((l) => l.trim())?.trim();
  if (!line) return undefined;
  return line.length > MAX_REASON_CHARS
    ? `${line.slice(0, MAX_REASON_CHARS - 1)}…`
    : line;
}

/** Render what the router judges: the developer's last request and the agent's
 * final message. `null` when the transcript doesn't end in an assistant message
 * with content — the agent never actually replied (an interrupt before the
 * first token, say), so there is no finished turn to route. Exported for
 * testing. */
export function buildTurnDigest(state: ChatState): string | null {
  const last = state.messages[state.messages.length - 1];
  if (!last || last.role !== "assistant") return null;
  const reply = messageText(last).trim();
  if (!reply) return null;
  const asked = [...state.messages].reverse().find((m) => m.role === "user");
  const request = asked ? messageText(asked).trim() : "";
  return [
    `The developer asked:\n${tail(request) || "(no prompt on record)"}`,
    `The agent's final message of the turn:\n${tail(reply)}`,
  ].join("\n\n");
}

/** Whether a settled session is a moment to route at all: at least one of the
 * two capabilities is on, the session is idle with no pending card, queued
 * prompt or already-armed auto-prompt, and a real exchange happened. Exported
 * for testing. */
export function shouldRouteTurn(state: ChatState): boolean {
  const { autoPr, continuity } = state.assistant;
  if (!autoPr.enabled && !continuity.enabled) return false;
  if (state.busy) return false;
  if (state.pendingRequests.length > 0) return false;
  if (state.queued.length > 0) return false;
  // A prompt is already waiting out its countdown — that IS this turn's answer.
  if (state.autoPrompt) return false;
  return (
    state.messages.some((m) => m.role === "user") &&
    state.messages.some((m) => m.role === "assistant")
  );
}

/** One AI-mode note in the origin session's transcript. */
// Same-ms notes must not share an id, or an `update` could hit the wrong one.
let noteSeq = 0;

export type Note = (
  outcome: AssistantTrace["outcome"],
  summary: string,
  reason?: string,
  extra?: {
    detail?: string;
    trace?: LlmTrace;
    /** Another session the note is about (not the origin it's posted to), for
     * the bubble's jump-to-tab link — e.g. auto-PR's spawned `/pr` session. */
    session?: string;
    /** Offer a "Run anyways" auto-PR override on the bubble. */
    offerAutoPr?: boolean;
    /** Fixed id + `update`: later notes with this id rewrite it in place. */
    id?: string;
    update?: boolean;
    checks?: TraceCheck[];
  },
) => void;

/** What a runner is handed: the session it works for, plus its narration
 * channel. Both runners speak only this and the manager — no harness anywhere. */
export interface RunContext {
  manager: SessionManager;
  sessionId: string;
  /** The session's launch folder (fixed for its life) — the repo/workspace. */
  folder: string;
  note: Note;
  /** A failed git/gh step: one red line, the whole stderr behind the disclosure. */
  failed: (summary: string, result: { stderr: string }) => void;
}

/** Subscribe the backend turn router to the manager. Returns an unsubscribe.
 * Call once at boot (from index.ts). */
export function attachTurnRouter(
  manager: SessionManager,
  config?: AutoPrConfig,
): () => void {
  // Single-flight per session, spanning the whole async run: a turn settling and
  // a "Run now" can land together, and opening two PRs (or sending two prompts)
  // for one turn isn't recoverable.
  const running = new Set<string>();

  // The turn each in-flight run belongs to. A run takes minutes and the
  // developer keeps chatting meanwhile, so without this every note would anchor
  // to whatever message happened to be last when it was posted — the notes would
  // trail the live conversation instead of staying with the turn that triggered
  // them. Pinned once, at run start.
  const anchors = new Map<string, string | undefined>();

  // Route at most once per prompt. pi emits busy:false more than once per turn
  // (agent_end, then settled), so a naive edge match would route twice; but a
  // busy:true → busy:false *transition* doesn't work either, because a harness
  // that doesn't stream partial messages (claude against a local endpoint emits
  // no `message_start`) never sends busy:true at all. What always happens is the
  // prompt itself, so that is what arms the router.
  const armed = new Set<string>();

  /** Build the narration channel for one run. Notes usually consulted no LLM,
   * so the bubble shows `summary` as its line: write each as a self-contained
   * sentence ("Pushed x to origin"), with `reason` a trailing detail and never
   * the substance. */
  const contextFor = (
    sessionId: string,
    folder: string,
    kind: "auto-pr" | "continuity",
  ): RunContext => {
    const note: Note = (outcome, summary, reason, extra) => {
      manager.postAssistantTrace(sessionId, {
        requestId: extra?.id ?? `${kind}:${Date.now()}:${++noteSeq}`,
        kind,
        outcome,
        reason,
        summary,
        detail: extra?.detail,
        sessionId: extra?.session,
        offerAutoPr: extra?.offerAutoPr,
        update: extra?.update,
        checks: extra?.checks,
        at: Date.now(),
        anchorMessageId: anchors.get(sessionId),
        ...extra?.trace,
      });
    };
    return {
      manager,
      sessionId,
      folder,
      note,
      failed: (summary, result) => {
        const stderr = result.stderr.trim();
        note("error", summary, firstLine(stderr), { detail: stderr || undefined });
      },
    };
  };

  /** Take the single-flight lock, pin the anchor, run `body`, always release. */
  const guard = (sessionId: string, body: () => Promise<void>) => {
    if (running.has(sessionId)) return;
    running.add(sessionId);
    const state = manager.chatState(sessionId);
    anchors.set(
      sessionId,
      state?.streaming?.id ?? state?.messages[state.messages.length - 1]?.id,
    );
    void body()
      .catch((err: unknown) => {
        const e = err as Error;
        manager.postAssistantTrace(sessionId, {
          requestId: `auto-pr:${Date.now()}`,
          kind: "auto-pr",
          outcome: "error",
          reason: firstLine(e?.message ?? ""),
          summary: "AI mode failed",
          detail: e?.stack ?? String(err),
          at: Date.now(),
          anchorMessageId: anchors.get(sessionId),
        });
      })
      .finally(() => {
        running.delete(sessionId);
        anchors.delete(sessionId);
      });
  };

  /** Route a settled turn and hand it to the winning runner. */
  async function route(sessionId: string): Promise<void> {
    const folder = manager.sessionFolder(sessionId);
    if (!folder) return;
    const settings = manager.chatState(sessionId)?.assistant;
    if (!settings) return;
    const canPr = settings.autoPr.enabled;
    const canContinue = settings.continuity.enabled;

    const state = manager.chatState(sessionId);
    const digest = state ? buildTurnDigest(state) : null;
    if (!digest) {
      contextFor(sessionId, folder, canPr ? "auto-pr" : "continuity").note(
        "deny",
        "Nothing to act on",
        "the agent never replied to the last prompt",
        { offerAutoPr: canPr },
      );
      return;
    }

    // Auto-PR asks first: finished work is submitted (and, with autoMerge,
    // landed) before anything continues — after a merge runAutoPr hands to
    // continuity itself. A single three-way question let continuity win turns
    // that were really done, so the work piled up unsubmitted. Continuity is
    // only consulted once the PR stage has declined.
    const available = llmStatus().available;
    const ask = (stage: "auto-pr" | "continuity") =>
      available
        ? routeTurn(digest, {
            canPr: stage === "auto-pr",
            canContinue: stage === "continuity",
            prInstructions: settings.autoPr.instructions,
            continuityInstructions: settings.continuity.instructions,
          })
        : Promise.resolve(null);

    if (canPr) {
      const verdict = await ask("auto-pr");
      // Fail-open only where it always was: auto-PR has never required the
      // endpoint, so an unroutable turn still gets its PR.
      const submit = verdict ? verdict.route === "auto-pr" : true;
      const ctx = contextFor(sessionId, folder, "auto-pr");
      ctx.note(
        verdict ? (submit ? "allow" : "deny") : "abstain",
        submit ? "Turn looks finished — opening a PR" : "Not ready for a PR",
        verdict
          ? verdict.reason || undefined
          : "no usable verdict — opening the PR anyway",
        // Declined by the router, not by the developer: let them overrule it.
        { trace: verdict?.trace, offerAutoPr: !submit },
      );
      if (submit) {
        await runAutoPr(ctx, config, { continueIfNothing: true });
        return;
      }
    }
    if (!canContinue) return;

    // Continuity can't run without the endpoint at all (it has no prompt to send).
    const verdict = await ask("continuity");
    const go = verdict?.route === "continuity";
    const ctx = contextFor(sessionId, folder, go ? "continuity" : "auto-pr");
    ctx.note(
      verdict ? (go ? "allow" : "deny") : "abstain",
      go ? "Turn needs a reply — continuing" : "Leaving this turn alone",
      verdict
        ? verdict.reason || undefined
        : "no usable verdict from the LLM endpoint",
      // The PR stage already posted its own "Run anyways".
      { trace: verdict?.trace, offerAutoPr: false },
    );
    if (go) await runContinuity(ctx, { afterPr: false });
  }

  return manager.subscribe({
    onStarted() {},
    onOutput() {},
    onExit(sessionId) {
      running.delete(sessionId);
      armed.delete(sessionId);
    },
    onRemoved(sessionId) {
      running.delete(sessionId);
      armed.delete(sessionId);
    },
    onChatAction(sessionId, action) {
      // On demand — deliberately ignores the checkbox and the router: the
      // developer asking for a PR outranks any verdict about how the turn ended.
      if (action.type !== "run-auto-pr") return;
      const folder = manager.sessionFolder(sessionId);
      if (!folder) return;
      guard(sessionId, async () => {
        await runAutoPr(contextFor(sessionId, folder, "auto-pr"), config);
      });
    },
    onChatEvent(sessionId, event) {
      if (event.type === "user-message" || (event.type === "busy" && event.busy)) {
        armed.add(sessionId);
        return;
      }
      if (event.type !== "busy") return;
      if (!armed.delete(sessionId)) return;
      const state = manager.chatState(sessionId);
      if (!state || !shouldRouteTurn(state)) return;
      guard(sessionId, () => route(sessionId));
    },
  });
}
