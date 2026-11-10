/**
 * The demo workspace: the loader against a real Postgres, the admin route, and the CLI refusal rules. Proves the
 * sample data obeys the real rules, a reload replaces exactly the demo owners' rows, an unrelated account that holds
 * a demo email is never touched (409), and nobody but an admin can load it.
 */
import { spawnSync } from "node:child_process";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/rbac";
import { DEMO_SAMPLE_NOTES } from "@/lib/ai/invoice-from-notes";
import { MARKER } from "@/lib/demo-identity";

const current = vi.hoisted(() => ({ actor: { id: "dw-admin", role: "admin" as "admin" | "user" | null } }));
vi.mock("@/lib/auth/session", () => ({
  requireRole: vi.fn(async () => {
    if (!current.actor.role) throw new UnauthorizedError();
    if (current.actor.role !== "admin") throw new ForbiddenError();
    return current.actor;
  }),
}));

const base = { DEMO_SEED: "yes", APP_URL: "http://localhost:3000", DEMO_PASSWORD: "demo-test-password-123" };

describe("demo CLI guards", () => {
  it("the actual CLI refuses a production origin and a production database before connecting", () => {
    for (const env of <Record<string, string>[]>[{ ...base, DEMO_SEED: "no" }, { ...base, APP_URL: "https://app9.breakthruventures.ai" }, { ...base, DATABASE_URL: "postgres://u:p@x.rds.amazonaws.com/x" }]) {
      const child = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/seed-demo.mts"], {
        env: { ...process.env, ...env, DATABASE_URL: env.DATABASE_URL ?? "postgres://invalid:invalid@127.0.0.1:1/invalid" },
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(child.status).toBe(1);
      expect(child.stderr).toContain("Demo seed refused");
      expect(child.stderr).not.toContain("ECONNREFUSED");
    }
  });
});

describe("unique violations map to 409", () => {
  it("recognises 23505 directly and wrapped by drizzle, and nothing else", async () => {
    const { isUniqueViolation } = await import("@/lib/demo-workspace");
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation(Object.assign(new Error("Failed query"), { cause: { code: "23505", constraint_name: "user_email_unique" } }))).toBe(true);
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("demo workspace (Postgres)", () => {
  let sql: postgres.Sql;
  let loader: typeof import("@/lib/demo-workspace");
  let post: typeof import("@/app/api/admin/demo/route").POST;
  let invoices: typeof import("@/lib/invoices");
  let share: typeof import("@/lib/share");
  const admin = { id: "dw-admin", role: "admin" as const };
  const real = { id: "dw-real", role: "user" as const };
  const demoOwners = () => sql<{ id: string; email: string }[]>`select id, email from "user" where image = ${MARKER} order by email`;

  const wipeDemo = async () => {
    const owners = await demoOwners();
    const ids = owners.map((o) => o.id);
    await sql`delete from "user" where id = any(${ids})`;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.APP_URL = "http://localhost:3000";
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    await sql`delete from "user" where id like 'dw-%' or email like '%@demo.breakthru.test'`;
    for (const u of [admin, real]) await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.id + "@test.local"}, ${u.role})`;
    loader = await import("@/lib/demo-workspace");
    post = (await import("@/app/api/admin/demo/route")).POST;
    invoices = await import("@/lib/invoices");
    share = await import("@/lib/share");
  });
  afterAll(async () => {
    await sql`delete from "user" where id like 'dw-%' or email like '%@demo.breakthru.test'`;
    await sql.end();
  });
  beforeEach(async () => {
    current.actor = admin;
    await sql`delete from rate_event where kind = 'demo_load'`;
    await sql`delete from daily_usage where kind = 'demo_load'`;
  });

  it("loads 2 owners, 4 clients and 8 invoices across every state, obeying the real rules", async () => {
    const result = await loader.loadDemoWorkspace(admin);
    expect(result).toEqual({ users: 2, clients: 4, invoices: 8, notes: 2 });
    const owners = await demoOwners();
    expect(owners.map((o) => o.email)).toEqual(["maya@demo.breakthru.test", "theo@demo.breakthru.test"]);
    const ids = owners.map((o) => o.id);

    const byStatus = await sql`select status, count(*)::int as n from invoice where owner_id = any(${ids}) group by status order by status`;
    expect(Object.fromEntries(byStatus.map((r) => [r.status, r.n]))).toEqual({ draft: 2, paid: 2, sent: 3, void: 1 });

    // Numbers run from INV-0001 per owner with no gaps; drafts have none.
    for (const o of owners) {
      const nums = await sql`select number from invoice where owner_id = ${o.id} and number is not null order by number`;
      expect(nums.map((r) => r.number)).toEqual(nums.map((_, i) => `INV-${String(i + 1).padStart(4, "0")}`));
    }
    expect((await sql`select count(*)::int as n from invoice where owner_id = any(${ids}) and status = 'draft' and number is not null`)[0].n).toBe(0);

    // Every stored total matches money.ts, and sent invoices are snapshotted with hashed links.
    const rows = await sql`select * from invoice where owner_id = any(${ids})`;
    const { computeTotals } = await import("@/lib/money");
    for (const r of rows) {
      const lines = await sql`select quantity_x100, unit_price_cents from invoice_line where invoice_id = ${r.id}`;
      const t = computeTotals(lines.map((l) => ({ quantityX100: l.quantity_x100, unitPriceCents: l.unit_price_cents })), r.tax_bp);
      expect(Number(r.total_cents)).toBe(t.totalCents);
      if (r.status !== "draft" && r.number) expect(r.client_snapshot?.name).toBeTruthy();
    }
    // One invoice is overdue on read, and the demo draft/void ones aren't.
    const maya = { id: owners[0].id, role: "user" as const };
    const mayaInvoices = await invoices.listInvoices(maya);
    expect(mayaInvoices.filter((i) => i.overdue)).toHaveLength(1);
    expect(mayaInvoices).toHaveLength(5);
    expect((await invoices.listInvoices(maya, { status: "overdue" }))).toHaveLength(1);
    // Payments exist for the paid ones: one demo, one manual.
    const pays = await sql`select method from payment where owner_id = any(${ids}) order by method`;
    expect(pays.map((p) => p.method)).toEqual(["demo", "manual"]);
    // Share links are hashed at rest and only for sent/paid/void invoices.
    const withLink = await sql`select status from invoice where owner_id = any(${ids}) and share_token_hash is not null`;
    expect(withLink.every((r) => r.status !== "draft")).toBe(true);
    expect(await share.resolveShareToken("e".repeat(43))).toBeNull();
  });

  it("seeds notes containing 6h and $450 for the AI demo", async () => {
    await loader.loadDemoWorkspace(admin);
    const notes = await sql`select notes, mode from notes_draft where owner_id in (select id from "user" where image = ${MARKER})`;
    expect(notes).toHaveLength(2);
    for (const n of notes) {
      expect(n.notes).toBe(DEMO_SAMPLE_NOTES);
      expect(n.notes).toContain("6h");
      expect(n.notes).toContain("$450");
      expect(n.mode).toBe("demo");
    }
  });

  it("a reload replaces exactly the demo owners' rows; real users' rows survive", async () => {
    await sql`insert into client (owner_id, name) values (${real.id}, 'Real client')`;
    await sql`insert into business_profile (owner_id, name) values (${real.id}, 'Real Co')`;
    await loader.loadDemoWorkspace(admin);
    const first = (await demoOwners()).map((o) => o.id);
    await sql`delete from rate_event where kind = 'demo_load'`;
    await sql`delete from daily_usage where kind = 'demo_load'`;
    expect(await loader.loadDemoWorkspace(admin)).toEqual({ users: 2, clients: 4, invoices: 8, notes: 2 });
    expect((await demoOwners()).map((o) => o.id)).toEqual(first); // same accounts, rotated passwords
    expect((await sql`select count(*)::int as n from invoice where owner_id = any(${first})`)[0].n).toBe(8);
    expect((await sql`select count(*)::int as n from client where owner_id = any(${first})`)[0].n).toBe(4);
    expect((await sql`select count(*)::int as n from notes_draft where owner_id = any(${first})`)[0].n).toBe(2);
    expect((await sql`select name from client where owner_id = ${real.id}`).map((r) => r.name)).toEqual(["Real client"]);
    expect((await sql`select name from business_profile where owner_id = ${real.id}`)[0].name).toBe("Real Co");
    // Demo numbering starts over on reload.
    expect((await sql`select min(number) as n from invoice where owner_id = ${first[0]}`)[0].n).toBe("INV-0001");
  });

  it("users are written with the marker and a credential account; admin mode can't be signed into", async () => {
    await loader.loadDemoWorkspace(admin);
    const rows = await sql`select u.role, u.image, a.provider_id, a.password from "user" u join account a on a.user_id = u.id where u.image = ${MARKER}`;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r).toMatchObject({ role: "user", image: MARKER, provider_id: "credential" });
      expect(r.password).toBeTruthy();
    }
    expect(new Set(rows.map((r) => r.password)).size).toBe(2); // random per owner, not a shared known password
  });

  it("an unrelated account holding a demo email is a 409 and nothing is replaced", async () => {
    await wipeDemo();
    await sql`insert into "user" (id, name, email) values ('dw-squatter', 'Squatter', 'theo@demo.breakthru.test')`;
    await sql`insert into client (owner_id, name) values ('dw-squatter', 'Squatter client')`;
    await expect(loader.loadDemoWorkspace(admin)).rejects.toMatchObject({ status: 409 });
    expect(await demoOwners()).toHaveLength(0); // not even Maya was created
    expect((await sql`select name from client where owner_id = 'dw-squatter'`)[0].name).toBe("Squatter client");
    expect((await sql`select image from "user" where id = 'dw-squatter'`)[0].image).toBeNull();
    await sql`delete from "user" where id = 'dw-squatter'`;
  });

  it("only an admin can load it, and the route reserves one load per minute", async () => {
    await expect(loader.loadDemoWorkspace(real)).rejects.toMatchObject({ status: 403 });
    const headers = { origin: "http://localhost:3000" };
    current.actor = { id: real.id, role: "user" };
    expect((await post(new Request("http://x", { method: "POST", headers }))).status).toBe(403);
    current.actor = { id: "x", role: null };
    expect((await post(new Request("http://x", { method: "POST", headers }))).status).toBe(401);
    current.actor = admin;
    expect((await post(new Request("http://x", { method: "POST" }))).status).toBe(403); // no Origin
    const first = await post(new Request("http://x", { method: "POST", headers }));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ users: 2, clients: 4, invoices: 8, notes: 2 });
    expect((await post(new Request("http://x", { method: "POST", headers }))).status).toBe(429);
  });

  it("refuses to run as one of the demo owners", async () => {
    await loader.loadDemoWorkspace(admin);
    const [maya] = await demoOwners();
    await sql`delete from rate_event where kind = 'demo_load'`;
    await expect(loader.loadDemoWorkspace({ id: maya.id, role: "admin" })).rejects.toMatchObject({ status: 409 });
  });
});
