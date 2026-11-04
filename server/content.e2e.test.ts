// Co-create watcher + snapshots over the real manager with a FAKE chat adapter:
// real fs.watch on a tmp dir, no harness/endpoint/tokens. e2e (not the pure gate)
// only because it relies on real filesystem notifications and timers.
import { describe, expect, it } from "vitest";
import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./sessions/manager.js";
import { attachContentWatch } from "./content.js";
import { normalizeFolder } from "./paths.js";
import type { ChatSession, HarnessAdapter, SessionOptions } from "./adapters/types.js";
import type { ChatEvent } from "../shared/protocol.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const dir = normalizeFolder(mkdtempSync(join(tmpdir(), "agent-remote-content-e2e-")));
  const file = join(dir, "doc.md");
  writeFileSync(file, "# v1\n");
  const seen: SessionOptions[] = [];
  let emit: ((e: ChatEvent) => void) | null = null;
  const adapter: HarnessAdapter = {
    id: "fake",
    name: "Fake",
    appendsSystemPrompt: true,
    invocation: () => ({ command: "true", args: [] }),
    createChatSession(opts): ChatSession {
      seen.push(opts);
      return {
        start: (h) => void (emit = h.onEvent),
        action(a) {
          if (a.type !== "prompt") return;
          emit?.({
            type: "user-message",
            message: { id: `u${Date.now()}`, role: "user", parts: [{ type: "text", text: a.text }], createdAt: Date.now() },
          });
        },
        close() {},
      };
    },
  };
  const plain: HarnessAdapter = { ...adapter, id: "plain", appendsSystemPrompt: false };
  const manager = new SessionManager(
    new Map([
      ["fake", adapter],
      ["plain", plain],
    ]),
  );
  const notes: Array<[string, string]> = [];
  const watch = attachContentWatch(manager, (id, v) => notes.push([id, v]));
  const info = manager.start("fake", {
    cwd: dir,
    content: { mediaType: "markdown", path: "doc.md" },
  });
  return { dir, file, seen, manager, notes, watch, id: info.id };
}

describe("co-create content watch", () => {
  it("frames the agent with the pointer", () => {
    const { seen, watch } = setup();
    expect(seen[0].appendSystemPrompt).toContain("`doc.md`");
    watch.detach();
  });

  it("notifies once per burst of writes, and survives an atomic replace", async () => {
    const { file, dir, notes, watch, id } = setup();
    writeFileSync(file, "# v2\n");
    writeFileSync(file, "# v2 more\n");
    await sleep(400);
    expect(notes.filter(([s]) => s === id)).toHaveLength(1);

    const tmp = join(dir, ".doc.md.tmp");
    writeFileSync(tmp, "# v3 replaced\n");
    renameSync(tmp, file);
    await sleep(400);
    expect(notes).toHaveLength(2);
    // Still watching after the inode swap.
    writeFileSync(file, "# v4\n");
    await sleep(400);
    expect(notes).toHaveLength(3);
    watch.detach();
  });

  it("snapshots the file at each turn start, skipping unchanged", async () => {
    const { file, manager, watch, id } = setup();
    manager.chatAction(id, { type: "prompt", text: "one" });
    manager.chatAction(id, { type: "prompt", text: "two" });
    writeFileSync(file, "# edited\n");
    manager.chatAction(id, { type: "prompt", text: "three" });
    expect(watch.snapshots(id).map((s) => s.text)).toEqual(["# v1\n", "# edited\n"]);
    watch.detach();
  });

  it("stops watching once the session is removed", async () => {
    const { file, manager, notes, watch, id } = setup();
    manager.remove(id);
    writeFileSync(file, "# after\n");
    await sleep(400);
    expect(notes).toHaveLength(0);
    expect(watch.snapshots(id)).toEqual([]);
    watch.detach();
  });

  it("refuses a co-create start on a harness that can't be framed", () => {
    const { manager, dir, watch } = setup();
    expect(() =>
      manager.start("plain", { cwd: dir, content: { mediaType: "markdown", path: "x.md" } }),
    ).toThrow(/co-create/);
    watch.detach();
  });
});
