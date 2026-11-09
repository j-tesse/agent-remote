import { describe, it, expect } from "vitest";
import { escapeScript, planRef } from "./refs";

describe("planRef", () => {
  it("inlines folder-relative kit/source files as text", () => {
    expect(planRef("l/a.html", "learnkit/kit.css")).toEqual({
      kind: "text",
      path: "l/learnkit/kit.css",
      mime: "text/css",
    });
    expect(planRef("a.html", "./kit.js?v=2")?.kind).toBe("text");
    expect(planRef("a.html", "img/d.svg")?.mime).toBe("image/svg+xml");
  });

  it("inlines previewable media as data URLs", () => {
    expect(planRef("l/a.html", "../pics/x.PNG")).toEqual({
      kind: "media",
      path: "pics/x.PNG",
      mime: "image/png",
    });
  });

  it("leaves absolute, data, escaping and unknown refs alone", () => {
    for (const href of ["https://x/y.css", "data:image/png;base64,AA", "/abs.css", "#frag", "../x.css", "a.txt", "", null])
      expect(planRef("a.html", href)).toBeNull();
  });
});

describe("escapeScript", () => {
  it("can't terminate the inlined element", () => {
    expect(escapeScript('x = "</script><b>"')).toBe('x = "<\\/script><b>"');
  });
});
