import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decrypt,
  decryptBytes,
  encrypt,
  ENV_CURRENT,
  ENV_PREVIOUS,
  EnvelopeError,
  MAX_PLAINTEXT_BYTES,
  needsRewrap,
  rewrap,
  rowAad,
  validateEncryptionEnv,
} from "./envelope";

const newKey = () => randomBytes(32).toString("base64");
const aad = rowAad("bank_item", "row-1", "user-1");

let k1: string;
let k2: string;
const saved = { cur: process.env[ENV_CURRENT], prev: process.env[ENV_PREVIOUS] };

beforeEach(() => {
  k1 = newKey();
  k2 = newKey();
  process.env[ENV_CURRENT] = k1;
  delete process.env[ENV_PREVIOUS];
});
afterEach(() => {
  for (const [name, v] of [[ENV_CURRENT, saved.cur], [ENV_PREVIOUS, saved.prev]] as const) {
    if (v === undefined) delete process.env[name];
    else process.env[name] = v;
  }
});

/** Flips one character in the given dot-separated field of a blob. */
function tamper(blob: string, field: number): string {
  const parts = blob.split(".");
  const s = parts[field];
  parts[field] = (s[0] === "A" ? "B" : "A") + s.slice(1);
  return parts.join(".");
}

describe("round trip", () => {
  it("encrypts and decrypts text, with a fresh blob each time", () => {
    const a = encrypt("access-token-123", aad);
    const b = encrypt("access-token-123", aad);
    expect(a).not.toBe(b);
    expect(a).not.toContain("access-token-123");
    expect(decrypt(a, aad)).toBe("access-token-123");
    expect(decrypt(b, aad)).toBe("access-token-123");
  });

  it("handles unicode, bytes, empty and large values", () => {
    expect(decrypt(encrypt("héllo 🔐", aad), aad)).toBe("héllo 🔐");
    expect(decrypt(encrypt("", aad), aad)).toBe("");
    const bytes = randomBytes(5000);
    expect(decryptBytes(encrypt(bytes, aad), aad).equals(bytes)).toBe(true);
    const big = "x".repeat(MAX_PLAINTEXT_BYTES);
    expect(decrypt(encrypt(big, aad), aad)).toBe(big);
  });

  it("refuses values over the size cap", () => {
    expect(() => encrypt(Buffer.alloc(MAX_PLAINTEXT_BYTES + 1), aad)).toThrow(EnvelopeError);
  });

  it("uses a versioned, key-id-tagged format that doesn't contain the key", () => {
    const blob = encrypt("t", aad);
    const parts = blob.split(".");
    expect(parts).toHaveLength(8);
    expect(parts[0]).toBe("v1");
    expect(blob).not.toContain(k1);
    expect(parts[1]).toBe(validateEncryptionEnv().currentKeyId);
  });
});

describe("binding and tampering", () => {
  it("fails with the wrong AAD (another row, user or table)", () => {
    const blob = encrypt("secret", aad);
    for (const other of [
      rowAad("bank_item", "row-2", "user-1"),
      rowAad("bank_item", "row-1", "user-2"),
      rowAad("other_table", "row-1", "user-1"),
      "bank_item",
    ]) {
      expect(() => decrypt(blob, other)).toThrow(EnvelopeError);
    }
  });

  it("requires a non-empty AAD", () => {
    expect(() => encrypt("x", "")).toThrow(EnvelopeError);
    expect(() => rowAad("t", "", "u")).toThrow(EnvelopeError);
  });

  it("rowAad parts can't be shifted between fields", () => {
    expect(rowAad("a", "bc", "d").equals(rowAad("ab", "c", "d"))).toBe(false);
  });

  it.each([
    ["wrap iv", 2],
    ["wrapped DEK", 3],
    ["wrap tag", 4],
    ["value iv", 5],
    ["ciphertext", 6],
    ["tag", 7],
    ["key id", 1],
  ])("fails when the %s is tampered with", (_name, field) => {
    const blob = encrypt("secret", aad);
    expect(() => decrypt(tamper(blob, field), aad)).toThrow(EnvelopeError);
  });

  it("fails on truncated, extended and malformed blobs", () => {
    const blob = encrypt("secret", aad);
    const parts = blob.split(".");
    for (const bad of [
      "",
      "garbage",
      blob + ".AAAA",
      parts.slice(0, 7).join("."),
      ["v2", ...parts.slice(1)].join("."),
      [...parts.slice(0, 7), parts[7].slice(0, -2)].join("."),
      [...parts.slice(0, 6), "***", parts[7]].join("."),
    ]) {
      expect(() => decrypt(bad, aad)).toThrow(EnvelopeError);
    }
    expect(() => decrypt(undefined as unknown as string, aad)).toThrow(EnvelopeError);
  });

  it("fails with the wrong key", () => {
    const blob = encrypt("secret", aad);
    process.env[ENV_CURRENT] = k2;
    expect(() => decrypt(blob, aad)).toThrow(EnvelopeError);
  });

  it("gives every decrypt failure the same message, with no secret material in it", () => {
    const blob = encrypt("super-secret-plaintext", aad);
    const messages = new Set<string>();
    for (const attempt of [
      () => decrypt(blob, "wrong-aad"),
      () => decrypt(tamper(blob, 6), aad),
      () => decrypt("nonsense", aad),
    ]) {
      try {
        attempt();
      } catch (e) {
        messages.add((e as Error).message);
        const text = `${(e as Error).message}${(e as Error).stack}`;
        expect(text).not.toContain("super-secret-plaintext");
        expect(text).not.toContain(k1);
        expect(text).not.toContain(blob);
      }
    }
    expect(messages.size).toBe(1);
  });
});

describe("rotation", () => {
  it("decrypts old blobs with TOKEN_ENC_KEY_PREVIOUS and encrypts new ones with the new key", () => {
    const old = encrypt("old-secret", aad);
    process.env[ENV_CURRENT] = k2;
    expect(() => decrypt(old, aad)).toThrow(EnvelopeError);
    process.env[ENV_PREVIOUS] = k1;
    expect(decrypt(old, aad)).toBe("old-secret");
    expect(needsRewrap(old)).toBe(true);
    const fresh = encrypt("new-secret", aad);
    expect(fresh.split(".")[1]).toBe(validateEncryptionEnv().currentKeyId);
    expect(needsRewrap(fresh)).toBe(false);
  });

  it("rewrap moves a blob to the new key without changing the encrypted value, then the old key can go", () => {
    const old = encrypt("old-secret", aad);
    process.env[ENV_CURRENT] = k2;
    process.env[ENV_PREVIOUS] = k1;
    const moved = rewrap(old);
    const before = old.split(".");
    const after = moved.split(".");
    expect(after[1]).not.toBe(before[1]);
    expect(after.slice(5)).toEqual(before.slice(5)); // iv, ciphertext, tag unchanged
    expect(needsRewrap(moved)).toBe(false);
    expect(rewrap(moved)).toBe(moved);
    delete process.env[ENV_PREVIOUS];
    expect(decrypt(moved, aad)).toBe("old-secret");
    expect(() => decrypt(moved, rowAad("bank_item", "row-9", "user-1"))).toThrow(EnvelopeError);
  });

  it("rewrap fails for unknown keys and tampered blobs", () => {
    const old = encrypt("x", aad);
    process.env[ENV_CURRENT] = k2; // old key not supplied as previous
    expect(() => rewrap(old)).toThrow(EnvelopeError);
    process.env[ENV_PREVIOUS] = k1;
    expect(() => rewrap(tamper(old, 3))).toThrow(EnvelopeError);
    expect(() => rewrap("junk")).toThrow(EnvelopeError);
  });
});

describe("environment validation", () => {
  const expectConfigError = (value: string | undefined, name = ENV_CURRENT) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    let message = "";
    try {
      validateEncryptionEnv();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvelopeError);
      message = (e as Error).message;
    }
    expect(message).toContain(name);
    if (value) expect(message).not.toContain(value);
  };

  it("refuses a missing key", () => expectConfigError(undefined));
  it("refuses an empty key", () => expectConfigError("  "));
  it("refuses a short key", () => expectConfigError(randomBytes(16).toString("base64")));
  it("refuses a long key", () => expectConfigError(randomBytes(33).toString("base64")));
  it("refuses a key that isn't base64", () => expectConfigError("not-base64-at-all!!not-base64-at-all!!not-base64-at-all!!"));
  it("refuses a hex key", () => expectConfigError(randomBytes(32).toString("hex")));
  it("refuses a bad previous key", () => expectConfigError("short", ENV_PREVIOUS));

  it("refuses the same key as current and previous", () => {
    process.env[ENV_PREVIOUS] = k1;
    expect(() => validateEncryptionEnv()).toThrow(/differ/);
  });

  it("encrypt and decrypt fail clearly when the key is missing", () => {
    const blob = encrypt("x", aad);
    delete process.env[ENV_CURRENT];
    expect(() => encrypt("x", aad)).toThrow(/TOKEN_ENC_KEY is not set/);
    expect(() => rewrap(blob)).toThrow(/TOKEN_ENC_KEY is not set/);
    expect(() => decrypt(blob, aad)).toThrow(/TOKEN_ENC_KEY is not set/);
    expect(() => needsRewrap(blob)).toThrow(/TOKEN_ENC_KEY is not set/);
  });

  it("accepts only the canonical base64url spelling of each part", () => {
    const blob = encrypt("canonical", aad);
    const parts = blob.split(".");
    const last = parts[parts.length - 1];
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    // Flipping the lowest bit of the final character only changes padding bits: same bytes, different string.
    const flipped = last.slice(0, -1) + alphabet[alphabet.indexOf(last.slice(-1)) ^ 1];
    expect(Buffer.from(flipped, "base64url").equals(Buffer.from(last, "base64url"))).toBe(true);
    expect(() => decrypt([...parts.slice(0, -1), flipped].join("."), aad)).toThrow("Decryption failed");
    expect(() => decrypt([...parts.slice(0, -1), last + "A"].join("."), aad)).toThrow("Decryption failed");
    expect(decrypt(blob, aad)).toBe("canonical");
  });

  it("returns key ids, never keys", () => {
    process.env[ENV_PREVIOUS] = k2;
    const ids = validateEncryptionEnv();
    expect(ids.currentKeyId).not.toBe(ids.previousKeyId);
    expect(JSON.stringify(ids)).not.toContain(k1);
    expect(ids.currentKeyId.length).toBeLessThan(16);
  });

  it("picks up a changed key without a restart", () => {
    const a = validateEncryptionEnv().currentKeyId;
    process.env[ENV_CURRENT] = k2;
    expect(validateEncryptionEnv().currentKeyId).not.toBe(a);
  });
});
