// Opens the pull request for the auto-PR flow by driving a REAL chat session
// (pi by default, via its `/pr` skill) started through the SessionManager — so
// it appears as an ordinary tab in the folder and the user can watch, steer or
// take it over. This module never speaks the harness's wire format: it only
// sends `ChatAction`s and reads `ChatState`, exactly as a browser would.
//
// The session's prose questions ("does this description look good?") are
// answered by the LLM supervisor (llm.ts `supervisePr`); its *permission* cards
// are handled for free by turning on the existing blanket-accept assistant mode
// on the spawned session, so no card-handling code lives here.
import type { SessionManager } from "./sessions/manager.js";
import type { AssistantSettings, ChatEvent } from "../shared/protocol.js";
import { ALLOW_EVERYTHING, deriveAssistantEnabled } from "../shared/chat.js";
import { supervisePr } from "./llm.js";
import { buildSuggestionTranscript } from "./suggestions.js";
import type { GitResult } from "./git.js";

/** How many agent turns the supervisor may drive before giving up. */
const MAX_PR_TURNS = 12;
/** Wall-clock cap on the whole PR session. */
const MAX_RUN_MS = 10 * 60_000;
/** Per-turn cap; the `/pr` skill reads the diff and runs `gh`, so it's generous. */
const TURN_TIMEOUT_MS = 5 * 60_000;

/** A git command the auto-PR flow ran before handing over. */
export interface RanCommand {
  args: string[];
  result: GitResult;
}

/** Per-command output cap in the framing (push progress can be chatty). */
const MAX_COMMAND_OUTPUT = 1_500;

/** POSIX-quote one argv entry, only when it needs it. */
export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Render the commands as a terminal transcript (`$ git …` + output). Pure. */
export function formatCommandLog(commands: RanCommand[]): string {
  return commands
    .map(({ args, result }) => {
      let out = [result.stdout, result.stderr]
        .map((t) => t.trim())
        .filter(Boolean)
        .join("\n");
      if (out.length > MAX_COMMAND_OUTPUT) out = `${out.slice(0, MAX_COMMAND_OUTPUT)}\n…`;
      const status = result.ok ? "" : "\n(exited non-zero)";
      return `$ ${["git", ...args].map(shellQuote).join(" ")}${out ? `\n${out}` : ""}${status}`;
    })
    .join("\n\n");
}

/** Framing for the PR session: the auto-PR flow already did the branch/commit/
 * push prep a PR skill would otherwise re-check, and nobody approves a draft —
 * each skipped check or approval round is a whole extra turn. */
export function prSessionFraming(commands: RanCommand[] = []): string {
  const log = formatCommandLog(commands);
  return `You're run by an LLM-based agent in an automated PR workflow. Branch is committed and pushed — skip those checks, don't ask for approval, just create the PR. Keep the description file out of the repo. Reply with the PR URL.${
    log ? `\n\nAlready ran:\n\`\`\`\n${log}\n\`\`\`` : ""
  }`;
}

export interface PrResult {
  prNumber: number | null;
  prUrl: string | null;
}

/** Blanket-accept permissions for the spawned session, and explicitly no
 * auto-PR (it must never open a PR about itself) and no continuity (it must
 * never start prompting itself once the supervisor is done with it). */
function prSessionAssistant(): AssistantSettings {
  const settings: AssistantSettings = {
    enabled: false,
    permissions: { enabled: true, instructions: ALLOW_EVERYTHING },
    questions: { enabled: false, instructions: "", onlyIfSure: true },
    autoPr: { enabled: false, instructions: "", autoMerge: false },
    continuity: { enabled: false, instructions: "", newSession: "never" },
  };
  return { ...settings, enabled: deriveAssistantEnabled(settings) };
}

/** Progress reporter (auto-PR posts these as AI-mode notes on the *origin*
 * session; the tests pass a collector). */
export type Report = (summary: string, detail?: string) => void;

/**
 * Run the PR agent to completion in `folder`.
 *
 * Returns the PR reference once the transcript shows one was created, or null
 * when the harness is unavailable, the supervisor can't run, or the run hits a
 * bound — in which case the session is deliberately LEFT OPEN for a human.
 */
export async function runPrSession(
  manager: SessionManager,
  opts: {
    folder: string;
    harnessId: string;
    command: string;
    instructions?: string;
    /** Git commands the flow already ran, shown to the agent in its framing. */
    history?: RanCommand[];
    report: Report;
    /** The spawned session, as soon as it exists — so the caller's notes can
     * link to its tab (it's left open for a human on any failure). */
    onSession?: (sessionId: string) => void;
    /** The session this run acts for; the PR session nests under it. */
    parent?: string;
  },
): Promise<PrResult | null> {
  const { folder, harnessId, command, instructions, report, onSession, parent, history } =
    opts;

  let sessionId: string;
  try {
    // Nested under the origin: watched inline in its note, lifecycle tied to it.
    // Harnesses without `appendsSystemPrompt` just run unframed.
    sessionId = manager.start(harnessId, {
      cwd: folder,
      parent,
      appendSystemPrompt: prSessionFraming(history),
    }).id;
  } catch (err) {
    report(`Could not start the ${harnessId} session`, (err as Error).message);
    return null;
  }
  onSession?.(sessionId);

  // Turn bookkeeping: one waiter per in-flight prompt, settled by the turn
  // ending or the session dying.
  let turnWaiter: ((exited: boolean) => void) | null = null;
  const settleTurn = (exited: boolean) => {
    const waiter = turnWaiter;
    turnWaiter = null;
    waiter?.(exited);
  };
  let exited = false;
  // Only a busy:true → busy:false *transition* ends a turn. pi emits busy:false
  // more than once per turn (agent_end, then settled); a naive edge match would
  // let the stray one settle the *next* turn the instant it's sent.
  let armed = false;

  const unsubscribe = manager.subscribe({
    onStarted() {},
    onOutput() {},
    onExit(id) {
      if (id !== sessionId) return;
      exited = true;
      settleTurn(true);
    },
    onChatEvent(id: string, event: ChatEvent) {
      if (id !== sessionId || event.type !== "busy") return;
      if (event.busy) armed = true;
      else if (armed) {
        armed = false;
        settleTurn(false);
      }
    },
  });

  /** Send a prompt and wait for its turn to end. Resolves false on timeout. */
  const turn = (text: string): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (turnWaiter) settleTurn(true);
      }, TURN_TIMEOUT_MS);
      turnWaiter = (didExit) => {
        clearTimeout(timer);
        resolve(!didExit);
      };
      armed = false;
      manager.chatAction(sessionId, { type: "prompt", text });
    });

  try {
    // Blanket-accept the agent's permission cards. Sent before the first prompt
    // so the very first tool call is already covered.
    manager.chatAction(sessionId, {
      type: "set-assistant",
      settings: prSessionAssistant(),
    });

    const deadline = Date.now() + MAX_RUN_MS;
    let next = command;

    for (let i = 0; i < MAX_PR_TURNS; i++) {
      const completed = await turn(next);
      if (!completed || exited) {
        report(
          "PR agent stopped before finishing",
          exited ? "the session exited" : "the turn timed out",
        );
        return null;
      }
      if (Date.now() > deadline) {
        report("PR agent ran out of time", `no PR after ${i + 1} turns`);
        return null;
      }

      const state = manager.chatState(sessionId);
      const transcript = state ? buildSuggestionTranscript(state) : "";
      const verdict = await supervisePr(transcript, instructions);
      if (!verdict) {
        report(
          "Could not supervise the PR agent",
          "the LLM endpoint is unavailable or returned nothing usable",
        );
        return null;
      }
      if (verdict.done) {
        if (verdict.prNumber == null && verdict.prUrl == null) {
          report("PR agent finished without a PR", verdict.reply);
          return null;
        }
        // Success: close the session, leaving its exited tab with the transcript.
        manager.stop(sessionId);
        return { prNumber: verdict.prNumber, prUrl: verdict.prUrl };
      }
      next = verdict.reply;
    }

    report("PR agent hit the turn limit", `${MAX_PR_TURNS} turns without a PR`);
    return null;
  } finally {
    unsubscribe();
  }
}
