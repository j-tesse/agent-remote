import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureTextFile,
  openDownload,
  parseRange,
  saveBinaryFile,
  statEntry,
} from "./files.js";

// The transfer functions are the ones that touch arbitrary bytes, so their
// confinement to the folder root is the security boundary worth pinning.

let root: string;
let outside: string;

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), "files-test-"));
  root = join(base, "root");
  outside = join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, "hello.txt"), "hi");
  await writeFile(join(outside, "secret.txt"), "classified");
});

afterAll(async () => {
  await rm(join(root, ".."), { recursive: true, force: true });
});

const collect = async (s: NodeJS.ReadableStream): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
};

describe("statEntry", () => {
  it("reports files and directories", async () => {
    expect(await statEntry(root, "hello.txt")).toEqual({ size: 2, isDir: false });
    expect((await statEntry(root, ""))?.isDir).toBe(true);
  });

  it("returns null for a missing path", async () => {
    expect(await statEntry(root, "nope.txt")).toBeNull();
  });

  it("refuses to escape the root", async () => {
    await expect(statEntry(root, "../outside/secret.txt")).rejects.toThrow(/outside/i);
  });
});

describe("openDownload", () => {
  it("streams file bytes", async () => {
    const { size, name, stream } = await openDownload(root, "hello.txt");
    expect({ size, name }).toEqual({ size: 2, name: "hello.txt" });
    expect(await collect(stream)).toBe("hi");
  });

  it("reads binary and oversized files that the editor would refuse", async () => {
    const bytes = Buffer.alloc(3 * 1024 * 1024, 0); // NUL-filled, over MAX_FILE_BYTES
    await writeFile(join(root, "big.bin"), bytes);
    const { size, stream } = await openDownload(root, "big.bin");
    expect(size).toBe(bytes.length);
    stream.destroy();
  });

  it("refuses a directory", async () => {
    await expect(openDownload(root, "")).rejects.toThrow(/directory/i);
  });

  it("refuses a missing file", async () => {
    await expect(openDownload(root, "nope.txt")).rejects.toThrow(/not found/i);
  });

  it("refuses to escape the root", async () => {
    await expect(openDownload(root, "../outside/secret.txt")).rejects.toThrow(/outside/i);
    await expect(openDownload(root, outside + "/secret.txt")).rejects.toThrow(/outside/i);
  });

  it("slices to a range while still reporting the whole size", async () => {
    await writeFile(join(root, "range.txt"), "0123456789");
    const { size, stream } = await openDownload(root, "range.txt", { start: 2, end: 4 });
    expect(size).toBe(10);
    expect(await collect(stream)).toBe("234");
  });

  // /api/media adds no confinement of its own — this is its security boundary.
  it("refuses to escape the root on a ranged read", async () => {
    await expect(
      openDownload(root, "../outside/secret.txt", { start: 0, end: 0 }),
    ).rejects.toThrow(/outside/i);
  });
});

describe("parseRange", () => {
  it("serves the whole file when there is no usable header", () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange("bytes=abc", 10)).toBeNull();
    // Multi-range: a 200 is a legal answer, so don't try to satisfy it.
    expect(parseRange("bytes=0-1,3-4", 10)).toBeNull();
  });

  it("parses the explicit and open-ended forms", () => {
    expect(parseRange("bytes=0-", 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=0-0", 10)).toEqual({ start: 0, end: 0 });
    expect(parseRange("bytes=2-5", 10)).toEqual({ start: 2, end: 5 });
    // An end past EOF is clamped, not rejected.
    expect(parseRange("bytes=1-99", 10)).toEqual({ start: 1, end: 9 });
  });

  it("parses the suffix form", () => {
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange("bytes=-99", 10)).toEqual({ start: 0, end: 9 });
  });

  it("reports unsatisfiable ranges", () => {
    expect(parseRange("bytes=-0", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=10-", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=5-2", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-", 0)).toBe("unsatisfiable");
  });
});

describe("saveBinaryFile", () => {
  it("writes a file and creates parent directories", async () => {
    await saveBinaryFile(root, "nested/deep/note.txt", Readable.from(["written"]));
    expect(await readFile(join(root, "nested/deep/note.txt"), "utf8")).toBe("written");
  });

  it("overwrites an existing file", async () => {
    await saveBinaryFile(root, "over.txt", Readable.from(["first"]));
    await saveBinaryFile(root, "over.txt", Readable.from(["second"]));
    expect(await readFile(join(root, "over.txt"), "utf8")).toBe("second");
  });

  it("refuses to escape the root, writing nothing", async () => {
    await expect(
      saveBinaryFile(root, "../outside/secret.txt", Readable.from(["pwned"])),
    ).rejects.toThrow(/outside/i);
    await expect(
      saveBinaryFile(root, join(outside, "secret.txt"), Readable.from(["pwned"])),
    ).rejects.toThrow(/outside/i);
    // The escape must not have touched the real file.
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("classified");
  });

  it("leaves the previous file intact when the stream fails mid-write", async () => {
    await saveBinaryFile(root, "keep.txt", Readable.from(["original"]));
    const failing = new Readable({
      read() {
        this.push("partial");
        this.destroy(new Error("connection lost"));
      },
    });
    await expect(saveBinaryFile(root, "keep.txt", failing)).rejects.toThrow(
      /connection lost/,
    );
    expect(await readFile(join(root, "keep.txt"), "utf8")).toBe("original");
    // And no temp file was left behind.
    const leftover = (await readdir(root)).filter((f) => f.includes(".upload-"));
    expect(leftover).toEqual([]);
  });

  it("rejects a NUL byte in the path", async () => {
    await expect(
      saveBinaryFile(root, "bad\0name.txt", Readable.from(["x"])),
    ).rejects.toThrow(/invalid path/i);
  });
});

describe("ensureTextFile", () => {
  it("creates a missing file with its parent dirs, empty", async () => {
    expect(await ensureTextFile(root, "docs/new/plan.md")).toBe(true);
    expect(await readFile(join(root, "docs/new/plan.md"), "utf8")).toBe("");
  });

  it("leaves an existing file untouched", async () => {
    expect(await ensureTextFile(root, "hello.txt")).toBe(false);
    expect(await readFile(join(root, "hello.txt"), "utf8")).toBe("hi");
  });

  it("refuses directories and escapes", async () => {
    await mkdir(join(root, "adir"), { recursive: true });
    await expect(ensureTextFile(root, "adir")).rejects.toThrow(/directory/);
    await expect(ensureTextFile(root, "")).rejects.toThrow();
    await expect(ensureTextFile(root, "../outside/x.md")).rejects.toThrow(/outside/);
    await expect(ensureTextFile(root, join(outside, "y.md"))).rejects.toThrow(/outside/);
    expect(await readdir(outside)).toEqual(["secret.txt"]);
  });
});
