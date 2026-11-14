import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// At-rest sealing for secrets the server must replay unattended (sudo password).
// Key file is separate from the DB, so a leaked DB/backup alone reveals nothing;
// anyone who can read data/secret.key (root, this Unix user) still can.

const KEY_PATH = resolve(process.cwd(), "data/secret.key");
const VERSION = "v1";

/** AES-256-GCM → `v1:<iv>:<tag>:<ciphertext>` (base64 fields). */
export function seal(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, ...[iv, tag, ct].map((b) => b.toString("base64"))].join(":");
}

/** Inverse of `seal`; null on any tamper/wrong key/malformed input. */
export function unseal(sealed: string, key: Buffer): string | null {
  const [v, iv, tag, ct] = sealed.split(":");
  if (v !== VERSION || !iv || !tag || ct === undefined) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

let cachedKey: Buffer | null = null;

/** The server's sealing key, created (0600) on first use. */
export function secretKey(): Buffer {
  if (cachedKey) return cachedKey;
  if (!existsSync(KEY_PATH)) {
    mkdirSync(dirname(KEY_PATH), { recursive: true });
    // `wx`: never clobber a key that appeared meanwhile (would orphan every secret).
    try {
      writeFileSync(KEY_PATH, randomBytes(32).toString("base64"), { flag: "wx", mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  chmodSync(KEY_PATH, 0o600);
  const key = Buffer.from(readFileSync(KEY_PATH, "utf8").trim(), "base64");
  if (key.length !== 32) throw new Error(`${KEY_PATH} is not a 32-byte key`);
  cachedKey = key;
  return key;
}
