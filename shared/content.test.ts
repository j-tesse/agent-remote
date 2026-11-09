import { describe, it, expect } from "vitest";
import {
  CONTENT_TYPES,
  learnKitDir,
  matchesType,
  resolveContentLink,
  validatePointer,
} from "./content";

describe("validatePointer", () => {
  it("accepts and normalizes a relative markdown path", () => {
    expect(validatePointer({ mediaType: "markdown", path: "./docs//plan.md " })).toEqual({
      mediaType: "markdown",
      path: "docs/plan.md",
    });
    expect(validatePointer({ mediaType: "markdown", path: "README.MARKDOWN" })?.path).toBe(
      "README.MARKDOWN",
    );
  });

  it("rejects escapes, absolute paths and junk", () => {
    for (const path of ["/etc/x.md", "../x.md", "a/../../x.md", "", "  ", "a/\0.md", "dir/"])
      expect(validatePointer({ mediaType: "markdown", path })).toBeNull();
    expect(validatePointer(null)).toBeNull();
    expect(validatePointer({ mediaType: "markdown" })).toBeNull();
    expect(validatePointer({ mediaType: "html", path: "x.md" })).toBeNull();
    expect(validatePointer({ mediaType: "toString", path: "x.md" })).toBeNull();
  });

  it("requires a matching extension with a name in front", () => {
    expect(validatePointer({ mediaType: "markdown", path: "notes.txt" })).toBeNull();
    expect(validatePointer({ mediaType: "markdown", path: "docs/.md" })).toBeNull();
  });
});

describe("learn pointers", () => {
  it("accepts html pages and rejects other extensions", () => {
    expect(validatePointer({ mediaType: "learn", path: "./l/intro.HTML" })?.path).toBe("l/intro.HTML");
    expect(validatePointer({ mediaType: "learn", path: "x.htm" })?.path).toBe("x.htm");
    expect(validatePointer({ mediaType: "learn", path: "x.md" })).toBeNull();
    expect(validatePointer({ mediaType: "learn", path: "../x.html" })).toBeNull();
  });

  it("puts the kit beside the page and points the agent at its README", () => {
    expect(learnKitDir("lesson.html")).toBe("learnkit");
    expect(learnKitDir("a/b/lesson.html")).toBe("a/b/learnkit");
    const text = CONTENT_TYPES.learn.instructions("a/lesson.html");
    expect(text).toContain("`a/lesson.html`");
    expect(text).toContain("`a/learnkit/README.md`");
  });
});

describe("registry", () => {
  it("names the file in the framing text", () => {
    expect(CONTENT_TYPES.markdown.instructions("docs/plan.md")).toContain("`docs/plan.md`");
  });

  it("filters picker entries by extension", () => {
    expect(matchesType("markdown", "A.Md")).toBe(true);
    expect(matchesType("markdown", "a.txt")).toBe(false);
  });
});

describe("resolveContentLink", () => {
  it("resolves relative to the document's directory", () => {
    expect(resolveContentLink("docs/plan.md", "img/a.png")).toBe("docs/img/a.png");
    expect(resolveContentLink("docs/plan.md", "./a%20b.png?x=1")).toBe("docs/a b.png");
    expect(resolveContentLink("docs/plan.md", "../top.png")).toBe("top.png");
    expect(resolveContentLink("plan.md", "a.png")).toBe("a.png");
  });

  it("leaves absolute links and escapes alone", () => {
    for (const href of ["https://x.y/a.png", "data:image/png;base64,AA", "/abs.png", "//cdn/x", "#top", "mailto:a@b"])
      expect(resolveContentLink("docs/plan.md", href)).toBeNull();
    expect(resolveContentLink("plan.md", "../out.png")).toBeNull();
  });
});
