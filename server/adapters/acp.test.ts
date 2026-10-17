import { describe, expect, it } from "vitest";
import { toolView } from "../../shared/render.js";
import { acpOptions, acpPlanText, acpToolArgs, acpToolName, acpToolOutput } from "./acp.js";

describe("acpOptions", () => {
  it("maps option kinds to intents and keeps optionId as the value", () => {
    expect(
      acpOptions([
        { optionId: "a", name: "Allow", kind: "allow_once" },
        { optionId: "b", name: "Always", kind: "allow_always" },
        { optionId: "c", name: "No", kind: "reject_always" },
        { optionId: "d", kind: "weird" },
      ]),
    ).toEqual([
      { value: "a", label: "Allow", intent: "accept" },
      { value: "b", label: "Always", intent: "always" },
      { value: "c", label: "No", intent: "reject" },
      { value: "d", label: "d" },
    ]);
  });
});

describe("acpToolArgs", () => {
  it("turns ACP diff content into edits[] the shared diff view reads", () => {
    const args = acpToolArgs({
      toolCallId: "t",
      kind: "edit",
      title: "Edit a.ts",
      content: [{ type: "diff", path: "/w/a.ts", oldText: "x", newText: "y" }],
    });
    expect(args).toMatchObject({ path: "/w/a.ts", edits: [{ oldText: "x", newText: "y" }] });
    const view = toolView({ type: "tool", toolId: "t", name: "edit", args, output: "", status: "done" });
    expect(view.body.kind).toBe("diff");
  });

  it("treats a null oldText (new file) as a pure insertion", () => {
    const args = acpToolArgs({ toolCallId: "t", content: [{ type: "diff", path: "/n", oldText: null, newText: "z" }] });
    expect(args.edits).toEqual([{ oldText: "", newText: "z" }]);
  });

  it("keeps rawInput, falls back to locations for the path, and adds the title", () => {
    expect(
      acpToolArgs({ toolCallId: "t", title: "Run tests", rawInput: { command: "npm test" }, locations: [{ path: "/w" }] }),
    ).toEqual({ command: "npm test", path: "/w", description: "Run tests" });
  });
});

describe("acpToolName / acpToolOutput / acpPlanText", () => {
  it("names by kind, else title", () => {
    expect(acpToolName({ kind: "execute", title: "x" })).toBe("execute");
    expect(acpToolName({ kind: "other", title: "Fetch docs" })).toBe("Fetch docs");
  });

  it("extracts text content, else rawOutput", () => {
    expect(acpToolOutput({ content: [{ type: "content", content: { type: "text", text: "ok" } }] })).toBe("ok");
    expect(acpToolOutput({ rawOutput: { stdout: "hi" } })).toBe("hi");
    expect(acpToolOutput({})).toBeUndefined();
  });

  it("renders a plan checklist", () => {
    expect(
      acpPlanText([
        { content: "a", status: "completed" },
        { content: "b", status: "in_progress" },
        { content: "c", status: "pending" },
      ]),
    ).toBe("[x] a\n[~] b\n[ ] c");
  });
});
