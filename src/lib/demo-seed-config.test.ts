import { describe, expect, it } from "vitest";
import { demoSeedConfig } from "./demo-seed-config";
import { isDemoEmail } from "./demo-identity";

const ok = { DEMO_SEED: "yes", APP_URL: "http://localhost:3000", DATABASE_URL: "postgres://app:app@localhost:5432/app", DEMO_PASSWORD: "a-long-demo-password" };

describe("demoSeedConfig", () => {
  it("accepts a local app and database", () => {
    expect(demoSeedConfig(ok)).toEqual({ appUrl: "http://localhost:3000", password: "a-long-demo-password" });
  });

  it("refuses without DEMO_SEED=yes, a valid APP_URL or a real password", () => {
    expect(() => demoSeedConfig({ ...ok, DEMO_SEED: undefined })).toThrow(/DEMO_SEED=yes/);
    expect(() => demoSeedConfig({ ...ok, DEMO_SEED: "true" })).toThrow(/DEMO_SEED=yes/);
    expect(() => demoSeedConfig({ ...ok, APP_URL: "nope" })).toThrow(/valid URL/);
    expect(() => demoSeedConfig({ ...ok, DEMO_PASSWORD: "short" })).toThrow();
  });

  it("refuses production origins on every cloud, whatever the case or trailing dot", () => {
    for (const url of [
      "https://app4.breakthruventures.ai",
      "https://APP4.breakthruventures.ai./",
      "http://1-2-3-4.sslip.io",
      "https://sslip.io",
      "https://app3.example.azurecontainerapps.io",
      "https://svc-abc-uc.a.run.app",
      "https://abc.lambda-url.us-east-1.on.aws",
      "https://abc.execute-api.us-east-1.amazonaws.com",
    ]) {
      expect(() => demoSeedConfig({ ...ok, APP_URL: url }), url).toThrow(/production host/);
    }
  });

  it("does not mistake look-alike hosts for production", () => {
    expect(() => demoSeedConfig({ ...ok, APP_URL: "http://localhost:3117" })).not.toThrow();
    expect(() => demoSeedConfig({ ...ok, APP_URL: "https://notbreakthruventures.ai" })).not.toThrow();
  });

  it("refuses the VM's compose database host `postgres`", () => {
    expect(() => demoSeedConfig({ ...ok, DATABASE_URL: "postgres://postgres:x@postgres:5432/app" })).toThrow(/production database/);
    expect(() => demoSeedConfig({ ...ok, DATABASE_URL: "postgres://postgres:x@Postgres.:5432/app" })).toThrow(/production database/);
  });

  it("refuses Azure and AWS managed databases", () => {
    for (const host of ["srv.postgres.database.azure.com", "db.abc.us-east-1.rds.amazonaws.com"]) {
      expect(() => demoSeedConfig({ ...ok, DATABASE_URL: `postgres://u:p@${host}:5432/app` }), host).toThrow(/production database/);
    }
  });

  it("refuses a Cloud SQL socket database", () => {
    for (const DATABASE_URL of ["postgres://u:p@/db?host=/cloudsql/proj:us-central1:inst", "postgres://u:p@/db?host=%2Fcloudsql%2Fproj%3Aus%3Ainst"]) {
      expect(() => demoSeedConfig({ ...ok, DATABASE_URL })).toThrow(/production database/);
    }
  });
});

describe("demoSeedConfig (unreadable DATABASE_URL)", () => {
  it.each([
    "postgres://u:pa#ss@postgres:5432/app", // unencoded # truncates the URL
    "postgres://u:p@a.example,b.example:5432/app", // multi-host list
    "postgres://u:p@h1:5432,h2:5432/app",
    "postgres://u:p@/app?host=/var/run/postgresql", // no host to vet
    "not a url",
  ])("refuses %s", (DATABASE_URL) => {
    expect(() => demoSeedConfig({ ...ok, DATABASE_URL })).toThrow(/DATABASE_URL/);
  });

  it("still allows no DATABASE_URL at all (the loader will fail on its own)", () => {
    expect(() => demoSeedConfig({ ...ok, DATABASE_URL: undefined })).not.toThrow();
  });
});

describe("isDemoEmail", () => {
  it("matches the demo domain only", () => {
    expect(isDemoEmail("ada@demo.breakthru.test")).toBe(true);
    expect(isDemoEmail(" ADA@Demo.Breakthru.Test ")).toBe(true);
    expect(isDemoEmail("ada@example.test")).toBe(false);
    expect(isDemoEmail("ada@evil-demo.breakthru.test.example")).toBe(false);
    expect(isDemoEmail(undefined)).toBe(false);
  });
});
