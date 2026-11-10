/** "Draft from notes" caps and privacy: 10 per user per hour, AI_DAILY_CAP app-wide, slots refunded on provider failure, no notes in logs. */
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";

const url = process.env.TEST_DATABASE_URL;
const SECRET_NOTES = "Zebra-9Q-confidential 6h refactor of the vault module";

describe.skipIf(!url)("draft invoice from notes (Postgres)", () => {
  let sql: postgres.Sql;
  let draftInvoiceFromNotes: typeof import("@/lib/invoice-draft").draftInvoiceFromNotes;
  const alice = { id: "inv-ai-a", role: "user" as const };
  const bob = { id: "inv-ai-b", role: "user" as const };
  let aliceClient: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    for (const u of [alice, bob]) {
      await sql`insert into "user" (id, name, email) values (${u.id}, 'n', ${u.id + "@test.local"}) on conflict do nothing`;
    }
    ({ draftInvoiceFromNotes } = await import("@/lib/invoice-draft"));
    const { createClient } = await import("@/lib/clients");
    aliceClient = (await createClient(alice, { name: "Acme", hourlyRateCents: 10_000 })).id;
  });
  afterAll(async () => {
    await sql`delete from "user" where id like 'inv-ai-%'`;
    await sql`delete from daily_usage where kind = 'ai'`;
    await sql.end();
  });
  beforeEach(async () => {
    vi.stubEnv("AI_PROVIDER", "demo");
    vi.stubEnv("AI_DAILY_CAP", "200");
    vi.stubEnv("LOG_LEVEL", "info");
    resetEnvCache();
    await sql`delete from rate_event where user_id like 'inv-ai-%'`;
    await sql`delete from daily_usage where kind = 'ai'`;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetEnvCache();
  });

  const input = () => ({ notes: SECRET_NOTES, clientId: aliceClient });
  // Bob drafts against his own client.
  let bobClient: string;
  beforeEach(async () => {
    const { createClient } = await import("@/lib/clients");
    bobClient ??= (await createClient(bob, { name: "Bob's client", hourlyRateCents: 5_000 })).id;
  });

  it("allows 10 drafts per user per hour, then 429; another user is unaffected", async () => {
    for (let i = 0; i < 10; i++) await draftInvoiceFromNotes(alice, input());
    await expect(draftInvoiceFromNotes(alice, input())).rejects.toMatchObject({ status: 429 });
    await expect(draftInvoiceFromNotes(bob, { notes: SECRET_NOTES, clientId: bobClient })).resolves.toBeTruthy();
  });

  it("stops at AI_DAILY_CAP app-wide and doesn't charge the user's hourly slot for the refused call", async () => {
    vi.stubEnv("AI_DAILY_CAP", "2");
    resetEnvCache();
    await draftInvoiceFromNotes(alice, input());
    await draftInvoiceFromNotes(bob, { notes: SECRET_NOTES, clientId: bobClient });
    await expect(draftInvoiceFromNotes(alice, input())).rejects.toMatchObject({ status: 429 });
    const [{ n }] = await sql`select count(*)::int as n from rate_event where user_id = ${alice.id} and kind = 'ai'`;
    expect(n).toBe(1);
  });

  it("gives the slots back when the provider fails", async () => {
    vi.stubEnv("AI_PROVIDER", "gemini");
    vi.stubEnv("GEMINI_API_KEY", "stub-key");
    vi.stubEnv("AI_FALLBACK_TO_DEMO", "false");
    resetEnvCache();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    await expect(draftInvoiceFromNotes(alice, input())).rejects.toMatchObject({ kind: "provider" });
    const [{ n }] = await sql`select count(*)::int as n from rate_event where user_id = ${alice.id} and kind = 'ai'`;
    const daily = await sql`select count from daily_usage where kind = 'ai'`;
    expect(n).toBe(0);
    expect(Number(daily[0]?.count ?? 0)).toBe(0);
  });

  it("rejects bad input before using a slot", async () => {
    await expect(draftInvoiceFromNotes(alice, { notes: "x".repeat(6001), clientId: aliceClient })).rejects.toMatchObject({ name: "ZodError" });
    await expect(draftInvoiceFromNotes(alice, { notes: "a", clientId: "not-a-uuid" })).rejects.toMatchObject({ name: "ZodError" });
    await expect(draftInvoiceFromNotes(alice, { notes: "a", clientId: aliceClient, clientRateCents: 1 })).rejects.toMatchObject({ name: "ZodError" });
    const [{ n }] = await sql`select count(*)::int as n from rate_event where user_id = ${alice.id}`;
    expect(n).toBe(0);
  });

  it("never logs the notes or the model's lines", async () => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => void out.push(a.join(" ")));
    const draft = await draftInvoiceFromNotes(alice, input());
    expect(draft.dropped.length).toBeGreaterThan(0);
    const logged = out.join("\n");
    expect(logged).toContain("invoice.draft");
    expect(logged).not.toContain("Zebra");
    expect(logged).not.toContain("vault");
    expect(logged).not.toContain("Homepage"); // fixture line text
  });
});
