import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldContent } from "./contentScaffold.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scaffold-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("scaffoldContent", () => {
  it("creates an empty markdown file and nothing else", async () => {
    await scaffoldContent(root, { mediaType: "markdown", path: "notes.md" });
    expect(await readFile(join(root, "notes.md"), "utf8")).toBe("");
    expect(await readdir(root)).toEqual(["notes.md"]);
  });

  it("writes the learn template plus a kit copy beside it", async () => {
    await scaffoldContent(root, { mediaType: "learn", path: "lessons/a.html" });
    const page = await readFile(join(root, "lessons/a.html"), "utf8");
    expect(page).toContain('href="learnkit/kit.css"');
    expect(page).toContain('src="learnkit/kit.js"');
    expect((await readdir(join(root, "lessons/learnkit"))).sort()).toEqual([
      "README.md",
      "kit.css",
      "kit.js",
    ]);
    expect(await readFile(join(root, "lessons/learnkit/kit.js"), "utf8")).toMatch(/learnkit v1/);
  });

  it("never overwrites an existing page or kit", async () => {
    await mkdir(join(root, "learnkit"));
    await writeFile(join(root, "lesson.html"), "<p>mine</p>");
    await writeFile(join(root, "learnkit/kit.css"), "/* old */");
    await scaffoldContent(root, { mediaType: "learn", path: "lesson.html" });
    expect(await readFile(join(root, "lesson.html"), "utf8")).toBe("<p>mine</p>");
    expect(await readFile(join(root, "learnkit/kit.css"), "utf8")).toBe("/* old */");
    // Missing companions are still filled in.
    expect(await readFile(join(root, "learnkit/kit.js"), "utf8")).toMatch(/learnkit v1/);
  });

  it("refuses to escape the folder", async () => {
    await expect(
      scaffoldContent(root, { mediaType: "learn", path: "../x.html" }),
    ).rejects.toThrow();
  });
});
