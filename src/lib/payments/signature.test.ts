import { describe, expect, it } from "vitest";
import { SIGNATURE_TOLERANCE_SECONDS, computeStripeSignature, signStripePayload, verifyStripeSignature } from "./signature";

const secret = "whsec_test_secret";
const body = '{"id":"evt_1","type":"checkout.session.completed"}';
const now = 1_800_000_000_000;
const t = now / 1000;

describe("verifyStripeSignature", () => {
  it("accepts a correctly signed body (string or bytes)", () => {
    expect(verifyStripeSignature(body, signStripePayload(body, secret, t), secret, now)).toEqual({ ok: true });
    expect(verifyStripeSignature(Buffer.from(body), signStripePayload(body, secret, t), secret, now)).toEqual({ ok: true });
  });

  it("accepts any matching v1 among several, and ignores other schemes", () => {
    const good = computeStripeSignature(body, secret, t);
    const header = `t=${t},v1=${"0".repeat(64)},v0=abc,v1=${good}`;
    expect(verifyStripeSignature(body, header, secret, now)).toEqual({ ok: true });
  });

  it("refuses a changed body, a wrong secret and a changed timestamp", () => {
    const header = signStripePayload(body, secret, t);
    expect(verifyStripeSignature(body + " ", header, secret, now)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyStripeSignature(body, header, "whsec_other", now)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyStripeSignature(body, header.replace(`t=${t}`, `t=${t + 1}`), secret, now)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("refuses a correctly signed but stale or future timestamp (300 s tolerance, both ways)", () => {
    const old = t - SIGNATURE_TOLERANCE_SECONDS - 1;
    expect(verifyStripeSignature(body, signStripePayload(body, secret, old), secret, now)).toEqual({ ok: false, reason: "stale" });
    const future = t + SIGNATURE_TOLERANCE_SECONDS + 1;
    expect(verifyStripeSignature(body, signStripePayload(body, secret, future), secret, now)).toEqual({ ok: false, reason: "stale" });
    const edge = t - SIGNATURE_TOLERANCE_SECONDS;
    expect(verifyStripeSignature(body, signStripePayload(body, secret, edge), secret, now)).toEqual({ ok: true });
  });

  it("refuses a missing or malformed header", () => {
    for (const header of [null, "", "garbage", "t=abc,v1=" + "a".repeat(64), `t=${t}`, `t=${t},v1=zz`, `t=${t},v1=${"a".repeat(63)}`, `v1=${"a".repeat(64)}`, "x".repeat(2000)]) {
      const r = verifyStripeSignature(body, header, secret, now);
      expect(r.ok).toBe(false);
    }
  });
});
