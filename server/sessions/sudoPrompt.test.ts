import { describe, expect, it } from "vitest";
import { SudoPromptTracker } from "./sudoPrompt.js";

describe("SudoPromptTracker", () => {
  it("ignores a marker at a bare shell prompt", () => {
    const t = new SudoPromptTracker();
    expect(t.prompt("a", false)).toBeNull();
    expect(t.fill("a")).toBe(false);
  });

  it("fills a pending prompt exactly once", () => {
    const t = new SudoPromptTracker();
    expect(t.prompt("a", true)).toEqual({ id: "a", retry: false });
    expect(t.fill("a")).toBe(true);
    expect(t.fill("a")).toBe(false);
  });

  it("refuses a superseded id", () => {
    const t = new SudoPromptTracker();
    t.prompt("a", true);
    t.prompt("b", true);
    expect(t.fill("a")).toBe(false);
    expect(t.fill("b")).toBe(true);
  });

  it("clears on visible output, input and command boundaries", () => {
    const t = new SudoPromptTracker();
    t.prompt("a", true);
    expect(t.output("\r\n  ")).toBeNull();
    expect(t.output("sudo: timed out")).toBe("a");
    expect(t.fill("a")).toBe(false);
    t.prompt("b", true);
    expect(t.input()).toBe("b");
    t.prompt("c", true);
    expect(t.boundary()).toBe("c");
    expect(t.boundary()).toBeNull();
  });

  it("flags a re-prompt after a fill as a retry, until the command ends", () => {
    const t = new SudoPromptTracker();
    t.prompt("a", true);
    t.fill("a");
    expect(t.output("Sorry, try again.")).toBeNull();
    expect(t.prompt("b", true)?.retry).toBe(true);
    t.boundary();
    expect(t.prompt("c", true)?.retry).toBe(false);
  });
});
