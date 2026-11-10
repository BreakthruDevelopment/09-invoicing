/**
 * Envelope encryption for secrets stored in the database (OAuth tokens, API keys).
 *
 * One self-contained file (node:crypto only) so an app can copy it with its test.
 *
 *  - Every value gets its own random 256-bit data key (DEK) and AES-256-GCM encrypts the value with it.
 *  - The DEK is wrapped (AES-256-GCM) by a key-encryption key (KEK) read from the environment. No KMS: it costs money.
 *  - The caller's `aad` (additional authenticated data, e.g. rowAad("bank_item", id, userId)) is bound into the
 *    value's tag, so a ciphertext copied to another row, column or user fails to decrypt.
 *  - Rotation: set TOKEN_ENC_KEY to the new KEK and TOKEN_ENC_KEY_PREVIOUS to the old one. New writes use the new
 *    KEK, old blobs still decrypt, and `rewrap` moves a blob to the new KEK without touching the encrypted value.
 *
 * Blob format (text, safe for a `text` column), fields joined by "." and base64url encoded:
 *   v1.<kekId>.<wrapIv>.<wrappedDek>.<wrapTag>.<iv>.<ciphertext>.<tag>
 * kekId is a truncated SHA-256 of the KEK (never the key), so the right KEK is picked without trial decryption.
 *
 * Failure behaviour: every decrypt failure (wrong AAD, tampering, unknown or wrong key, malformed blob) throws the
 * same EnvelopeError message, so callers and logs learn nothing about which check failed. Errors never carry
 * plaintext, ciphertext, keys or AAD. GCM tag checks are done by OpenSSL in constant time; the kekId and format
 * checks compare public values only. Never log the plaintext `decrypt` returns, and call `decrypt` only from the one
 * place that needs the secret.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID_BYTES = 8;
/** Larger values are refused up front: this is for small secrets (tokens, keys), decrypted synchronously. */
export const MAX_PLAINTEXT_BYTES = 64 * 1024;
const MAX_BLOB_CHARS = Math.ceil((MAX_PLAINTEXT_BYTES * 4) / 3) + 1024;

export const ENV_CURRENT = "TOKEN_ENC_KEY";
export const ENV_PREVIOUS = "TOKEN_ENC_KEY_PREVIOUS";

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

const DECRYPT_FAILED = "Decryption failed";

type Kek = { id: string; key: Buffer };
type Keyring = { current: Kek; previous?: Kek };

const BASE64 = /^[A-Za-z0-9+/]{43}=$/; // exactly 32 bytes, canonical padding

function parseKek(name: string, raw: string): Kek {
  const value = raw.trim();
  const fix = `Set ${name} to 32 random bytes, base64 encoded (generate one with: openssl rand -base64 32).`;
  if (!BASE64.test(value)) throw new EnvelopeError(`${name} is not a base64 encoded 32-byte key. ${fix}`);
  const key = Buffer.from(value, "base64");
  if (key.length !== KEY_BYTES) throw new EnvelopeError(`${name} must decode to exactly ${KEY_BYTES} bytes. ${fix}`);
  return { id: keyId(key), key };
}

function keyId(key: Buffer): string {
  return createHash("sha256")
    .update("envelope-kek-id:v1\0")
    .update(key)
    .digest()
    .subarray(0, KEY_ID_BYTES)
    .toString("base64url");
}

let cache: { raw: string; ring: Keyring } | undefined;

/**
 * Reads and validates the KEKs. Call it at startup (e.g. from instrumentation.ts) so a missing or malformed key
 * stops the server with a clear message instead of failing on the first user request. Returns key ids only.
 */
export function validateEncryptionEnv(): { currentKeyId: string; previousKeyId?: string } {
  const ring = keyring();
  return { currentKeyId: ring.current.id, previousKeyId: ring.previous?.id };
}

function keyring(): Keyring {
  const rawCurrent = process.env[ENV_CURRENT] ?? "";
  const rawPrevious = process.env[ENV_PREVIOUS] ?? "";
  const raw = `${rawCurrent}\0${rawPrevious}`;
  if (cache?.raw === raw) return cache.ring;
  if (!rawCurrent.trim()) {
    throw new EnvelopeError(
      `${ENV_CURRENT} is not set. Generate a key with: openssl rand -base64 32, and store it in the cloud's secret manager.`,
    );
  }
  const current = parseKek(ENV_CURRENT, rawCurrent);
  const previous = rawPrevious.trim() ? parseKek(ENV_PREVIOUS, rawPrevious) : undefined;
  if (previous && previous.id === current.id) {
    throw new EnvelopeError(`${ENV_PREVIOUS} must differ from ${ENV_CURRENT}; remove it once rotation is finished.`);
  }
  const ring = { current, previous };
  cache = { raw, ring };
  return ring;
}

/**
 * Builds the AAD for a row: table, row id and owning user. Parts are length-prefixed so ("a","bc") and ("ab","c")
 * can't collide. Use the same call in encrypt and decrypt, with the row's id and owner from the database.
 */
export function rowAad(table: string, id: string, userId: string): Buffer {
  const parts = [table, id, userId];
  if (parts.some((p) => typeof p !== "string" || p.length === 0)) {
    throw new EnvelopeError("rowAad needs a non-empty table, id and userId");
  }
  return Buffer.concat(
    parts.flatMap((p) => {
      const b = Buffer.from(p, "utf8");
      const len = Buffer.alloc(4);
      len.writeUInt32BE(b.length);
      return [len, b];
    }),
  );
}

type Aad = string | Uint8Array;

function aadBuffer(aad: Aad): Buffer {
  const buf = typeof aad === "string" ? Buffer.from(aad, "utf8") : Buffer.from(aad);
  if (buf.length === 0) throw new EnvelopeError("aad is required: bind every ciphertext to its row (see rowAad)");
  return buf;
}

function dataAad(aad: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${VERSION}\0data\0`), aad]);
}

function wrapAad(id: string): Buffer {
  return Buffer.from(`${VERSION}\0wrap\0${id}`);
}

function seal(key: Buffer, plaintext: Buffer, aad: Buffer) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, ciphertext, tag: cipher.getAuthTag() };
}

function open(key: Buffer, iv: Buffer, ciphertext: Buffer, tag: Buffer, aad: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Encrypts `plaintext` for the row described by `aad`. Returns a text blob to store. */
export function encrypt(plaintext: string | Uint8Array, aad: Aad): string {
  const data = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : Buffer.from(plaintext);
  if (data.length > MAX_PLAINTEXT_BYTES) {
    throw new EnvelopeError(`Value is larger than the ${MAX_PLAINTEXT_BYTES} byte limit`);
  }
  const bound = aadBuffer(aad);
  const { current } = keyring();
  const dek = randomBytes(KEY_BYTES);
  try {
    const value = seal(dek, data, dataAad(bound));
    const wrapped = seal(current.key, dek, wrapAad(current.id));
    return serialize(current.id, wrapped, value);
  } finally {
    dek.fill(0);
    data.fill(0); // our own copy of the plaintext
  }
}

/** Decrypts a blob made by `encrypt`. The AAD must be exactly the one used to encrypt. Returns UTF-8 text. */
export function decrypt(blob: string, aad: Aad): string {
  return decryptBytes(blob, aad).toString("utf8");
}

/** Like `decrypt` but returns the raw bytes (for values that aren't text). */
export function decryptBytes(blob: string, aad: Aad): Buffer {
  keyring(); // a missing or invalid key is a setup error (no secrets in it), reported as such
  let dek: Buffer | undefined;
  try {
    const bound = aadBuffer(aad);
    const parsed = parse(blob);
    dek = unwrapDek(parsed);
    return open(dek, parsed.iv, parsed.ciphertext, parsed.tag, dataAad(bound));
  } catch {
    // One message for every cause: no oracle, and nothing from the inputs in the error.
    throw new EnvelopeError(DECRYPT_FAILED);
  } finally {
    dek?.fill(0);
  }
}

/**
 * Re-wraps the blob's data key under the current KEK (after rotation). The encrypted value is untouched, so no
 * AAD is needed and the plaintext is never produced. Blobs already on the current KEK are returned unchanged.
 * Store the result back in the same row; decrypt still enforces the AAD.
 */
export function rewrap(blob: string): string {
  const { current } = keyring();
  let dek: Buffer | undefined;
  try {
    const parsed = parse(blob);
    if (parsed.kekId === current.id) return blob;
    dek = unwrapDek(parsed);
    const wrapped = seal(current.key, dek, wrapAad(current.id));
    return serialize(current.id, wrapped, parsed);
  } catch {
    throw new EnvelopeError("Rewrap failed");
  } finally {
    dek?.fill(0);
  }
}

/** True when the blob is wrapped by a KEK other than the current one (so a rotation job should rewrap it). */
export function needsRewrap(blob: string): boolean {
  const currentId = keyring().current.id; // throws when the key is missing, so a rotation job can't report "nothing to do"
  try {
    return parse(blob).kekId !== currentId;
  } catch {
    return false;
  }
}

type Parsed = {
  kekId: string;
  wrapIv: Buffer;
  wrappedDek: Buffer;
  wrapTag: Buffer;
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
};

function serialize(
  id: string,
  wrapped: { iv: Buffer; ciphertext: Buffer; tag: Buffer },
  value: { iv: Buffer; ciphertext: Buffer; tag: Buffer },
): string {
  return [
    VERSION,
    id,
    wrapped.iv.toString("base64url"),
    wrapped.ciphertext.toString("base64url"),
    wrapped.tag.toString("base64url"),
    value.iv.toString("base64url"),
    value.ciphertext.toString("base64url"),
    value.tag.toString("base64url"),
  ].join(".");
}

function parse(blob: string): Parsed {
  if (typeof blob !== "string" || blob.length > MAX_BLOB_CHARS) throw new EnvelopeError(DECRYPT_FAILED);
  const parts = blob.split(".");
  if (parts.length !== 8 || parts[0] !== VERSION) throw new EnvelopeError(DECRYPT_FAILED);
  const b64 = (s: string) => {
    if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new EnvelopeError(DECRYPT_FAILED);
    const bytes = Buffer.from(s, "base64url");
    // Node ignores stray trailing bits and characters; only the canonical spelling is accepted.
    if (bytes.toString("base64url") !== s) throw new EnvelopeError(DECRYPT_FAILED);
    return bytes;
  };
  const p: Parsed = {
    kekId: parts[1],
    wrapIv: b64(parts[2]),
    wrappedDek: b64(parts[3]),
    wrapTag: b64(parts[4]),
    iv: b64(parts[5]),
    ciphertext: b64(parts[6]),
    tag: b64(parts[7]),
  };
  if (
    p.wrapIv.length !== IV_BYTES ||
    p.iv.length !== IV_BYTES ||
    p.wrapTag.length !== TAG_BYTES ||
    p.tag.length !== TAG_BYTES ||
    p.wrappedDek.length !== KEY_BYTES
  ) {
    throw new EnvelopeError(DECRYPT_FAILED);
  }
  return p;
}

function unwrapDek(p: Parsed): Buffer {
  const { current, previous } = keyring();
  const kek = p.kekId === current.id ? current : p.kekId === previous?.id ? previous : undefined;
  if (!kek) throw new EnvelopeError(DECRYPT_FAILED);
  return open(kek.key, p.wrapIv, p.wrappedDek, p.wrapTag, wrapAad(p.kekId));
}
