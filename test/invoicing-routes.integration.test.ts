/**
 * The HTTP layer over the invoicing data functions, against a real Postgres: sign-in, same-origin and body checks on
 * every mutation, 404s for other users and admins, the public share-link route, and the admin routes.
 */
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/rbac";

const current = vi.hoisted(() => ({ actor: null as null | { id: string; role: "user" | "admin"; name: string; email: string } }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: vi.fn(async () => {
    if (!current.actor) throw new UnauthorizedError();
    return current.actor;
  }),
  requireRole: vi.fn(async (role: string) => {
    if (!current.actor) throw new UnauthorizedError();
    if (role === "admin" && current.actor.role !== "admin") throw new ForbiddenError();
    return current.actor;
  }),
}));

const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:3000";

describe.skipIf(!url)("invoicing routes (Postgres)", () => {
  let sql: postgres.Sql;
  const who = (id: string, role: "user" | "admin" = "user") => ({ id, role, name: id, email: `${id}@test.local` });
  const alice = who("ir-alice");
  const bob = who("ir-bob");
  const admin = who("ir-admin", "admin");
  const ids = [alice, bob, admin].map((u) => u.id);

  const mod = {} as {
    clients: typeof import("@/app/api/clients/route");
    client: typeof import("@/app/api/clients/[id]/route");
    invoices: typeof import("@/app/api/invoices/route");
    invoice: typeof import("@/app/api/invoices/[id]/route");
    transition: typeof import("@/app/api/invoices/[id]/transition/route");
    payments: typeof import("@/app/api/invoices/[id]/payments/route");
    share: typeof import("@/app/api/invoices/[id]/share/route");
    duplicate: typeof import("@/app/api/invoices/[id]/duplicate/route");
    profile: typeof import("@/app/api/profile/route");
    pub: typeof import("@/app/api/public/invoices/[token]/route");
    stats: typeof import("@/app/api/admin/stats/route");
  };
  let limiter: typeof import("@/lib/ip-limit");

  const req = (method: string, body?: unknown, headers: Record<string, string> = { origin: ORIGIN }) =>
    new Request("http://localhost:3000/api/x", {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const json = async (res: Response) => (res.status === 204 ? null : res.json());

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.APP_URL = ORIGIN;
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await sql`delete from "user" where id like 'ir-%'`;
    for (const u of [alice, bob, admin]) await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.email}, ${u.role})`;
    mod.clients = await import("@/app/api/clients/route");
    mod.client = await import("@/app/api/clients/[id]/route");
    mod.invoices = await import("@/app/api/invoices/route");
    mod.invoice = await import("@/app/api/invoices/[id]/route");
    mod.transition = await import("@/app/api/invoices/[id]/transition/route");
    mod.payments = await import("@/app/api/invoices/[id]/payments/route");
    mod.share = await import("@/app/api/invoices/[id]/share/route");
    mod.duplicate = await import("@/app/api/invoices/[id]/duplicate/route");
    mod.profile = await import("@/app/api/profile/route");
    mod.pub = await import("@/app/api/public/invoices/[token]/route");
    mod.stats = await import("@/app/api/admin/stats/route");
    limiter = await import("@/lib/ip-limit");
  });
  afterAll(async () => {
    await sql`delete from "user" where id like 'ir-%'`;
    await sql.end();
  });
  beforeEach(async () => {
    current.actor = alice;
    limiter.resetPublicLimiter();
    await sql`delete from invoice where owner_id = any(${ids})`;
    await sql`delete from client where owner_id = any(${ids})`;
    await sql`delete from business_profile where owner_id = any(${ids})`;
    await sql`delete from rate_event where user_id = any(${ids})`;
  });

  async function makeSentInvoice() {
    const c = await json(await mod.clients.POST(req("POST", { name: "Northwind", email: "ap@northwind.example", hourlyRateCents: 9500 })));
    const created = await json(
      await mod.invoices.POST(req("POST", { clientId: c.client.id, taxBp: 825, lines: [{ kind: "hours", description: "Design", quantityX100: 350, unitPriceCents: 10_000 }] })),
    );
    const sent = await json(await mod.transition.POST(req("POST", { to: "sent", version: created.invoice.version }), ctx(created.invoice.id)));
    return { created, sent, id: created.invoice.id as string };
  }

  it("the main flow over HTTP: client, draft, totals from the server, send, share link, pay", async () => {
    const res = await mod.clients.POST(req("POST", { name: "Northwind", hourlyRateCents: 9500 }));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const { client } = await json(res);

    const draftRes = await mod.invoices.POST(
      req("POST", { clientId: client.id, taxBp: 825, lines: [{ kind: "hours", description: "Design", quantityX100: 350, unitPriceCents: 10_000 }, { kind: "expense", description: "Device", quantityX100: 100, unitPriceCents: 12_900 }] }),
    );
    expect(draftRes.status).toBe(201);
    const draft = await json(draftRes);
    expect(draft.invoice).toMatchObject({ status: "draft", number: null, subtotalCents: 47_900, taxCents: 3_952, totalCents: 51_852 });
    expect(draft.invoice).not.toHaveProperty("shareTokenHash");

    const patched = await json(await mod.invoice.PATCH(req("PATCH", { version: draft.invoice.version, memo: "Net 14" }), ctx(draft.invoice.id)));
    expect(patched.invoice).toMatchObject({ memo: "Net 14", version: draft.invoice.version + 1 });

    const sent = await json(await mod.transition.POST(req("POST", { to: "sent", version: patched.invoice.version }), ctx(draft.invoice.id)));
    expect(sent.invoice).toMatchObject({ status: "sent", number: "INV-0001" });
    expect(sent.shareUrl).toMatch(/^http:\/\/localhost:3000\/i\/[A-Za-z0-9_-]{43}$/);

    const edit = await mod.invoice.PATCH(req("PATCH", { version: sent.invoice.version, memo: "sneaky" }), ctx(draft.invoice.id));
    expect(edit.status).toBe(409);

    const token = sent.shareUrl.split("/i/")[1];
    const pub = await mod.pub.GET(new Request(`http://localhost:3000/api/public/invoices/${token}`), { params: Promise.resolve({ token }) });
    expect(pub.status).toBe(200);
    expect((await pub.json()).invoice).toMatchObject({ number: "INV-0001", status: "sent", clientName: "Northwind", totalCents: 51_852 });

    const paid = await json(await mod.payments.POST(req("POST", { version: sent.invoice.version, note: "Transfer" }), ctx(draft.invoice.id)));
    expect(paid.invoice.status).toBe("paid");
    expect(paid.payments).toHaveLength(1);

    const list = await json(await mod.invoices.GET(new Request("http://localhost:3000/api/invoices?status=paid")));
    expect(list.invoices.map((i: { id: string }) => i.id)).toEqual([draft.invoice.id]);
    expect((await mod.invoices.GET(new Request("http://localhost:3000/api/invoices?status=bogus"))).status).toBe(400);
  });

  it("signed-out callers get 401 on every route", async () => {
    current.actor = null;
    const id = "00000000-0000-4000-8000-000000000000";
    const calls: Response[] = [
      await mod.clients.GET(new Request("http://x")),
      await mod.clients.POST(req("POST", { name: "x" })),
      await mod.client.GET(req("GET"), ctx(id)),
      await mod.client.PATCH(req("PATCH", { name: "x" }), ctx(id)),
      await mod.client.DELETE(req("DELETE"), ctx(id)),
      await mod.invoices.GET(new Request("http://x")),
      await mod.invoices.POST(req("POST", {})),
      await mod.invoice.GET(req("GET"), ctx(id)),
      await mod.invoice.PATCH(req("PATCH", { version: 1 }), ctx(id)),
      await mod.invoice.DELETE(req("DELETE"), ctx(id)),
      await mod.transition.POST(req("POST", { to: "sent", version: 1 }), ctx(id)),
      await mod.payments.POST(req("POST", { version: 1 }), ctx(id)),
      await mod.share.POST(req("POST"), ctx(id)),
      await mod.share.DELETE(req("DELETE"), ctx(id)),
      await mod.duplicate.POST(req("POST"), ctx(id)),
      await mod.profile.GET(),
      await mod.profile.PUT(req("PUT", {})),
      await mod.stats.GET(),
    ];
    expect(calls.map((r) => r.status)).toEqual(calls.map(() => 401));
  });

  it("every mutation refuses a missing or foreign Origin (403) before doing anything", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    const bad: Record<string, string>[] = [{}, { origin: "https://evil.example" }];
    for (const headers of bad) {
      const calls: Response[] = [
        await mod.clients.POST(req("POST", { name: "x" }, headers)),
        await mod.client.PATCH(req("PATCH", { name: "x" }, headers), ctx(id)),
        await mod.client.DELETE(req("DELETE", undefined, headers), ctx(id)),
        await mod.invoices.POST(req("POST", {}, headers)),
        await mod.invoice.PATCH(req("PATCH", { version: 1 }, headers), ctx(id)),
        await mod.invoice.DELETE(req("DELETE", undefined, headers), ctx(id)),
        await mod.transition.POST(req("POST", { to: "sent", version: 1 }, headers), ctx(id)),
        await mod.payments.POST(req("POST", { version: 1 }, headers), ctx(id)),
        await mod.share.POST(req("POST", undefined, headers), ctx(id)),
        await mod.share.DELETE(req("DELETE", undefined, headers), ctx(id)),
        await mod.duplicate.POST(req("POST", undefined, headers), ctx(id)),
        await mod.profile.PUT(req("PUT", {}, headers)),
      ];
      expect(calls.map((r) => r.status)).toEqual(calls.map(() => 403));
    }
    expect(await sql`select 1 from client where owner_id = any(${ids})`).toHaveLength(0);
  });

  it("malformed, oversized and invalid bodies are 400 or 413, never 500", async () => {
    const raw = (body: string) => new Request("http://x", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body });
    expect((await mod.clients.POST(raw("{nope"))).status).toBe(400);
    expect((await mod.clients.POST(raw("x".repeat(40_000)))).status).toBe(413);
    const invalid = await mod.invoices.POST(req("POST", { lines: [{ kind: "hours", description: "x", quantityX100: -5, unitPriceCents: 1 }] }));
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).issues.length).toBeGreaterThan(0);
    expect((await mod.invoices.POST(req("POST", { totalCents: 5 }))).status).toBe(400);
    expect((await mod.transition.POST(req("POST", { to: "paid", version: 1 }), ctx("00000000-0000-4000-8000-000000000000"))).status).toBe(400);
  });

  it("another user and an admin get 404 on someone else's invoice, client, PDF-adjacent actions and share link", async () => {
    const { id, sent } = await makeSentInvoice();
    const clientId = sent.invoice.clientId as string;
    for (const stranger of [bob, admin]) {
      current.actor = stranger;
      const calls: Response[] = [
        await mod.invoice.GET(req("GET"), ctx(id)),
        await mod.invoice.PATCH(req("PATCH", { version: 1, memo: "x" }), ctx(id)),
        await mod.invoice.DELETE(req("DELETE"), ctx(id)),
        await mod.transition.POST(req("POST", { to: "void", version: 1, reason: "x" }), ctx(id)),
        await mod.payments.POST(req("POST", { version: 1 }), ctx(id)),
        await mod.share.POST(req("POST"), ctx(id)),
        await mod.share.DELETE(req("DELETE"), ctx(id)),
        await mod.duplicate.POST(req("POST"), ctx(id)),
        await mod.client.GET(req("GET"), ctx(clientId)),
        await mod.client.PATCH(req("PATCH", { name: "x" }), ctx(clientId)),
        await mod.client.DELETE(req("DELETE"), ctx(clientId)),
      ];
      expect(calls.map((r) => r.status)).toEqual(calls.map(() => 404));
      expect((await json(await mod.invoices.GET(new Request("http://x")))).invoices).toEqual([]);
      expect((await json(await mod.clients.GET(new Request("http://x")))).clients).toEqual([]);
    }
    current.actor = alice;
    expect((await json(await mod.invoice.GET(req("GET"), ctx(id)))).invoice.status).toBe("sent");
  });

  it("share: rotate returns a new URL once and the old link 404s; revoke turns it off", async () => {
    const { id, sent } = await makeSentInvoice();
    const oldToken = sent.shareUrl.split("/i/")[1];
    const get = (token: string) => mod.pub.GET(new Request("http://x"), { params: Promise.resolve({ token }) });
    expect((await get(oldToken)).status).toBe(200);
    const rotated = await json(await mod.share.POST(req("POST"), ctx(id)));
    const newToken = rotated.shareUrl.split("/i/")[1];
    expect(newToken).not.toBe(oldToken);
    expect((await get(oldToken)).status).toBe(404);
    expect((await get(newToken)).status).toBe(200);
    expect((await mod.share.DELETE(req("DELETE"), ctx(id))).status).toBe(204);
    expect((await get(newToken)).status).toBe(404);
  });

  describe("public share route", () => {
    const get = (token: string, ip = "9.9.9.9") =>
      mod.pub.GET(new Request("http://x", { headers: { "x-forwarded-for": ip } }), { params: Promise.resolve({ token }) });

    it("sets private, no-referrer, noindex headers on both the page data and the 404", async () => {
      const { sent } = await makeSentInvoice();
      for (const res of [await get(sent.shareUrl.split("/i/")[1]), await get("a".repeat(43))]) {
        expect(res.headers.get("cache-control")).toBe("private, no-store");
        expect(res.headers.get("referrer-policy")).toBe("no-referrer");
        expect(res.headers.get("x-robots-tag")).toBe("noindex");
      }
    });

    it("answers the same 404 for unknown, malformed and draft", async () => {
      current.actor = alice;
      const c = await json(await mod.clients.POST(req("POST", { name: "N" })));
      const d = await json(await mod.invoices.POST(req("POST", { clientId: c.client.id, lines: [{ kind: "fixed", description: "x", quantityX100: 100, unitPriceCents: 100 }] })));
      const token = "b".repeat(43);
      await sql`update invoice set share_token_hash = encode(sha256(${token}::bytea), 'hex') where id = ${d.invoice.id}`; // a draft, even with a hash
      const bodies = [];
      for (const t of [token, "c".repeat(43), "short", "..%2f..", "x".repeat(500)]) {
        const res = await get(t);
        expect(res.status).toBe(404);
        bodies.push(await res.text());
      }
      expect(new Set(bodies).size).toBe(1);
    });

    it("limits each IP to 60 requests a minute", async () => {
      const token = "d".repeat(43);
      for (let i = 0; i < 60; i++) expect((await get(token, "7.7.7.7")).status).toBe(404);
      const limited = await get(token, "7.7.7.7");
      expect(limited.status).toBe(429);
      expect(limited.headers.get("referrer-policy")).toBe("no-referrer");
      expect((await get(token, "6.6.6.6")).status).toBe(404);
    });
  });

  it("admin stats: counts for an admin, 403 for a user, and no content", async () => {
    await makeSentInvoice();
    current.actor = bob;
    expect((await mod.stats.GET()).status).toBe(403);
    current.actor = admin;
    const res = await mod.stats.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stats.invoicesByStatus.sent).toBeGreaterThanOrEqual(1);
    expect(Object.keys(body.stats.paymentsByMethod).sort()).toEqual(["demo", "manual", "stripe"]);
    expect(JSON.stringify(body)).not.toMatch(/Northwind|ir-alice|ap@/);
  });

  it("profile: read, update, validation", async () => {
    const got = await json(await mod.profile.GET());
    expect(got.profile).toMatchObject({ name: "", defaultTermsDays: 14, nextNumber: 1, timeZone: "UTC" });
    const put = await mod.profile.PUT(req("PUT", { name: "Alice Co", address: "1 St", contactEmail: "a@example.com", timeZone: "America/New_York", defaultTermsDays: 30 }));
    expect((await json(put)).profile).toMatchObject({ name: "Alice Co", timeZone: "America/New_York", defaultTermsDays: 30 });
    expect((await mod.profile.PUT(req("PUT", { name: "x", address: "", contactEmail: "bad", timeZone: "UTC", defaultTermsDays: 14 }))).status).toBe(400);
  });
});
