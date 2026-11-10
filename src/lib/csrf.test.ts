import { beforeAll, describe, expect, it } from "vitest";

describe("requireSameOrigin", () => {
  let requireSameOrigin: typeof import("@/lib/csrf").requireSameOrigin;
  beforeAll(async () => {
    process.env.APP_URL = "https://app.example.test";
    process.env.DATABASE_URL ??= "postgres://unused";
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    ({ requireSameOrigin } = await import("@/lib/csrf"));
  });
  const req = (origin?: string) => new Request("https://app.example.test/api/items", { method: "POST", headers: origin ? { origin } : {} });

  it("accepts our own origin", () => {
    expect(() => requireSameOrigin(req("https://app.example.test"))).not.toThrow();
  });
  it("refuses a sibling subdomain, and a missing Origin", () => {
    expect(() => requireSameOrigin(req("https://sibling.example.test"))).toThrow(/Cross-origin/);
    expect(() => requireSameOrigin(req())).toThrow(/Cross-origin/);
  });
  it("refuses the literal origin \"null\" (sandboxed iframes, redirects)", () => {
    expect(() => requireSameOrigin(req("null"))).toThrow(/Cross-origin/);
  });
  it("refuses a different port or scheme", () => {
    expect(() => requireSameOrigin(req("https://app.example.test:8443"))).toThrow(/Cross-origin/);
    expect(() => requireSameOrigin(req("http://app.example.test"))).toThrow(/Cross-origin/);
    expect(() => requireSameOrigin(req("https://app.example.test.evil.test"))).toThrow(/Cross-origin/);
  });
  it("refuses another hostname for the same app (www, an alias, the bare IP)", () => {
    expect(() => requireSameOrigin(req("https://www.app.example.test"))).toThrow(/Cross-origin/);
  });
  it("compares origins, so APP_URL with a trailing slash or a path still works", async () => {
    const { resetEnvCache } = await import("@/lib/env");
    const prev = process.env.APP_URL;
    try {
      for (const appUrl of ["https://app.example.test/", "https://app.example.test/some/path/"]) {
        process.env.APP_URL = appUrl;
        resetEnvCache();
        expect(() => requireSameOrigin(req("https://app.example.test"))).not.toThrow();
        expect(() => requireSameOrigin(req("https://app.example.test/"))).toThrow(/Cross-origin/); // browsers never send a trailing slash
      }
    } finally {
      process.env.APP_URL = prev;
      resetEnvCache();
    }
  });
});
