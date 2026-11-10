import { beforeEach, describe, expect, it } from "vitest";
import { allowPublicRequest, clientIp, resetPublicLimiter } from "./ip-limit";

describe("public per-IP limiter", () => {
  beforeEach(resetPublicLimiter);

  it("allows 60 per minute per IP, then refuses, then resets with the window", () => {
    for (let i = 0; i < 60; i++) expect(allowPublicRequest("1.1.1.1", 1_000)).toBe(true);
    expect(allowPublicRequest("1.1.1.1", 2_000)).toBe(false);
    expect(allowPublicRequest("2.2.2.2", 2_000)).toBe(true);
    expect(allowPublicRequest("1.1.1.1", 61_001)).toBe(true);
  });

  it("uses the last X-Forwarded-For entry (the gateway's), not what the caller claimed", () => {
    const req = new Request("http://x", { headers: { "x-forwarded-for": "9.9.9.9, 8.8.8.8" } });
    expect(clientIp(req)).toBe("8.8.8.8");
    expect(clientIp(new Request("http://x"))).toBe("unknown");
  });
});
