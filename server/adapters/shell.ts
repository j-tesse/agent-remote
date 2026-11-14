import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessConfig } from "../config.js";
import type {
  HarnessAdapter,
  HarnessInvocation,
  SessionEventParser,
  SessionOptions,
} from "./types.js";
import type { SessionEvent } from "../../shared/protocol.js";

// Adapter for a plain interactive shell — the "Terminal" option.
// For instrumentable shells (zsh/bash) we inject a startup script that emits VS
// Code OSC 633 markers from the prompt hooks (the user's rc still loads), and a
// parser that turns those markers into session events (command-start/end + cwd).
// All confined here — the session layer stays harness-agnostic.

const INTEGRATION_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "shell-integration",
);

type Shell = "zsh" | "bash" | "other";

function detectShell(command: string): Shell {
  const base = basename(command);
  if (base === "zsh") return "zsh";
  if (base === "bash") return "bash";
  return "other";
}

export function createShellAdapter(cfg: HarnessConfig): HarnessAdapter {
  const shell = detectShell(cfg.command);

  const adapter: HarnessAdapter = {
    id: "terminal",
    name: "Terminal",
    invocation(_opts: SessionOptions): HarnessInvocation {
      if (shell === "zsh") {
        return {
          command: cfg.command,
          args: [],
          env: {
            // Hijack ZDOTDIR to run our .zshrc; keep the user's real dir so it
            // can hand back and source the user's config.
            ZDOTDIR: join(INTEGRATION_DIR, "zdotdir"),
            USER_ZDOTDIR: process.env.ZDOTDIR ?? process.env.HOME ?? "",
          },
        };
      }
      if (shell === "bash") {
        return {
          command: cfg.command,
          args: ["--rcfile", join(INTEGRATION_DIR, "bash-rc.sh"), "-i"],
        };
      }
      // Unknown shell: launch as-is, no instrumentation.
      return { command: cfg.command, args: [] };
    },
  };

  // Only instrument shells we inject integration for.
  if (shell !== "other") {
    adapter.createEventParser = () => new ShellEventParser();
  }
  return adapter;
}

// --- OSC 633 parsing -------------------------------------------------------

const OSC_PREFIX = "\x1b]633;";

// Reverse the integration scripts' escaping of OSC 633;E command lines. `\\`
// first in the alternation disambiguates an escaped backslash followed by
// literal `x3b`/`x0a`/`x0d` text.
function unescapeCommand(s: string): string {
  return s.replace(/\\(\\|x3b|x0a|x0d)/g, (_, t: string) =>
    t === "\\" ? "\\" : t === "x3b" ? ";" : t === "x0a" ? "\n" : "\r",
  );
}

// Longest suffix of `tail` that is a (proper or full) prefix of `prefix` — i.e.
// how many trailing chars might be the start of a marker split across chunks.
function partialPrefixLen(tail: string, prefix: string): number {
  const max = Math.min(tail.length, prefix.length);
  for (let n = max; n > 0; n--) {
    if (tail.slice(tail.length - n) === prefix.slice(0, n)) return n;
  }
  return 0;
}

export class ShellEventParser implements SessionEventParser {
  private buf = "";
  private pendingCommand: string | undefined;

  push(chunk: string): { output: string; events: SessionEvent[] } {
    this.buf += chunk;
    const events: SessionEvent[] = [];
    let output = "";
    let i = 0;

    for (;;) {
      const start = this.buf.indexOf(OSC_PREFIX, i);
      if (start === -1) break;
      output += this.buf.slice(i, start);

      const term = this.findTerminator(start + OSC_PREFIX.length);
      if (term.end === -1) {
        // Marker not yet complete — keep it (and everything after) for next push.
        this.buf = this.buf.slice(start);
        return { output, events };
      }
      this.handle(this.buf.slice(start + OSC_PREFIX.length, term.end), events);
      i = term.end + term.len;
    }

    // No more complete markers. The tail might still be the start of one, so
    // hold back any partial prefix rather than flushing it to the terminal.
    const tail = this.buf.slice(i);
    const hold = partialPrefixLen(tail, OSC_PREFIX);
    output += tail.slice(0, tail.length - hold);
    this.buf = tail.slice(tail.length - hold);
    return { output, events };
  }

  // Find the terminator (BEL, or ST = ESC \) for a marker whose payload starts
  // at `from`. Our scripts use BEL; ST is tolerated for robustness.
  private findTerminator(from: number): { end: number; len: number } {
    const bel = this.buf.indexOf("\x07", from);
    const st = this.buf.indexOf("\x1b\\", from);
    if (bel !== -1 && (st === -1 || bel < st)) return { end: bel, len: 1 };
    if (st !== -1) return { end: st, len: 2 };
    return { end: -1, len: 0 };
  }

  private handle(payload: string, events: SessionEvent[]): void {
    const semi = payload.indexOf(";");
    const kind = semi === -1 ? payload : payload.slice(0, semi);
    const rest = semi === -1 ? "" : payload.slice(semi + 1);
    switch (kind) {
      case "E":
        this.pendingCommand = unescapeCommand(rest);
        break;
      case "C":
        if (this.pendingCommand !== undefined) {
          events.push({
            type: "command-start",
            command: this.pendingCommand,
            at: Date.now(),
          });
          this.pendingCommand = undefined;
        }
        break;
      case "D": {
        const code = Number.parseInt(rest, 10);
        events.push({
          type: "command-end",
          exitCode: Number.isNaN(code) ? 0 : code,
          at: Date.now(),
        });
        break;
      }
      case "S":
        events.push({ type: "sudo-prompt", id: "", retry: false, at: Date.now() });
        break;
      case "P":
        if (rest.startsWith("Cwd="))
          events.push({ type: "cwd", cwd: rest.slice(4), at: Date.now() });
        break;
    }
  }
}
