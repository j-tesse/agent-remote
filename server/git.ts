// Git primitives for the auto-PR flow, plus the pure name/message sanitizers it
// feeds LLM output through. Every call is cwd-scoped and timed out, and returns
// a result instead of throwing — auto-PR is best-effort and must never take the
// server down on a failed git invocation.
import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 15_000;
/** Same budget ~/scripts/git-helper.sh uses: leaves room for the prompt around it. */
export const MAX_DIFF_CHARS = 30_000;
/** Branch slugs stay short enough to read in a tab/PR list. */
const MAX_SLUG_CHARS = 40;
/** git-helper rejects anything longer; a commit subject is a headline. */
const MAX_COMMIT_CHARS = 72;

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run one git command in `cwd`. Never throws: a non-zero exit is `ok: false`. */
export async function git(
  cwd: string,
  args: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      // Never let a credential/passphrase prompt block a headless run.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: e.stdout ?? "",
      stderr: e.stderr || e.message || "git failed",
    };
  }
}

/** Run `gh` (GitHub CLI) in `cwd`. Same never-throw contract as `git`. */
export async function gh(
  cwd: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("gh", args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: e.stdout ?? "",
      stderr: e.stderr || e.message || "gh failed",
    };
  }
}

/** GitHub Pages URL for an `origin` remote whose repo name ends in `.github.io`,
 * else null. `<owner>.github.io` is the user/org site at the root; any other
 * `*.github.io` name is a project site under `/<repo>/`. Pure. */
export function pagesUrlFromRemote(remote: string): string | null {
  const m = /[:/]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?\s*$/.exec(remote.trim());
  if (!m) return null;
  const [, owner, repo] = m;
  if (!/\.github\.io$/i.test(repo)) return null;
  const host = `${owner.toLowerCase()}.github.io`;
  return repo.toLowerCase() === host ? `https://${host}/` : `https://${host}/${repo}/`;
}

/** The Pages link for the repo in `cwd`, or null when it isn't a `*.github.io`
 * repo. Prefers GitHub's own `html_url` (honours a custom domain), falling back
 * to the derived URL when `gh` can't tell. */
export async function pagesUrl(cwd: string): Promise<string | null> {
  const remote = await git(cwd, ["remote", "get-url", "origin"]);
  const derived = remote.ok ? pagesUrlFromRemote(remote.stdout) : null;
  if (!derived) return null;
  const api = await gh(cwd, ["api", "repos/{owner}/{repo}/pages", "--jq", ".html_url"], 30_000);
  const url = api.ok ? api.stdout.trim() : "";
  return /^https?:\/\/\S+$/.test(url) ? url : derived;
}

/** A pull request GitHub already has open for a branch. */
export interface OpenPr {
  number: number;
  url: string | null;
}

/** The open PR whose head is `branch`, if there is one. `null` covers both "no
 * open PR" and "couldn't tell" (no `gh`, not authenticated, no remote, junk
 * JSON) — the caller treats them alike and falls through to creating one, which
 * is the pre-existing behaviour and reports its own failure. Draft PRs count as
 * open; merged/closed ones don't, so a reused branch can get a fresh PR. */
export async function openPrForBranch(
  cwd: string,
  branch: string,
): Promise<OpenPr | null> {
  const r = await gh(
    cwd,
    ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url", "--limit", "1"],
    60_000,
  );
  return r.ok ? parseOpenPr(r.stdout) : null;
}

/** Read `gh pr list --json number,url` output. `[]` (no open PR) and unparseable
 * output both mean null — the distinction is the caller's fallthrough either
 * way. Pure, so the "no PR" shape is pinned by a test. */
export function parseOpenPr(stdout: string): OpenPr | null {
  try {
    const rows: unknown = JSON.parse(stdout);
    const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown>) : null;
    if (!row || typeof row.number !== "number" || !Number.isFinite(row.number))
      return null;
    return {
      number: Math.trunc(row.number),
      url: typeof row.url === "string" && row.url ? row.url : null,
    };
  } catch {
    return null;
  }
}

/** One check on a PR, as `gh pr checks --json` reports it. */
export interface PrCheck {
  name: string;
  /** gh's coarse category: pass | fail | pending | skipping | cancel. */
  bucket: string;
  state: string;
  link?: string;
}

/** Read `gh pr checks --json name,workflow,bucket,state,link`. Junk → []. Pure. */
export function parseChecks(stdout: string): PrCheck[] {
  try {
    const rows: unknown = JSON.parse(stdout);
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((r: Record<string, unknown>) => {
      if (!r || typeof r.name !== "string" || !r.name) return [];
      const wf = typeof r.workflow === "string" && r.workflow ? r.workflow : null;
      return [{
        name: wf && wf !== r.name ? `${wf} / ${r.name}` : r.name,
        bucket: typeof r.bucket === "string" ? r.bucket : "",
        state: typeof r.state === "string" ? r.state : "",
        ...(typeof r.link === "string" && r.link ? { link: r.link } : {}),
      }];
    });
  } catch {
    return [];
  }
}

/** Where a set of checks stands. `none` = nothing reported (yet). Pure. */
export function checksState(checks: PrCheck[]): "none" | "pending" | "failed" | "passed" {
  if (!checks.length) return "none";
  if (checks.some((c) => c.bucket === "fail" || c.bucket === "cancel")) return "failed";
  if (checks.some((c) => c.bucket === "pending")) return "pending";
  return "passed";
}

/** The PR's checks with their individual status. Best-effort: [] on any error.
 * gh exits non-zero while checks fail/pend, but still prints the JSON. */
export async function listChecks(cwd: string, pr: string): Promise<PrCheck[]> {
  const r = await gh(cwd, ["pr", "checks", pr, "--json", "name,workflow,bucket,state,link"], 60_000);
  return parseChecks(r.stdout);
}

export async function isRepo(cwd: string): Promise<boolean> {
  const r = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return r.ok && r.stdout.trim() === "true";
}

/** Current branch name, or null when detached / not a repo. */
export async function currentBranch(cwd: string): Promise<string | null> {
  const r = await git(cwd, ["branch", "--show-current"]);
  const name = r.stdout.trim();
  return r.ok && name ? name : null;
}

/** The repo's integration branch: whatever `origin/HEAD` points at, else main,
 * else master. (git-helper hardcodes a master-first preference; deferring to the
 * remote's own HEAD is correct for repos that use either.) */
export async function mainBranch(cwd: string): Promise<string> {
  const symref = await git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const name = symref.stdout.trim().replace(/^origin\//, "");
  if (symref.ok && name) return name;
  if (await branchExists(cwd, "main")) return "main";
  if (await branchExists(cwd, "master")) return "master";
  return "main";
}

/** Does a local branch (or any ref) of this name exist? */
export async function branchExists(cwd: string, name: string): Promise<boolean> {
  const r = await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
  return r.ok && r.stdout.trim().length > 0;
}

/** Uncommitted work of any kind, including untracked files. */
export async function isDirty(cwd: string): Promise<boolean> {
  const r = await git(cwd, ["status", "--porcelain"]);
  return r.ok && r.stdout.trim().length > 0;
}

/** Does HEAD differ from `base` at all? (Committed divergence only.) */
export async function hasDiffVsBase(cwd: string, base: string): Promise<boolean> {
  const r = await git(cwd, ["diff", "--quiet", base, "HEAD"]);
  // `--quiet` exits 1 when there IS a diff, 0 when identical.
  return !r.ok;
}

/** Everything uncommitted, as a prompt-sized diff: tracked changes plus the
 * names of untracked files (their content is usually noise for a summary). */
export async function workingDiff(cwd: string): Promise<string> {
  const tracked = await git(cwd, ["diff", "HEAD"]);
  const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  const names = untracked.stdout.trim();
  const parts = [tracked.stdout.trim()];
  if (names) parts.push(`New files:\n${names}`);
  return truncateDiff(parts.filter(Boolean).join("\n\n"));
}

/** The staged diff, for commit-message generation (git-helper does the same). */
export async function stagedDiff(cwd: string): Promise<string> {
  const r = await git(cwd, ["diff", "--cached"]);
  return truncateDiff(r.stdout.trim());
}

/** How many files the staged change touches, for the fallback commit message. */
export async function stagedFileCount(cwd: string): Promise<number> {
  const r = await git(cwd, ["diff", "--cached", "--name-only"]);
  return r.stdout.trim() ? r.stdout.trim().split("\n").length : 0;
}

/** Clip a diff to a prompt-sized budget, marking that it was cut. */
export function truncateDiff(diff: string, max = MAX_DIFF_CHARS): string {
  if (diff.length <= max) return diff;
  return `${diff.slice(0, max)}\n\n[... diff truncated due to size ...]`;
}

/** Branch-name prefix from the committer's identity, mirroring git-helper's
 * `get_branch_prefix`. NFKD *decomposes* (ö → o + combining diaeresis) so the
 * mark can be dropped, leaving ASCII; NFC/NFKC would compose and keep the
 * umlaut. Pure so it can be tested without a repo. */
export function derivePrefix(
  name: string | undefined,
  email: string | undefined,
  osUser: string,
): string {
  const fromName = (name ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .trim()
    .split(/\s+/)[0]
    ?.toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");
  if (fromName) return fromName;
  const local = (email ?? "").split("@")[0].toLowerCase().replace(/[^a-z0-9._-]/g, "");
  if (local) return local;
  return osUser.toLowerCase().replace(/[^a-z0-9._-]/g, "") || "auto";
}

/** The committer prefix for this repo (`user.name`, else email, else OS user). */
export async function branchPrefix(cwd: string): Promise<string> {
  const name = await git(cwd, ["config", "user.name"]);
  const email = await git(cwd, ["config", "user.email"]);
  let osUser = "auto";
  try {
    osUser = userInfo().username;
  } catch {
    // No passwd entry (containers); the "auto" fallback is fine.
  }
  return derivePrefix(name.stdout.trim(), email.stdout.trim(), osUser);
}

/** `<prefix>/<branch>` for a branch not already under the prefix, else null. */
export function prefixedBranch(branch: string, prefix: string): string | null {
  return branch.startsWith(`${prefix}/`) ? null : `${prefix}/${branch}`;
}

/** Has this branch been pushed (tracks an upstream)? */
export async function hasUpstream(cwd: string, branch: string): Promise<boolean> {
  const r = await git(cwd, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
  return r.ok && r.stdout.trim().length > 0;
}

/** Squeeze an LLM-proposed branch name into the allowed alphabet: lowercase
 * alphanumerics and dashes only, bounded length. Returns null when nothing
 * usable survives, so the caller falls back to a deterministic name. */
export function sanitizeBranchName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let slug = raw
    .trim()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    // Everything that isn't in the alphabet becomes a separator, then collapses.
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) return null;
  if (slug.length > MAX_SLUG_CHARS) {
    // Only back off to a word boundary when the cut lands mid-word, and never
    // down to a stub.
    const splitsWord = slug[MAX_SLUG_CHARS] !== "-";
    slug = slug.slice(0, MAX_SLUG_CHARS);
    const lastDash = slug.lastIndexOf("-");
    if (splitsWord && lastDash >= MAX_SLUG_CHARS / 2) slug = slug.slice(0, lastDash);
    slug = slug.replace(/-+$/, "");
  }
  return slug || null;
}

/** Accept an LLM-proposed commit subject only if it's a single line within the
 * headline budget; otherwise null, so the caller retries or falls back. */
export function sanitizeCommitMessage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const msg = raw.trim().replace(/^["'`]|["'`]$/g, "").trim();
  if (!msg) return null;
  if (/[\r\n]/.test(msg)) return null;
  if (msg.length > MAX_COMMIT_CHARS) return null;
  return msg;
}

/** `auto-pr-20260824-1432` — the deterministic branch slug when the LLM is
 * unavailable or its suggestion doesn't survive sanitizing. */
export function fallbackSlug(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `auto-pr-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}
