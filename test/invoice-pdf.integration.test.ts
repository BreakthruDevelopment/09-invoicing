/**
 * Invoice PDFs over HTTP, against Postgres: the owner download, the share-token download, and the access rules
 * (other user and admin 404, draft token 404, signed-out 401).
 */
import { PDFDocument } from "pdf-lib";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "@/lib/auth/rbac";
import { extractPdfText } from "./pdf-text";

const current = vi.hoisted(() => ({ actor: null as null | { id: string; role: "user" | "admin"; name: string; email: string } }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: vi.fn(async () => {
    if (!current.actor) throw new UnauthorizedError();
    return current.actor;
  }),
}));

const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:3000";

describe.skipIf(!url)("invoice PDF routes (Postgres)", () => {
  let sql: postgres.Sql;
  const who = (id: string, role: "user" | "admin" = "user") => ({ id, role, name: id, email: `${id}@test.local` });
  const alice = who("pdf-alice");
  const bob = who("pdf-bob");
  const admin = who("pdf-admin", "admin");
  const ids = [alice, bob, admin].map((u) => u.id);

  const mod = {} as {
    clients: typeof import("@/app/api/clients/route");
    invoices: typeof import("@/app/api/invoices/route");
    transition: typeof import("@/app/api/invoices/[id]/transition/route");
    pdf: typeof import("@/app/api/invoices/[id]/pdf/route");
    pub: typeof import("@/app/i/[token]/pdf/route");
    pubJson: typeof import("@/app/api/public/invoices/[token]/route");
  };
  let limiter: typeof import("@/lib/ip-limit");

  const req = (method: string, body?: unknown) =>
    new Request("http://localhost:3000/api/x", {
      method,
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const json = async (res: Response) => res.json();

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.APP_URL = ORIGIN;
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await sql`delete from "user" where id like 'pdf-%'`;
    for (const u of [alice, bob, admin]) await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.email}, ${u.role})`;
    mod.clients = await import("@/app/api/clients/route");
    mod.invoices = await import("@/app/api/invoices/route");
    mod.transition = await import("@/app/api/invoices/[id]/transition/route");
    mod.pdf = await import("@/app/api/invoices/[id]/pdf/route");
    mod.pub = await import("@/app/i/[token]/pdf/route");
    mod.pubJson = await import("@/app/api/public/invoices/[token]/route");
    limiter = await import("@/lib/ip-limit");
  });
  afterAll(async () => {
    await sql`delete from "user" where id like 'pdf-%'`;
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

  async function sendInvoice(description: string) {
    const c = await json(await mod.clients.POST(req("POST", { name: "Northwind", email: "ap@northwind.example", address: "9 Dock St", hourlyRateCents: 9500 })));
    const created = await json(
      await mod.invoices.POST(
        req("POST", {
          clientId: c.client.id,
          taxBp: 825,
          memo: "Net 14",
          lines: [{ kind: "hours", description, quantityX100: 350, unitPriceCents: 10_000 }],
        }),
      ),
    );
    const sent = await json(await mod.transition.POST(req("POST", { to: "sent", version: created.invoice.version }), ctx(created.invoice.id)));
    return { id: created.invoice.id as string, sent, token: (sent.shareUrl as string).split("/i/")[1] };
  }

  const ownerPdf = (id: string) => mod.pdf.GET(new Request("http://localhost:3000/api/invoices/" + id + "/pdf"), ctx(id));
  const tokenPdf = (token: string, ip = "203.0.113.10") =>
    mod.pub.GET(new Request("http://localhost:3000/i/" + token + "/pdf", { headers: { "x-forwarded-for": ip } }), { params: Promise.resolve({ token }) });

  it("the owner downloads a PDF named with the invoice number, and a draft is draft.pdf", async () => {
    const { id, sent, token } = await sendInvoice("Design <script>alert(1)</script> 😀");
    expect(sent.invoice.number).toBe("INV-0001");

    const draft = await json(await mod.invoices.POST(req("POST", { lines: [{ kind: "fixed", description: "Sketch", quantityX100: 100, unitPriceCents: 500 }] })));
    const draftPdf = await ownerPdf(draft.invoice.id);
    expect(draftPdf.status).toBe(200);
    expect(draftPdf.headers.get("content-disposition")).toBe('attachment; filename="draft.pdf"');

    const res = await ownerPdf(id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="INV-0001.pdf"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeLessThanOrEqual(3);
    const text = extractPdfText(bytes);
    expect(text).toContain("<script>alert(1)</script>");
    expect(text).toContain("?");
    expect(text).not.toContain("😀");
    expect(text).toContain("INV-0001");
    expect(text).toContain("9 Dock St"); // the owner's copy keeps the client's address
    expect(text).toContain("$350.00");
    expect(Buffer.from(bytes).includes(Buffer.from("😀", "utf8"))).toBe(false);

    const pub = await tokenPdf(token);
    expect(pub.status).toBe(200);
    expect(pub.headers.get("content-disposition")).toBe('attachment; filename="INV-0001.pdf"');
    expect(pub.headers.get("x-content-type-options")).toBe("nosniff");
    expect(pub.headers.get("cache-control")).toBe("private, no-store");
    expect(pub.headers.get("referrer-policy")).toBe("no-referrer");
    expect(pub.headers.get("x-robots-tag")).toBe("noindex");
    const pubBytes = new Uint8Array(await pub.arrayBuffer());
    const pubText = extractPdfText(pubBytes);
    expect(pubText).toContain("INV-0001");
    expect(pubText).toContain("<script>alert(1)</script>");
    expect(pubText).not.toContain("ap@northwind.example");
    expect(pubText).not.toContain("9 Dock St"); // no client address on the public copy
    expect(pubText).toContain("Northwind");
  });

  it("a signed-out caller gets 401, and another user and an admin get 404", async () => {
    const { id } = await sendInvoice("Design");
    current.actor = null;
    expect((await ownerPdf(id)).status).toBe(401);
    for (const stranger of [bob, admin]) {
      current.actor = stranger;
      const res = await ownerPdf(id);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.text()).not.toContain("%PDF");
    }
    current.actor = alice;
    expect((await ownerPdf(id)).status).toBe(200);
  });

  it("a draft token, an unknown token and a rotated token all 404 the same way", async () => {
    current.actor = alice;
    const c = await json(await mod.clients.POST(req("POST", { name: "N" })));
    const d = await json(await mod.invoices.POST(req("POST", { clientId: c.client.id, lines: [{ kind: "fixed", description: "x", quantityX100: 100, unitPriceCents: 100 }] })));
    const planted = "b".repeat(43);
    await sql`update invoice set share_token_hash = encode(sha256(${planted}::bytea), 'hex') where id = ${d.invoice.id}`;

    const { token, id } = await sendInvoice("Design");
    const bodies: string[] = [];
    for (const t of [planted, "c".repeat(43), "short", "..%2f..", "x".repeat(500)]) {
      const res = await tokenPdf(t);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
      expect(res.headers.get("content-disposition")).toBeNull();
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);

    const rotated = await json(await (await import("@/app/api/invoices/[id]/share/route")).POST(req("POST"), ctx(id)));
    const next = (rotated.shareUrl as string).split("/i/")[1];
    expect((await tokenPdf(token)).status).toBe(404);
    expect((await tokenPdf(next)).status).toBe(200);
  });

  it("counts toward the same 60-per-IP limit as the public invoice route", async () => {
    const ip = "203.0.113.55";
    const token = "d".repeat(43);
    const jsonGet = () =>
      mod.pubJson.GET(new Request("http://x", { headers: { "x-forwarded-for": ip } }), { params: Promise.resolve({ token }) });
    for (let i = 0; i < 59; i++) expect((await tokenPdf(token, ip)).status).toBe(404);
    expect((await jsonGet()).status).toBe(404);
    const limited = await tokenPdf(token, ip);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(limited.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await tokenPdf(token, "203.0.113.56")).status).toBe(404);
  });

  it("a 50-line invoice still downloads in 3 pages", async () => {
    const c = await json(await mod.clients.POST(req("POST", { name: "Northwind" })));
    const lines = Array.from({ length: 50 }, (_, i) => ({
      kind: "fixed" as const,
      description: `Line ${i + 1} ${"W".repeat(80)}`,
      quantityX100: 100,
      unitPriceCents: 100,
    }));
    const created = await json(await mod.invoices.POST(req("POST", { clientId: c.client.id, lines })));
    expect(created.invoice.totalCents).toBe(5_000);
    const sent = await json(await mod.transition.POST(req("POST", { to: "sent", version: created.invoice.version }), ctx(created.invoice.id)));
    const res = await ownerPdf(created.invoice.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${sent.invoice.number}.pdf"`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeLessThanOrEqual(3);
    expect(extractPdfText(bytes)).toContain("$50.00");
  });
});
