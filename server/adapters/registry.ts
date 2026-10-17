import type { Config } from "../config.js";
import type { HarnessAdapter } from "./types.js";
import { createClaudeAdapter } from "./claude.js";
import { createPiAdapter } from "./pi.js";
import { createAcpAdapter } from "./acp.js";
import { createShellAdapter } from "./shell.js";

// Builds the set of adapters the backend will expose, based on which harnesses
// are enabled in config.json. New harnesses are wired in here.
export function buildAdapters(config: Config): Map<string, HarnessAdapter> {
  const adapters = new Map<string, HarnessAdapter>();

  if (config.harnesses.claude?.enabled) {
    const adapter = createClaudeAdapter(config.harnesses.claude);
    adapters.set(adapter.id, adapter);
  }
  if (config.harnesses.claudeLocal?.enabled) {
    // Same Claude adapter, pointed at a local endpoint via its `env` (vLLM), for
    // token-free end-to-end testing of the chat UI.
    const adapter = createClaudeAdapter(config.harnesses.claudeLocal, {
      id: "claude-local",
      name: "Local Claude",
    });
    adapters.set(adapter.id, adapter);
  }
  if (config.harnesses.pi?.enabled) {
    const adapter = createPiAdapter(config.harnesses.pi);
    adapters.set(adapter.id, adapter);
  }
  for (const [id, cfg] of Object.entries(config.harnesses.acp ?? {})) {
    // Built-in ids win: an ACP entry can't shadow claude/pi/terminal.
    if (!cfg?.enabled || adapters.has(id) || ["claude", "claude-local", "pi", "terminal"].includes(id)) continue;
    adapters.set(id, createAcpAdapter(cfg, { id, name: cfg.name ?? id }));
  }
  if (config.harnesses.terminal?.enabled) {
    const adapter = createShellAdapter(config.harnesses.terminal);
    adapters.set(adapter.id, adapter);
  }

  return adapters;
}
