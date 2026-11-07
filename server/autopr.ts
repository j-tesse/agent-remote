// Harness-agnostic auto-PR capability of AI-assistant mode: the runner
// server/turnRouter.ts calls when a settled turn looks finished (or when the
// dialog's "Run now" asks outright). The router owns the hook, the single-flight
// and the note channel; this file owns the git/PR flow itself. Like assistant.ts
// it lives in the backend, so it runs with no browser open.
//
// The flow, in the session's launch folder:
//   1. branch  — if on the integration branch, cut `<user>/<llm-slug>`;
//                else put an unpushed agent-cut branch under `<user>/`
//   2. commit  — `git add -A` + an LLM-written one-line subject
//   3. push    — `git push -u origin <branch>`
//   4. PR      — drive a real `pi /pr` session (server/prAgent.ts)
//   5. merge   — `gh pr merge --squash --delete-branch`   } only when
//                (refused → poll checks in a live note, retry) }
//   6. main    — checkout + fast-forward the integration branch  } `autoMerge`
// Every step narrates itself into the origin session's transcript as an AI-mode
// note. Everything is best-effort: a failed step reports and stops, never throws.
// A merge that lands hands straight back to Continuity Mode, when it's on.
import type { AutoPrConfig } from "./config.js";
import { firstLine, type RunContext } from "./turnRouter.js";
import { runContinuity } from "./continuity.js";
import {
  branchExists,
  branchPrefix,
  currentBranch,
  fallbackSlug,
  gh,
  git,
  hasDiffVsBase,
  hasUpstream,
  isDirty,
  isRepo,
  mainBranch,
  checksState,
  listChecks,
  type PrCheck,
  openPrForBranch,
  prefixedBranch,
  sanitizeBranchName,
  sanitizeCommitMessage,
  stagedDiff,
  stagedFileCount,
  workingDiff,
} from "./git.js";
import { suggestBranchName, suggestCommitMessage } from "./llm.js";
import { runPrSession, type RanCommand } from "./prAgent.js";

/** RunContext plus a recording git runner: what the flow changed is replayed
 * to the PR agent so it can see what already happened. */
interface FlowContext extends RunContext {
  run: (args: string[], timeoutMs?: number) => ReturnType<typeof git>;
}

/** How many commit-message attempts before falling back to a generic subject. */
const COMMIT_ATTEMPTS = 3;
/** Longest we'll sit on a PR's checks before giving up on the merge. */
const CHECKS_TIMEOUT_MS = 45 * 60_000;
/** How often the checks are re-read while waiting. */
const CHECKS_POLL_MS = 15_000;
/** Empty polls tolerated before concluding there are no checks (~1 min). */
const NO_CHECKS_RETRIES = 4;
/** GitHub recomputes mergeability a beat after checks go green. */
const MERGE_RETRIES = 3;
const MERGE_RETRY_DELAY_MS = 10_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the repo state implies for this run. Pure, so the branching is testable:
 * - `nothing`  — clean tree and no divergence from the base: just go back to main
 * - `commit`   — uncommitted work to land before opening a PR
 * - `pr-only`  — nothing to commit, but the branch already differs from the base
 */
export function decideFlow(input: {
  dirty: boolean;
  onMain: boolean;
  diffVsBase: boolean;
}): "nothing" | "commit" | "pr-only" {
  if (input.dirty) return "commit";
  // On the integration branch with a clean tree there is by definition nothing
  // to propose, whatever `diffVsBase` says (it compares the branch to itself).
  if (input.onMain) return "nothing";
  return input.diffVsBase ? "pr-only" : "nothing";
}

/**
 * Land the session's work: branch, commit, push, open a PR, and — with
 * `autoMerge` — merge it and hand back to Continuity Mode. Called by
 * server/turnRouter.ts, which owns the settle hook, the single-flight and the
 * note channel.
 *
 * Best-effort: a failed step reports itself into the transcript and stops.
 */
export async function runAutoPr(
  ctx: RunContext,
  config?: AutoPrConfig,
  /** Router-driven: a clean tree means there was nothing to submit, so keep the
   * loop going instead of dead-ending (never for "Run now"). */
  opts: { continueIfNothing?: boolean } = {},
): Promise<void> {
  const harnessId = config?.harness ?? "pi";
  const command = config?.instructions?.trim() || config?.command?.trim() || "/pr";
  const { manager, sessionId, folder, note, failed } = ctx;

  const settings = manager.chatState(sessionId)?.assistant.autoPr;
  const instructions = settings?.instructions;
  const autoMerge = settings?.autoMerge ?? false;

  if (!(await isRepo(folder))) {
    note("error", "Not a git repository", folder);
    return;
  }

  const history: RanCommand[] = [];
  const flow: FlowContext = {
    ...ctx,
    run: async (args, timeoutMs) => {
      const result = await git(folder, args, timeoutMs);
      history.push({ args, result });
      return result;
    },
  };

  const base = await mainBranch(folder);
  // Best-effort refresh so the base comparison and the later pull are honest.
  await flow.run(["fetch", "origin", base], 60_000);
  const branch = await currentBranch(folder);
  const onMain = branch === base || branch === null;
  const dirty = await isDirty(folder);
  const diffVsBase = await hasDiffVsBase(folder, `origin/${base}`);

  const plan = decideFlow({ dirty, onMain, diffVsBase });
  if (plan === "nothing") {
    note("note", "Nothing to open a PR for", "the tree is clean");
    await returnToBase(ctx, base);
    if (opts.continueIfNothing) await runContinuity(ctx, { afterPr: false });
    return;
  }

  // --- 1. branch -----------------------------------------------------------
  let working = branch;
  if (onMain) {
    working = await cutBranch(flow, base, instructions);
    if (!working) return;
  } else if (working) {
    working = await prefixBranch(flow, working);
    if (!working) return;
  }

  // --- 2. commit -----------------------------------------------------------
  if (dirty && !(await commitAll(flow, instructions))) return;

  // --- 3. push -------------------------------------------------------------
  const push = await flow.run(
    ["push", "-u", "origin", working ?? "HEAD"],
    180_000,
  );
  if (!push.ok) {
    failed("Push failed", push);
    return;
  }
  note("note", `Pushed ${working ?? "HEAD"} to origin`);

  // --- 4. PR ---------------------------------------------------------------
  // A branch keeps its PR across turns: the push above already updated it, so
  // opening another would be a duplicate (and `/pr` would likely just fail).
  const existing = working ? await openPrForBranch(folder, working) : null;
  let pr: { prNumber: number | null; prUrl: string | null };
  if (existing) {
    pr = { prNumber: existing.number, prUrl: existing.url };
    note(
      "note",
      `PR #${existing.number} already open`,
      dirty ? "pushed the new commit to it" : "nothing new to add",
    );
  } else {
    // The session id exists only once it's started, so the "drafting" note is
    // posted from the callback — a beat later, but carrying a link to its tab.
    // The failure notes want it most: a run that hits a bound deliberately
    // LEAVES that session open for a human, who otherwise has to find it by eye.
    let prSession: string | undefined;
    const opened = await runPrSession(manager, {
      parent: ctx.sessionId,
      folder,
      harnessId,
      command,
      instructions,
      history,
      onSession: (id) => {
        prSession = id;
        note(
          "note",
          "Drafting the pull request",
          // Free-text instructions can be long; only a slash command names the session well.
          /^\/\S+$/.test(command)
            ? `in a ${harnessId} ${command} session`
            : `in a ${harnessId} session`,
          { session: id },
        );
      },
      report: (summary, detail) => note("error", summary, detail, { session: prSession }),
    });
    if (!opened) return;
    pr = opened;
    const created = pr.prNumber != null ? `PR #${pr.prNumber}` : "the PR";
    note("note", `Opened ${created}`, pr.prUrl ?? undefined);
  }
  const label = pr.prNumber != null ? `PR #${pr.prNumber}` : "PR";

  if (!autoMerge) return;

  // --- 5. merge ------------------------------------------------------------
  const target = pr.prNumber != null ? String(pr.prNumber) : pr.prUrl;
  if (!target) {
    note("error", "Cannot merge", "no PR reference was reported");
    return;
  }
  if (!(await mergeWhenReady(ctx, target, label))) return;
  note("note", `Merged ${label}`, "squashed, branch deleted");

  // --- 6. back to main -----------------------------------------------------
  await returnToBase(ctx, base);

  // --- 7. keep going -------------------------------------------------------
  // The work landed, so this is the `after-pr` moment: hand to Continuity Mode
  // (a no-op when it's off). Still inside the router's single-flight, with the
  // anchor pinned, so it can't race a settle of its own.
  await runContinuity(ctx, { afterPr: true });
}

/** Merge the PR. Assumes no checks gate it; if the merge is refused, poll its
 * checks — narrated as ONE live note whose rows update in place — and retry
 * once they're green. */
async function mergeWhenReady(ctx: RunContext, target: string, label: string): Promise<boolean> {
  const { folder, note, failed } = ctx;
  const merge = () => gh(folder, ["pr", "merge", target, "--squash", "--delete-branch"]);
  let result = await merge();
  if (result.ok) return true;

  const id = `auto-pr:checks:${target}:${Date.now()}`;
  const live: typeof note = (outcome, summary, reason, extra) =>
    note(outcome, summary, reason, { ...extra, id, update: true });
  const tally = (checks: PrCheck[]) =>
    `${checks.filter((c) => c.bucket !== "pending").length} of ${checks.length} done`;
  live("note", `Waiting for checks on ${label}`, "the merge was refused; retrying once they pass");

  const deadline = Date.now() + CHECKS_TIMEOUT_MS;
  let checks: PrCheck[] = [];
  let empties = 0;
  let shown = "";
  for (;;) {
    checks = await listChecks(folder, target);
    const state = checksState(checks);
    if (state === "none") {
      // A fresh commit's checks may not be registered yet.
      if (++empties > NO_CHECKS_RETRIES) {
        const stderr = result.stderr.trim();
        live("error", `Merging ${label} failed`, firstLine(stderr), { detail: stderr || undefined });
        return false;
      }
    } else if (state === "failed") {
      live("error", `Checks failed on ${label}`, tally(checks), { checks });
      return false;
    } else if (state === "passed") {
      live("note", `Checks passed on ${label}`, undefined, { checks });
      break;
    } else {
      // Only re-post on a change: every update is a broadcast to each client.
      const sig = checks.map((c) => `${c.name}=${c.bucket}`).join("|");
      if (sig !== shown) {
        shown = sig;
        live("note", `Waiting for checks on ${label}`, tally(checks), { checks });
      }
    }
    if (Date.now() >= deadline) {
      live("error", `Gave up waiting for checks on ${label}`,
        `still running after ${CHECKS_TIMEOUT_MS / 60_000} min`, { checks });
      return false;
    }
    await sleep(CHECKS_POLL_MS);
  }

  for (let i = 0; i < MERGE_RETRIES; i++) {
    result = await merge();
    if (result.ok) return true;
    await sleep(MERGE_RETRY_DELAY_MS);
  }
  failed(`Merging ${label} failed`, result);
  return false;
}

/** Cut `<prefix>/<slug>` off the current commit, naming it via the LLM with a
 * deterministic fallback. Returns the new branch, or null if checkout failed. */
async function cutBranch(
  ctx: FlowContext,
  base: string,
  instructions?: string,
): Promise<string | null> {
  const { folder, note, failed } = ctx;
  const prefix = await branchPrefix(folder);
  const suggested = await suggestBranchName(await workingDiff(folder), instructions);
  const slug = sanitizeBranchName(suggested) ?? fallbackSlug();
  let name = `${prefix}/${slug}`;
  for (let n = 2; await branchExists(folder, name); n++) name = `${prefix}/${slug}-${n}`;

  const checkout = await ctx.run(["checkout", "-b", name]);
  if (!checkout.ok) {
    failed(`Could not create branch ${name}`, checkout);
    return null;
  }
  note("note", `Created branch ${name}`, `off ${base}`);
  return name;
}

/** Put a branch the agent cut itself under `<prefix>/` before it's pushed —
 * else the push strands an unprefixed remote branch. A branch that already
 * tracks a remote is left alone: its name may carry an open PR. Returns the
 * branch to use, or null if the rename failed. */
async function prefixBranch(ctx: FlowContext, branch: string): Promise<string | null> {
  const { folder, note, failed } = ctx;
  const target = prefixedBranch(branch, await branchPrefix(folder));
  if (!target || (await hasUpstream(folder, branch))) return branch;
  let name = target;
  for (let n = 2; await branchExists(folder, name); n++) name = `${target}-${n}`;
  const rename = await ctx.run(["branch", "-m", branch, name]);
  if (!rename.ok) {
    failed(`Could not rename ${branch} to ${name}`, rename);
    return null;
  }
  note("note", `Renamed branch ${branch} to ${name}`);
  return name;
}

/** Stage everything and commit it with an LLM-written subject. */
async function commitAll(
  ctx: FlowContext,
  instructions?: string,
): Promise<boolean> {
  const { folder, note, failed } = ctx;
  const add = await ctx.run(["add", "-A"]);
  if (!add.ok) {
    failed("Could not stage the changes", add);
    return false;
  }
  const diff = await stagedDiff(folder);
  const rejected: string[] = [];
  let message: string | null = null;
  for (let i = 0; i < COMMIT_ATTEMPTS && !message; i++) {
    const raw = await suggestCommitMessage(diff, instructions, rejected);
    if (!raw) break; // Endpoint down — retrying won't help.
    message = sanitizeCommitMessage(raw);
    if (!message) rejected.push(raw);
  }
  if (!message) {
    const files = await stagedFileCount(folder);
    message = `auto-pr: update ${files} file${files === 1 ? "" : "s"}`;
  }
  // Signing is interactive (git-helper primes a YubiKey touch for exactly
  // this); headless it would hang forever.
  const commit = await ctx.run([
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    message,
  ]);
  if (!commit.ok) {
    failed("Commit failed", commit);
    return false;
  }
  note("note", "Committed", message);
  return true;
}

/** Check out the integration branch and fast-forward it. */
async function returnToBase(ctx: RunContext, base: string): Promise<void> {
  const { folder, note, failed } = ctx;
  const checkout = await git(folder, ["checkout", base]);
  if (!checkout.ok) {
    failed(`Could not check out ${base}`, checkout);
    return;
  }
  const pull = await git(folder, ["pull", "--ff-only", "origin", base], 120_000);
  if (!pull.ok) {
    failed(`Could not update ${base}`, pull);
    return;
  }
  note("note", `Back on ${base}`, `fast-forwarded to origin/${base}`);
}
