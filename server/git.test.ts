import { describe, expect, it } from "vitest";
import {
  derivePrefix,
  checksState,
  parseChecks,
  fallbackSlug,
  pagesUrlFromRemote,
  parseOpenPr,
  prefixedBranch,
  sanitizeBranchName,
  sanitizeCommitMessage,
  truncateDiff,
} from "./git.js";

describe("prefixedBranch", () => {
  it("prefixes an agent-cut branch", () => {
    expect(prefixedBranch("osx-capture-fixes", "joran")).toBe("joran/osx-capture-fixes");
  });
  it("leaves an already-prefixed branch alone", () => {
    expect(prefixedBranch("joran/osx-capture-fixes", "joran")).toBeNull();
  });
  it("prefixes a branch under someone else's namespace", () => {
    expect(prefixedBranch("feature/x", "joran")).toBe("joran/feature/x");
    expect(prefixedBranch("joranx/y", "joran")).toBe("joran/joranx/y");
  });
});

describe("pagesUrlFromRemote", () => {
  it("maps a user site to the root, for ssh and https remotes", () => {
    expect(pagesUrlFromRemote("git@github.com:Joran/joran.github.io.git\n")).toBe(
      "https://joran.github.io/",
    );
    expect(pagesUrlFromRemote("https://github.com/joran/Joran.github.io")).toBe(
      "https://joran.github.io/",
    );
    expect(pagesUrlFromRemote("ssh://git@github.com/joran/joran.github.io.git")).toBe(
      "https://joran.github.io/",
    );
  });
  it("maps another *.github.io repo to a project path", () => {
    expect(pagesUrlFromRemote("git@github.com:org/docs.github.io.git")).toBe(
      "https://org.github.io/docs.github.io/",
    );
  });
  it("ignores ordinary repos and junk", () => {
    expect(pagesUrlFromRemote("git@github.com:joran/agent-remote.git")).toBeNull();
    expect(pagesUrlFromRemote("")).toBeNull();
  });
});

describe("derivePrefix", () => {
  it("uses the first name, ASCII-folded", () => {
    expect(derivePrefix("Jöran Tesse", "x@y.z", "os")).toBe("joran");
  });

  it("falls back to the email local part", () => {
    expect(derivePrefix("", "Joe.Random@example.com", "os")).toBe("joe.random");
  });

  it("falls back to the OS user when the name folds away entirely", () => {
    // CJK has no combining decomposition, so the ASCII filter empties it.
    expect(derivePrefix("张伟", "", "builder")).toBe("builder");
  });

  it("never returns an empty prefix", () => {
    expect(derivePrefix("", "", "")).toBe("auto");
  });
});

describe("sanitizeBranchName", () => {
  it("kebab-cases a phrase", () => {
    expect(sanitizeBranchName("Add PR flow")).toBe("add-pr-flow");
  });

  it("strips characters outside [a-z0-9-]", () => {
    expect(sanitizeBranchName("feat/fix_the thing! (v2)")).toBe(
      "feat-fix-the-thing-v2",
    );
  });

  it("folds accents rather than dropping the whole word", () => {
    expect(sanitizeBranchName("Ändere die Größe")).toBe("andere-die-gro-e");
  });

  it("collapses and trims separators", () => {
    expect(sanitizeBranchName("  --a---b--  ")).toBe("a-b");
  });

  it("caps length on a word boundary", () => {
    const slug = sanitizeBranchName(
      "add a really quite extremely long branch name that keeps going",
    );
    expect(slug!.length).toBeLessThanOrEqual(40);
    expect(slug).not.toMatch(/-$/);
    expect(slug).toBe("add-a-really-quite-extremely-long-branch");
  });

  it("rejects input with nothing usable", () => {
    expect(sanitizeBranchName("!!! ???")).toBeNull();
    expect(sanitizeBranchName("")).toBeNull();
    expect(sanitizeBranchName(undefined)).toBeNull();
  });
});

describe("parseOpenPr", () => {
  it("reads the open PR", () => {
    expect(
      parseOpenPr('[{"number":42,"url":"https://github.com/o/r/pull/42"}]'),
    ).toEqual({ number: 42, url: "https://github.com/o/r/pull/42" });
  });

  it("returns null for no open PR (gh prints an empty array)", () => {
    expect(parseOpenPr("[]")).toBeNull();
    expect(parseOpenPr("[]\n")).toBeNull();
  });

  it("returns null rather than guessing on unusable output", () => {
    // gh missing / not authenticated / a future --json shape.
    expect(parseOpenPr("")).toBeNull();
    expect(parseOpenPr("gh: command not found")).toBeNull();
    expect(parseOpenPr('{"number":42}')).toBeNull();
    expect(parseOpenPr('[{"url":"https://github.com/o/r/pull/42"}]')).toBeNull();
  });

  it("tolerates a missing url", () => {
    expect(parseOpenPr('[{"number":7}]')).toEqual({ number: 7, url: null });
  });
});

describe("sanitizeCommitMessage", () => {
  it("accepts and trims a single short line", () => {
    expect(sanitizeCommitMessage("  add auto PR flow  ")).toBe("add auto PR flow");
  });

  it("strips wrapping quotes a chatty model adds", () => {
    expect(sanitizeCommitMessage('"add auto PR flow"')).toBe("add auto PR flow");
  });

  it("rejects a multi-line message", () => {
    expect(sanitizeCommitMessage("add auto PR flow\n\nwith details")).toBeNull();
  });

  it("rejects a message over 72 chars", () => {
    expect(sanitizeCommitMessage("x".repeat(73))).toBeNull();
    expect(sanitizeCommitMessage("x".repeat(72))).toBe("x".repeat(72));
  });

  it("rejects empty input", () => {
    expect(sanitizeCommitMessage("   ")).toBeNull();
    expect(sanitizeCommitMessage(null)).toBeNull();
  });
});

describe("truncateDiff", () => {
  it("leaves a small diff alone", () => {
    expect(truncateDiff("small", 100)).toBe("small");
  });

  it("marks a clipped diff", () => {
    const out = truncateDiff("y".repeat(50), 10);
    expect(out.startsWith("y".repeat(10))).toBe(true);
    expect(out).toContain("truncated");
  });
});

describe("fallbackSlug", () => {
  it("is a valid branch slug", () => {
    const slug = fallbackSlug(new Date(2026, 7, 24, 14, 32));
    expect(slug).toBe("auto-pr-20260824-1432");
    expect(sanitizeBranchName(slug)).toBe(slug);
  });
});

describe("parseChecks / checksState", () => {
  const json = JSON.stringify([
    { name: "build", workflow: "CI", bucket: "pass", state: "SUCCESS", link: "https://x/1" },
    { name: "lint", workflow: "", bucket: "skipping", state: "SKIPPED", link: "" },
    { name: "deploy", workflow: "deploy", bucket: "pending", state: "IN_PROGRESS" },
    { workflow: "nameless" },
  ]);
  const checks = parseChecks(json);
  it("parses rows, prefixing the workflow unless it repeats the name", () => {
    expect(checks.map((c) => c.name)).toEqual(["CI / build", "lint", "deploy"]);
    expect(checks[0].link).toBe("https://x/1");
    expect(checks[1].link).toBeUndefined();
  });
  it("yields [] for junk", () => {
    expect(parseChecks("no checks reported")).toEqual([]);
    expect(parseChecks("{}")).toEqual([]);
  });
  it("classifies the set", () => {
    expect(checksState([])).toBe("none");
    expect(checksState(checks)).toBe("pending");
    expect(checksState(checks.slice(0, 2))).toBe("passed");
    expect(checksState([...checks, { name: "x", bucket: "fail", state: "FAILURE" }])).toBe("failed");
    expect(checksState([{ name: "x", bucket: "cancel", state: "CANCELLED" }])).toBe("failed");
  });
});
