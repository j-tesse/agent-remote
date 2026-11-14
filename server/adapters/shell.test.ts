import { describe, expect, it } from "vitest";
import { ShellEventParser } from "./shell.js";

describe("ShellEventParser sudo marker", () => {
  it("strips the marker and emits sudo-prompt, even split across chunks", () => {
    const p = new ShellEventParser();
    const a = p.push("[sudo] password for joran: \x1b]63");
    expect(a.output).toBe("[sudo] password for joran: ");
    expect(a.events).toEqual([]);
    const b = p.push("3;S\x07");
    expect(b.output).toBe("");
    expect(b.events.map((e) => e.type)).toEqual(["sudo-prompt"]);
  });
});
