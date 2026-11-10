import { describe, expect, it } from "vitest";
import { isDemoEmail, isDemoImage, MARKER, refuseDemoIdentity } from "./demo-identity";

describe("isDemoEmail", () => {
  it("matches the demo domain only, ignoring case and spaces", () => {
    expect(isDemoEmail("ada@demo.breakthru.test")).toBe(true);
    expect(isDemoEmail(" ADA@Demo.Breakthru.Test ")).toBe(true);
    expect(isDemoEmail("ada@example.test")).toBe(false);
    expect(isDemoEmail("ada@evil-demo.breakthru.test.example")).toBe(false);
    expect(isDemoEmail(undefined)).toBe(false);
  });
});

describe("isDemoImage", () => {
  it("matches any urn:breakthru: image, ignoring case and spaces", () => {
    expect(isDemoImage(MARKER)).toBe(true);
    expect(isDemoImage("urn:breakthru:other-app-demo:v2")).toBe(true);
    expect(isDemoImage("  URN:Breakthru:x")).toBe(true);
    expect(isDemoImage("https://example.test/a.png")).toBe(false);
    expect(isDemoImage(undefined)).toBe(false);
    expect(isDemoImage(null)).toBe(false);
  });
});

describe("refuseDemoIdentity", () => {
  it("throws for a demo email or marker image and passes ordinary data", async () => {
    expect(() => refuseDemoIdentity({ email: "a@demo.breakthru.test" })).toThrow();
    expect(() => refuseDemoIdentity({ image: MARKER })).toThrow();
    await expect(refuseDemoIdentity({ email: "a@example.test", image: null })).resolves.toEqual({
      data: { email: "a@example.test", image: null },
    });
  });
});
