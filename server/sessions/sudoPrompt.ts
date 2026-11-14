import type { SudoPrompt } from "../../shared/protocol.js";

// When a terminal's sudo prompt is still fillable. A stale fill would type the
// password into the shell (echoed + into history), so anything that might mean
// sudo stopped waiting clears it.
export class SudoPromptTracker {
  pending: SudoPrompt | null = null;
  // A fill already happened this command → the next prompt means it was rejected.
  private filled = false;

  /** Marker seen. `running`: a command is executing (a bare shell prompt can't be sudo). */
  prompt(id: string, running: boolean): SudoPrompt | null {
    if (!running) return null;
    this.pending = { id, retry: this.filled };
    return this.pending;
  }

  /** Visible output after the prompt (the marker is the prompt's last byte). */
  output(text: string): string | null {
    return /\S/.test(text) ? this.clear() : null;
  }

  /** The user typed into the PTY themselves. */
  input(): string | null {
    return this.clear();
  }

  /** Command boundary (start or end). */
  boundary(): string | null {
    this.filled = false;
    return this.clear();
  }

  /** Consume the prompt for a fill; false if it's gone or superseded. */
  fill(id: string): boolean {
    if (this.pending?.id !== id) return false;
    this.pending = null;
    this.filled = true;
    return true;
  }

  private clear(): string | null {
    const id = this.pending?.id ?? null;
    this.pending = null;
    return id;
  }
}
