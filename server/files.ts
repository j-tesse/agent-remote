// File-editor backend: browse subfolders and read/write files under a folder
// root. Deliberately narrow — it is NOT a general filesystem browser. Callers
// (index.ts) must first confirm `root` is a known folder; every path is then
// confined to that root here, so a request can never escape it via `..` or an
// absolute path.

import {
  readdir,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  mkdir,
  rename,
  unlink,
  stat,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve, relative, dirname, sep } from "node:path";
import type { DirListing, FileContent, FileEntry } from "../shared/protocol.js";

// Refuse to read files larger than this (they aren't editable in a browser text
// field anyway) so we never buffer something huge into memory.
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Resolve `rel` under `root`, guaranteeing the result stays inside `root`.
 * Throws on any attempt to escape (via `..`, an absolute path, etc.). */
function resolveWithin(root: string, rel: string): string {
  if (rel.includes("\0")) throw new Error("Invalid path.");
  const rootAbs = resolve(root);
  const target = resolve(rootAbs, rel);
  const rootWithSep = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep;
  if (target !== rootAbs && !target.startsWith(rootWithSep)) {
    throw new Error("Path is outside the folder.");
  }
  return target;
}

/** List the entries of a subdirectory under `root`. Directories first, then
 * files, each sorted case-insensitively. Hidden entries are included. */
export async function listDir(root: string, rel: string): Promise<DirListing> {
  const dir = resolveWithin(root, rel);
  const dirents = await readdir(dir, { withFileTypes: true });
  const entries: FileEntry[] = dirents
    .filter((d) => d.isFile() || d.isDirectory())
    .map((d) => ({
      name: d.name,
      // Relative to the root, POSIX-style, so the client can pass it straight
      // back on the next request.
      path: relative(resolve(root), join(dir, d.name)).split(sep).join("/"),
      type: d.isDirectory() ? ("dir" as const) : ("file" as const),
    }))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
  return { path: rel.split(sep).join("/"), entries };
}

/** Read a text file under `root`. Refuses directories, oversized files, and
 * binary files (a NUL byte in the content). */
export async function readTextFile(root: string, rel: string): Promise<FileContent> {
  const file = resolveWithin(root, rel);
  const info = await stat(file);
  if (info.isDirectory()) throw new Error("Path is a directory.");
  if (info.size > MAX_FILE_BYTES) throw new Error("File is too large to edit.");
  const buf = await fsReadFile(file);
  if (buf.includes(0)) throw new Error("File appears to be binary.");
  return { path: rel.split(sep).join("/"), content: buf.toString("utf8") };
}

/** Write (create or overwrite) a text file under `root`. */
export async function writeTextFile(
  root: string,
  rel: string,
  content: string,
): Promise<void> {
  const file = resolveWithin(root, rel);
  await fsWriteFile(file, content, "utf8");
}

/** Make sure a text file exists under `root` (co-create's Create flow): creates
 * parent dirs + an empty file if missing, never touches an existing one.
 * Returns whether it was created. */
export async function ensureTextFile(root: string, rel: string): Promise<boolean> {
  const file = resolveWithin(root, rel);
  if (file === resolve(root)) throw new Error("Path is the folder itself.");
  try {
    if ((await stat(file)).isDirectory()) throw new Error("Path is a directory.");
    return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await mkdir(dirname(file), { recursive: true });
  try {
    await fsWriteFile(file, "", { flag: "wx" });
    return true;
  } catch (err) {
    // Lost a race to another creator: it exists now, which is all we wanted.
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

// --- transfer (upload/download) ------------------------------------------
// These deliberately skip readTextFile's binary/size refusals: those are
// *editor* constraints (a browser text field), not filesystem ones. Transfer
// is streamed both ways so a large artifact never lands in memory.

/** Stat an entry under `root`, or null if it doesn't exist. */
export async function statEntry(
  root: string,
  rel: string,
): Promise<{ size: number; isDir: boolean } | null> {
  const target = resolveWithin(root, rel);
  try {
    const info = await stat(target);
    return { size: info.size, isDir: info.isDirectory() };
  } catch {
    return null;
  }
}

export interface ByteRange {
  start: number;
  end: number;
}

/** Parse a `Range: bytes=…` header against a known size. null = serve the whole
 * file (absent or multi-range — a 200 is a legal answer to those); the literal
 * "unsatisfiable" = answer 416. */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | null | "unsatisfiable" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, from, to] = m;
  if (size === 0) return "unsatisfiable";
  let start: number;
  let end: number;
  if (from === "") {
    // Suffix form: the last N bytes.
    const n = Number(to);
    if (!n) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(from);
    end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

/** Open a file under `root` for download. Returns its byte size, base name and
 * a read stream. Throws if missing or a directory. With `range`, the stream is
 * sliced but `size` stays the FULL size (callers need it for content-range). */
export async function openDownload(
  root: string,
  rel: string,
  range?: ByteRange,
): Promise<{ size: number; name: string; stream: ReturnType<typeof createReadStream> }> {
  const file = resolveWithin(root, rel);
  const info = await stat(file).catch(() => {
    throw new Error("File not found.");
  });
  if (info.isDirectory()) throw new Error("Path is a directory.");
  const name = rel.split("/").filter(Boolean).pop() ?? "download";
  return { size: info.size, name, stream: createReadStream(file, range) };
}

/** Stream `body` into a file under `root`, creating parent directories. The
 * path is confined before a single byte is written. Writes to a sibling temp
 * file and renames, so a dropped connection (a phone on mobile data) leaves the
 * previous file intact rather than a truncated one. */
export async function saveBinaryFile(
  root: string,
  rel: string,
  body: NodeJS.ReadableStream,
): Promise<void> {
  const file = resolveWithin(root, rel);
  await mkdir(dirname(file), { recursive: true });
  // Same directory, so the rename stays within one filesystem (i.e. atomic).
  const tmp = `${file}.upload-${randomUUID().slice(0, 8)}`;
  try {
    await new Promise<void>((res, rej) => {
      const out = createWriteStream(tmp);
      body.pipe(out);
      out.on("finish", () => res());
      out.on("error", rej);
      body.on("error", rej);
    });
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
