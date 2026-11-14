import {
  deleteSudoPassword,
  getSealedSudoPassword,
  setSealedSudoPassword,
} from "./db.js";
import { secretKey, seal, unseal } from "./secrets.js";

// Per-user stored sudo password. Write-only from the browser's side: the API
// reports only whether one is set; plaintext leaves this module solely to be
// typed into a PTY by `manager.fillSudo`.

const MAX_LEN = 1024;

/** Validation error text, or null if usable. A newline would submit early. */
export function sudoPasswordError(value: unknown): string | null {
  if (typeof value !== "string" || !value) return "Password is required.";
  if (value.length > MAX_LEN) return "Password is too long.";
  if (/[\r\n]/.test(value)) return "Password can't contain a newline.";
  return null;
}

export function hasSudoPassword(user: string): boolean {
  return getSealedSudoPassword(user) !== null;
}

export function storeSudoPassword(user: string, password: string): void {
  setSealedSudoPassword(user, seal(password, secretKey()));
}

export function clearSudoPassword(user: string): void {
  deleteSudoPassword(user);
}

/** Plaintext, or null if unset or unreadable (e.g. key file replaced). */
export function loadSudoPassword(user: string): string | null {
  const sealed = getSealedSudoPassword(user);
  return sealed ? unseal(sealed, secretKey()) : null;
}
