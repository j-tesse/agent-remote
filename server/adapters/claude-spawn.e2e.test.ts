// Live e2e for the session host tools (server/sessionTools.ts) over claude-local:
// Claude calls `spawn_session` through the in-process MCP server, and a real
// top-level chat session appears in the manager, carrying `spawnedBy` and the
// caller's assistant checklist. Hard gate: our plumbing (tool exposed, session
// spawned + prompted, settings inherited). Soft gate: the model relays the
// child's reply via `wait_session`. Zero tokens; self-skips without the endpoint.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { loadConfig } from "../config.js";
import { buildAdapters } from "./registry.js";
import { SessionManager } from "../sessions/manager.js";
import { attachAssistant } from "../assistant.js";
import { attachSessionTools } from "../sessionTools.js";
import { ALLOW_EVERYTHING, deriveAssistantEnabled } from "../../shared/chat.js";
import { normalizeFolder } from "../paths.js";
import type { AssistantSettings, ChatPart, SessionInfo } from "../../shared/protocol.js";
import { endpointUp, settle } from "./claude-local.testkit.js";

const config = (() => {
  try {
    return loadConfig();
  } catch {
    return null;
  }
})();
const enabled = !!config?.harnesses.claudeLocal?.enabled;
const up = await endpointUp(config?.harnesses.claudeLocal?.env?.ANTHROPIC_BASE_URL);

const DIR = normalizeFolder(mkdtempSync(join(tmpdir(), "agent-remote-spawn-e2e-")));

function allowAll(): AssistantSettings {
  const s: AssistantSettings = {
    enabled: false,
    permissions: { enabled: true, instructions: ALLOW_EVERYTHING, delayScale: 0 },
    questions: { enabled: false, instructions: "", onlyIfSure: true },
    autoPr: { enabled: false, instructions: "", autoMerge: false },
    continuity: { enabled: false, instructions: "", newSession: "never" },
  };
  return { ...s, enabled: deriveAssistantEnabled(s) };
}

async function until(pred: () => boolean, ms: number, what: string) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await settle(250);
  }
}

describe.skipIf(!config || !enabled || !up)("claude-local: spawn_session host tool", () => {
  it("spawns a top-level session that inherits the assistant settings", async () => {
    const manager = new SessionManager(buildAdapters(config!));
    attachAssistant(manager);
    attachSessionTools(manager, () => [DIR]);

    const started: SessionInfo[] = [];
    manager.subscribe({
      onStarted: (info) => void started.push(info),
      onOutput() {},
      onExit() {},
    });

    const parent = manager.start("claude-local", { cwd: DIR });
    manager.chatAction(parent.id, { type: "set-assistant", settings: allowAll() });
    manager.chatAction(parent.id, {
      type: "prompt",
      text:
        'Call the mcp__agent-remote__spawn_session tool with harness "claude-local" and prompt "Reply with exactly the word PONG and nothing else.". ' +
        "Then call mcp__agent-remote__wait_session with the returned spawnedSession id, and tell me the reply it reports.",
    });

    try {
      await until(() => started.some((s) => s.spawnedBy === parent.id), 180_000, "spawn");
      const child = started.find((s) => s.spawnedBy === parent.id)!;
      // Top-level: provenance only, no nesting.
      expect(child.parentId).toBeUndefined();
      expect(child.folder).toBe(DIR);
      expect(child.harnessId).toBe("claude-local");
      // Inherited checklist (blanket accept) before its first prompt.
      expect(manager.chatState(child.id)?.assistant.permissions.instructions).toBe(
        ALLOW_EVERYTHING,
      );
      await until(
        () => !!manager.chatState(child.id)?.messages.some((m) => m.role === "user"),
        10_000,
        "child prompt",
      );

      // The parent's tool part carries the id the UI keys its inline panel off.
      await until(
        () => !manager.chatState(parent.id)?.busy && manager.chatState(parent.id)!.messages.length > 1,
        300_000,
        "parent turn",
      );
      const tools = manager
        .chatState(parent.id)!
        .messages.flatMap((m) => m.parts)
        .filter((p): p is Extract<ChatPart, { type: "tool" }> => p.type === "tool");
      const spawn = tools.find((t) => t.name.endsWith("spawn_session"));
      expect(spawn?.output).toContain(child.id);

      // Soft: the model relayed the child's answer.
      const waited = tools.some((t) => t.name.endsWith("wait_session"));
      if (!waited) console.warn("[spawn e2e] model never called wait_session");
    } finally {
      for (const s of manager.list()) manager.remove(s.id);
    }
  }, 360_000);
});
