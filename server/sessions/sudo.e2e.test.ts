// Sudo-prompt detection + fill through a real bash PTY and the production
// manager. A fake `sudo` on PATH prints $SUDO_PROMPT (our marker included) and
// reads a line — no root, no endpoint, no tokens.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./manager.js";
import { createShellAdapter } from "../adapters/shell.js";
import type { SessionEvent } from "../../shared/protocol.js";

const FAKE_SUDO = `#!/bin/bash
for try in 1 2; do
  printf '%s' "\${SUDO_PROMPT//%p/$USER}"
  IFS= read -rs pw; echo
  [ "$pw" = right ] && { echo GRANTED; exit 0; }
  echo "Sorry, try again."
done
exit 1
`;

let dir = "";
const saved = { HOME: process.env.HOME, PATH: process.env.PATH };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sudo-e2e-"));
  writeFileSync(join(dir, "sudo"), FAKE_SUDO);
  chmodSync(join(dir, "sudo"), 0o755);
  // Isolated HOME: no user .bashrc noise; fake sudo first on PATH.
  process.env.HOME = dir;
  process.env.PATH = `${dir}:${process.env.PATH}`;
});
afterAll(() => {
  Object.assign(process.env, saved);
  rmSync(dir, { recursive: true, force: true });
});

function shell(command = "/bin/bash") {
  const manager = new SessionManager(
    new Map([["terminal", createShellAdapter({ enabled: true, command })]]),
  );
  const events: SessionEvent[] = [];
  let out = "";
  const waiters: (() => void)[] = [];
  const poke = () => waiters.splice(0).forEach((w) => w());
  manager.subscribe({
    onStarted() {},
    onOutput(_id, data) {
      out += data;
      poke();
    },
    onExit() {},
    onEvent(_id, e) {
      events.push(e);
      poke();
    },
  });
  const id = manager.start("terminal", { cwd: dir }).id;
  const until = (pred: () => boolean, ms = 5000) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout; output:\n${out}`)), ms);
      const check = () => (pred() ? (clearTimeout(t), resolve()) : waiters.push(check));
      check();
    });
  const prompts = () =>
    events.filter((e): e is Extract<SessionEvent, { type: "sudo-prompt" }> => e.type === "sudo-prompt");
  return { manager, id, events, prompts, until, output: () => out };
}

describe("sudo prompt fill", () => {
  const shells = ["/bin/bash", ...(existsSync("/usr/bin/zsh") ? ["/usr/bin/zsh"] : [])];
  it.each(shells)("detects the prompt, hides the marker and fills it (%s)", async (sh) => {
    const s = shell(sh);
    await s.until(() => s.events.some((e) => e.type === "cwd"));
    s.manager.input(s.id, "sudo true\r");
    await s.until(() => s.prompts().length === 1);
    const p = s.prompts()[0];
    expect(p.retry).toBe(false);
    expect(s.manager.sessionInfo(s.id)?.sudoPrompt?.id).toBe(p.id);
    expect(s.output()).toContain("password for");
    expect(s.output()).not.toContain("633;S");
    expect(s.manager.fillSudo(s.id, p.id, "right")).toBe(true);
    await s.until(() => s.output().includes("GRANTED"));
    expect(s.output()).not.toContain("right");
    expect(s.manager.sessionInfo(s.id)?.sudoPrompt).toBeUndefined();
    s.manager.stop(s.id);
  });

  it("flags a rejected fill and refuses stale prompts", async () => {
    const s = shell();
    await s.until(() => s.events.some((e) => e.type === "cwd"));
    s.manager.input(s.id, "sudo true\r");
    await s.until(() => s.prompts().length === 1);
    s.manager.fillSudo(s.id, s.prompts()[0].id, "wrong");
    await s.until(() => s.prompts().length === 2);
    const retry = s.prompts()[1];
    expect(retry.retry).toBe(true);
    // Typing yourself takes over: the prompt is no longer fillable.
    s.manager.input(s.id, "x");
    expect(s.manager.fillSudo(s.id, retry.id, "right")).toBe(false);
    s.manager.input(s.id, "\r");
    await s.until(() => s.events.some((e) => e.type === "command-end"));
    expect(s.manager.sessionInfo(s.id)?.sudoPrompt).toBeUndefined();
    s.manager.stop(s.id);
  });

  it("ignores the marker when no command is running", async () => {
    const s = shell();
    await s.until(() => s.events.some((e) => e.type === "cwd"));
    // Printed by the prompt hook itself, i.e. outside any command.
    s.manager.input(s.id, `PROMPT_COMMAND="$PROMPT_COMMAND; printf '\\\\033]633;S\\\\007'"\r`);
    await s.until(() => s.events.filter((e) => e.type === "command-end").length >= 2);
    expect(s.prompts()).toEqual([]);
    s.manager.stop(s.id);
  });
});
