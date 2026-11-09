import { describe, expect, it } from "vitest";
import { exportFileName, withDoctype } from "./exportHtml";

describe("exportFileName", () => {
  it("keeps the basename and .html", () => {
    expect(exportFileName("lessons/intro.html")).toBe("intro.html");
    expect(exportFileName("intro.html")).toBe("intro.html");
  });
  it("normalizes .htm and case", () => {
    expect(exportFileName("a/b/Page.HTM")).toBe("Page.html");
    expect(exportFileName("x.Html")).toBe("x.html");
  });
  it("adds .html when missing", () => {
    expect(exportFileName("notes/lesson")).toBe("lesson.html");
    expect(exportFileName("notes/lesson.v2")).toBe("lesson.v2.html");
  });
  it("falls back for empty names", () => {
    expect(exportFileName("")).toBe("page.html");
    expect(exportFileName("dir/")).toBe("dir.html");
    expect(exportFileName(".html")).toBe("page.html");
  });
});

describe("withDoctype", () => {
  it("leaves an existing doctype alone", () => {
    const h = "<!DOCTYPE html>\n<html></html>";
    expect(withDoctype(h)).toBe(h);
  });
  it("prepends one when missing", () => {
    expect(withDoctype("<html></html>")).toBe("<!doctype html>\n<html></html>");
  });
});
