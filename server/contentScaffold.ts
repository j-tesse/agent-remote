// Co-create Create flow per media type: the content file, plus whatever a type
// ships beside it (learn → a copy of learnkit, so the page stays standalone).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONTENT_TYPES, learnKitDir, type ContentPointer } from "../shared/content.js";
import { ensureTextFile } from "./files.js";

const KIT_SRC = fileURLToPath(new URL("../shared/learnkit/", import.meta.url));
const KIT_FILES = ["kit.css", "kit.js", "README.md"];

const kitFile = (name: string) => readFileSync(KIT_SRC + name, "utf8");

/** Create the pointer's file (and companions) if missing; never overwrites —
 * an existing page, or an older kit copy it was written against, is kept. */
export async function scaffoldContent(root: string, pointer: ContentPointer): Promise<void> {
  if (CONTENT_TYPES[pointer.mediaType].pointer !== "file") return;
  if (pointer.mediaType !== "learn") {
    await ensureTextFile(root, pointer.path);
    return;
  }
  await ensureTextFile(root, pointer.path, kitFile("template.html"));
  const dir = learnKitDir(pointer.path);
  for (const name of KIT_FILES) await ensureTextFile(root, `${dir}/${name}`, kitFile(name));
}
