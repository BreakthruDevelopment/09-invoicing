import { createHmac, timingSafeEqual } from "node:crypto";

/** Stripe's default tolerance: a signed payload older (or newer) than this many seconds is refused. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;
const MAX_HEADER_LENGTH = 1024;
const MAX_CANDIDATES = 10;

export type SignatureFailure = "missing" | "malformed" | "mismatch" | "stale";
export type SignatureResult = { ok: true } | { ok: false; reason: SignatureFailure };

/** The v1 signature Stripe computes: HMAC-SHA256 of `<t>.<raw body>` keyed with the endpoint's signing secret, hex. */
export function computeStripeSignature(rawBody: Buffer | string, secret: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
}

/** A header value as Stripe sends it: `t=<unix seconds>,v1=<hex>[,v1=<hex>...]`. For tests and local stubs. */
export function signStripePayload(rawBody: Buffer | string, secret: string, timestamp: number): string {
  return `t=${timestamp},v1=${computeStripeSignature(rawBody, secret, timestamp)}`;
}

/**
 * Verify a `Stripe-Signature` header over the exact bytes received (verify before parsing anything). Any `v1` entry
 * may match (Stripe sends several while a secret is being rolled); each is compared in constant time. The
 * timestamp is checked only after a signature matched, so an unsigned caller learns nothing from the reason.
 */
export function verifyStripeSignature(
  rawBody: Buffer | string,
  header: string | null,
  secret: string,
  nowMs: number = Date.now(),
  toleranceSeconds: number = SIGNATURE_TOLERANCE_SECONDS,
): SignatureResult {
  if (!header) return { ok: false, reason: "missing" };
  if (header.length > MAX_HEADER_LENGTH) return { ok: false, reason: "malformed" };

  let timestamp: number | undefined;
  const candidates: Buffer[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 1) return { ok: false, reason: "malformed" };
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      if (!/^\d{1,12}$/.test(value)) return { ok: false, reason: "malformed" };
      timestamp = Number(value);
    } else if (key === "v1") {
      if (!/^[0-9a-f]{64}$/i.test(value)) return { ok: false, reason: "malformed" };
      if (candidates.length < MAX_CANDIDATES) candidates.push(Buffer.from(value, "hex"));
    } // other schemes (v0, test signatures) are ignored
  }
  if (timestamp === undefined || candidates.length === 0) return { ok: false, reason: "malformed" };

  const expected = Buffer.from(computeStripeSignature(rawBody, secret, timestamp), "hex");
  let matched = false;
  for (const candidate of candidates) {
    // Both are 32 bytes (validated above), so timingSafeEqual never throws; no early exit between candidates.
    if (timingSafeEqual(candidate, expected)) matched = true;
  }
  if (!matched) return { ok: false, reason: "mismatch" };
  if (Math.abs(nowMs / 1000 - timestamp) > toleranceSeconds) return { ok: false, reason: "stale" };
  return { ok: true };
}
