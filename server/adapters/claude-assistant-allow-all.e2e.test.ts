// Live end-to-end test of BLANKET-ACCEPT assistant mode (the "allow everything"
// sentinel instructions) over claude-local, driven through the real
// SessionManager. Sibling of claude-assistant.e2e.test.ts, which covers the LLM
// decider; this one covers the path that deliberately SKIPS the LLM.
//
// The proof is structural, not incidental: this file never calls
// `startLlmPolling`, so `llmStatus().available` is false for the whole run. On
// the normal path the decider bails out immediately on that gate and no card is
// ever answered — so a card that IS auto-accepted here can only have come from
// the bypass. The test's own listener never answers anything (headless, as in
// the sibling test).
//
// Zero Claude tokens (claude-local → local vLLM), but a real model call: run via
// `npm run test:e2e`; self-skips unless claude-local is enabled and up.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { loadConfig } from "../config.js";
import { buildAdapters } from "./registry.js";
import { SessionManager } from "../sessions/manager.js";
import { attachAssistant } from "../assistant.js";
import { llmStatus } from "../llm.js";
import { ALLOW_EVERYTHING } from "../../shared/chat.js";
import type { ChatEvent } from "../../shared/protocol.js";
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

const DIR = mkdtempSync(join(tmpdir(), "agent-remote-allow-all-e2e-"));

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error(message)), ms);
      t.unref();
    }),
  ]);
}

describe.skipIf(!config || !enabled || !up)(
  'claude-local: assistant mode with "allow everything"',
  () => {
    it("auto-accepts a permission card without consulting the LLM", async () => {
      // The gate the normal decider path would fail on (see header).
      expect(
        llmStatus().available,
        "LLM polling must stay off for this test to prove the bypass",
      ).toBe(false);

      const manager = new SessionManager(buildAdapters(config!));
      const detach = attachAssistant(manager);

      const events: ChatEvent[] = [];
      let sessionId = "";
      let resolveTurn: (() => void) | null = null;

      const unsub = manager.subscribe({
        onStarted() {},
        onOutput() {},
        onExit(id) {
          if (id === sessionId) resolveTurn?.();
        },
        onChatEvent(id, event) {
          if (id !== sessionId) return;
          events.push(event);
          // Deliberately DO NOT answer ui-requests — the backend must do it.
          if (event.type === "busy" && event.busy === false) resolveTurn?.();
        },
      });

      sessionId = manager.start("claude-local", { cwd: DIR }).id;
      manager.chatAction(sessionId, {
        type: "set-assistant",
        settings: {
          enabled: true,
          permissions: { enabled: true, instructions: ALLOW_EVERYTHING },
          questions: { enabled: false, instructions: "", onlyIfSure: false },
          autoPr: { enabled: false, instructions: "", autoMerge: false },
          continuity: { enabled: false, instructions: "", newSession: "never" },
        },
      });

      const turn = new Promise<void>((r) => {
        resolveTurn = r;
      });
      // `touch` prompts for permission; safe commands (e.g. `echo`) are
      // auto-allowed by the CLI and never reach canUseTool.
      manager.chatAction(sessionId, {
        type: "prompt",
        text:
          "Use the Bash tool to run exactly `touch notes.txt` in the current " +
          "directory. Do nothing else.",
      });
      await withTimeout(turn, 110_000, "turn did not complete in time");
      // Let a trailing ui-request-done / decision settle into the log.
      await settle(200);
      manager.stop(sessionId);
      unsub();
      detach();

      // (a) A permission card was raised.
      const req = events.find(
        (e): e is Extract<ChatEvent, { type: "ui-request" }> =>
          e.type === "ui-request" &&
          (e.request.kind === "select" || e.request.kind === "confirm"),
      );
      expect(req, "no permission card was raised").toBeDefined();
      const reqId = req!.request.id;

      // (b) The backend broadcast an accepting verdict with a grace window —
      // same shape the LLM path produces, so the UI countdown is identical.
      const decision = events.find(
        (e): e is Extract<ChatEvent, { type: "assistant-decision" }> =>
          e.type === "assistant-decision" && e.decision.requestId === reqId,
      );
      expect(decision, "backend never broadcast an assistant-decision").toBeDefined();
      expect(["accept", "confirm"]).toContain(decision!.decision.action);
      expect(decision!.decision.delayMs).toBeGreaterThan(0);

      // (c) The backend APPLIED it though our listener never answered, and with
      // no LLM available — i.e. purely via the blanket-accept bypass.
      const done = events.find(
        (e): e is Extract<ChatEvent, { type: "ui-request-done" }> =>
          e.type === "ui-request-done" && e.requestId === reqId,
      );
      expect(done, "the card was never resolved by the backend").toBeDefined();

      // (d) It's still auditable in the transcript, and the trace says plainly
      // that no model was asked.
      const trace = events.find(
        (e): e is Extract<ChatEvent, { type: "assistant-trace" }> =>
          e.type === "assistant-trace" && e.trace.requestId === reqId,
      );
      expect(trace, "backend never emitted an assistant-trace").toBeDefined();
      expect(trace!.trace.outcome).toBe("allow");
      expect(trace!.trace.prompt).toContain("No LLM was consulted");
      expect(trace!.trace.summary).toContain("Allowed");

      // (e) The trace names the gated tool call, so the UI can put the verdict
      // on that tool's row instead of a line of its own.
      const toolIds = events.flatMap((e) =>
        e.type === "tool-call" ? [e.toolId] : [],
      );
      expect(trace!.trace.toolId, "trace carries no toolId").toBeDefined();
      expect(toolIds).toContain(trace!.trace.toolId);
    }, 180_000);
  },
);
