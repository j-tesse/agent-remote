import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { seal, unseal } from "./secrets.js";

describe("seal/unseal", () => {
  const key = randomBytes(32);

  it("round-trips, with a fresh nonce each time", () => {
    const a = seal("hünter2 ;:", key);
    expect(unseal(a, key)).toBe("hünter2 ;:");
    expect(seal("hünter2 ;:", key)).not.toBe(a);
    expect(a).not.toContain("hunter");
  });

  it("rejects a wrong key, tampering and junk", () => {
    const s = seal("secret", key);
    expect(unseal(s, randomBytes(32))).toBeNull();
    const [v, iv, tag, ct] = s.split(":");
    const flipped = Buffer.from(ct, "base64");
    flipped[0] ^= 1;
    expect(unseal([v, iv, tag, flipped.toString("base64")].join(":"), key)).toBeNull();
    expect(unseal("v2:" + s.slice(3), key)).toBeNull();
    expect(unseal("garbage", key)).toBeNull();
  });
});
