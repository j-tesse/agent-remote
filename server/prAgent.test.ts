import { describe, expect, it } from "vitest";
import { formatCommandLog, prSessionFraming, shellQuote } from "./prAgent.js";

const ok = (stdout = "", stderr = "") => ({ ok: true, stdout, stderr });

describe("shellQuote", () => {
  it("leaves plain args bare and quotes the rest", () => {
    expect(shellQuote("-A")).toBe("-A");
    expect(shellQuote("commit.gpgsign=false")).toBe("commit.gpgsign=false");
    expect(shellQuote("joran/x")).toBe("joran/x");
    expect(shellQuote("Fix the bug")).toBe("'Fix the bug'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("formatCommandLog", () => {
  it("renders commands with output as a terminal transcript", () => {
    const log = formatCommandLog([
      { args: ["add", "-A"], result: ok() },
      { args: ["commit", "-m", "Fix it"], result: ok("[joran/x 1a2b] Fix it\n 1 file changed\n") },
      { args: ["push", "-u", "origin", "joran/x"], result: ok("", "To origin\n * [new branch]\n") },
    ]);
    expect(log).toBe(
      "$ git add -A\n\n" +
        "$ git commit -m 'Fix it'\n[joran/x 1a2b] Fix it\n 1 file changed\n\n" +
        "$ git push -u origin joran/x\nTo origin\n * [new branch]",
    );
  });

  it("marks failures and caps long output", () => {
    const log = formatCommandLog([
      { args: ["fetch", "origin", "main"], result: { ok: false, stdout: "", stderr: "x".repeat(5000) } },
    ]);
    expect(log.endsWith("…\n(exited non-zero)")).toBe(true);
    expect(log.length).toBeLessThan(1_600);
  });
});

describe("prSessionFraming", () => {
  it("frames the session as agent-driven, appending the log only when there is one", () => {
    const bare = prSessionFraming();
    expect(bare).toMatch(/LLM-based agent/);
    expect(bare).not.toMatch(/unattended|```/);
    const withLog = prSessionFraming([{ args: ["add", "-A"], result: ok() }]);
    expect(withLog).toContain("```\n$ git add -A\n```");
  });
});
