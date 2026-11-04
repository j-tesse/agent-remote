// Live co-create contract, over claude-local AND pi through the real manager:
// the pointer reaches the agent via the system-prompt append (the prompt never
// names the file), the agent edits it, and the content watcher notifies + snapshots.
// Zero tokens (local vLLM); self-skips per harness when disabled/unreachable.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";
import { buildAdapters } from "./adapters/registry.js";
import { SessionManager } from "./sessions/manager.js";
import { attachContentWatch } from "./content.js";
import { endpointUp as claudeUp } from "./adapters/claude-local.testkit.js";
import { endpointUp as piUp } from "./adapters/pi-local.testkit.js";
import { normalizeFolder } from "./paths.js";

const config = (() => {
  try {
    return loadConfig();
  } catch {
    return null;
  }
})();

const cases = [
  {
    harness: "claude-local",
    on:
      !!config?.harnesses.claudeLocal?.enabled &&
      (await claudeUp(config?.harnesses.claudeLocal?.env?.ANTHROPIC_BASE_URL)),
  },
  {
    harness: "pi",
    on: !!config?.harnesses.pi?.enabled && (await piUp(config?.llm?.baseUrl)),
  },
];

const INITIAL = "# Trip plan\n\nA weekend in the mountains.\n";
const DECOY = "# Trip plan\n\nThe document for this project.\n";
const TARGET = "drafts/x7.md";

function waitUntil(ok: () => boolean, ms: number, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const t = setInterval(() => {
      if (ok()) {
        clearInterval(t);
        resolve();
      } else if (Date.now() - started > ms) {
        clearInterval(t);
        reject(new Error(message));
      }
    }, 200);
  });
}

for (const { harness, on } of cases) {
  describe.skipIf(!config || !on)(`${harness}: co-create`, () => {
    it("edits the pointed-at file without being told its name", async () => {
      const dir = normalizeFolder(mkdtempSync(join(tmpdir(), "agent-remote-cocreate-e2e-")));
      const file = join(dir, TARGET);
      mkdirSync(join(dir, "drafts"));
      writeFileSync(file, INITIAL);
      // Decoy at the root, same title: without the framing, "the trip plan" most
      // likely means this one — the nondescript target is only named by the framing.
      const decoy = join(dir, "README.md");
      writeFileSync(decoy, DECOY);

      const manager = new SessionManager(buildAdapters(config!));
      const notified: string[] = [];
      const watch = attachContentWatch(manager, (id) => notified.push(id));
      let sessionId = "";
      let prompted = false;
      const unsub = manager.subscribe({
        onStarted() {},
        onOutput() {},
        onExit() {},
        onChatEvent(id, event) {
          if (id !== sessionId) return;
          if (event.type === "user-message") prompted = true;
          // Approve every card so the turn completes.
          if (event.type === "ui-request") {
            const opts = event.request.options ?? [];
            const pick = opts.find((o) => o.intent === "accept") ?? opts[0];
            manager.chatAction(id, {
              type: "ui-response",
              requestId: event.request.id,
              value: pick?.value ?? "yes",
            });
          }
        },
      });

      try {
        const info = manager.start(harness, {
          cwd: dir,
          content: { mediaType: "markdown", path: TARGET },
        });
        sessionId = info.id;
        expect(info.content).toEqual({ mediaType: "markdown", path: TARGET });

        manager.chatAction(sessionId, {
          type: "prompt",
          text: "Add a section titled Goals with two short bullet points to the trip plan.",
        });
        const text = () => readFileSync(file, "utf8");
        // Hard gate: the agent found and edited the file on its own.
        await waitUntil(
          () => prompted && /goals/i.test(text()) && manager.chatState(sessionId)?.busy === false,
          170_000,
          "the target was never edited",
        );
        expect(text()).toContain("Trip plan");
        expect(readFileSync(decoy, "utf8")).toBe(DECOY);
        await waitUntil(() => notified.includes(sessionId), 5_000, "no content notification");
        // The turn-start snapshot is the "before" of the turn's change.
        expect(watch.snapshots(sessionId).at(-1)?.text).toBe(INITIAL);

        // Soft gate: the reply summarizes rather than pasting the document.
        const last = manager.chatState(sessionId)!.messages.at(-1);
        const said = (last?.parts ?? [])
          .map((p) => (p.type === "text" ? p.text : ""))
          .join("");
        expect.soft(said).not.toContain("A weekend in the mountains.");
      } finally {
        manager.stop(sessionId);
        unsub();
        watch.detach();
      }
    }, 200_000);
  });
}
