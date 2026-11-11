/**
 * The invoicing data layer against a real Postgres (TEST_DATABASE_URL): ownership (owner, other user, admin), the
 * state machine and immutability, version locking, gapless numbering under concurrency, share tokens, money
 * stored as integer cents, caps, and what reaches the logs.
 */
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("invoicing data layer (Postgres)", () => {
  let sql: postgres.Sql;
  let clients: typeof import("@/lib/clients");
  let invoices: typeof import("@/lib/invoices");
  let share: typeof import("@/lib/share");
  let profileMod: typeof import("@/lib/business-profile");
  let stats: typeof import("@/lib/admin-stats");
  let money: typeof import("@/lib/money");
  let common: typeof import("@/lib/invoice-common");

  const alice = { id: "ic-alice", role: "user" as const };
  const bob = { id: "ic-bob", role: "user" as const };
  const admin = { id: "ic-admin", role: "admin" as const };
  const ids = [alice, bob, admin].map((u) => u.id);

  const line = (over: Partial<{ kind: "hours" | "fixed" | "expense"; description: string; quantityX100: number; unitPriceCents: number }> = {}) => ({
    kind: "hours" as const,
    description: "Design work",
    quantityX100: 350,
    unitPriceCents: 10_000,
    ...over,
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.APP_URL = "http://localhost:3000";
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    await sql`delete from "user" where id like 'ic-%'`;
    for (const u of [alice, bob, admin]) {
      await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.id + "@test.local"}, ${u.role})`;
    }
    clients = await import("@/lib/clients");
    invoices = await import("@/lib/invoices");
    share = await import("@/lib/share");
    profileMod = await import("@/lib/business-profile");
    stats = await import("@/lib/admin-stats");
    money = await import("@/lib/money");
    common = await import("@/lib/invoice-common");
  });
  afterAll(async () => {
    await sql`delete from "user" where id like 'ic-%'`;
    await sql.end();
  });
  beforeEach(async () => {
    // Order matters: invoices before clients (composite foreign key).
    await sql`delete from invoice where owner_id = any(${ids})`;
    await sql`delete from client where owner_id = any(${ids})`;
    await sql`delete from business_profile where owner_id = any(${ids})`;
    await sql`delete from rate_event where user_id = any(${ids})`;
  });

  const newClient = (actor: { id: string; role: "user" | "admin" } = alice, over: Record<string, unknown> = {}) =>
    clients.createClient(actor, { name: "Northwind", email: "ap@northwind.example", address: "1 Main St", hourlyRateCents: 9_500, ...over });

  /** A draft with a client and one line; returns the detail. */
  async function draft(actor: { id: string; role: "user" | "admin" } = alice, over: Record<string, unknown> = {}) {
    const c = await newClient(actor);
    return invoices.createInvoice(actor, { clientId: c.id, lines: [line()], ...over });
  }
  async function sent(actor: { id: string; role: "user" | "admin" } = alice, over: Record<string, unknown> = {}) {
    const d = await draft(actor, over);
    const r = await invoices.transitionInvoice(actor, d.invoice.id, { to: "sent", version: d.invoice.version });
    return { ...r, id: d.invoice.id };
  }

  describe("list search runs in SQL before the limit", () => {
    it("finds an old invoice beyond the limit, escapes wildcards, and stays owner-scoped", async () => {
      const old = await sent(alice);
      const oldNumber = old.detail.invoice.number as string;
      for (let i = 0; i < 3; i++) await draft(alice, { memo: `newer ${i}` });
      await sql`update invoice set created_at = now() - interval '1 day' where id = ${old.id}`;
      // Newest first with limit 2: the old invoice is not in the page without a search, and is found with one.
      expect((await invoices.listInvoices(alice, { limit: 2 })).map((i: { id: string }) => i.id)).not.toContain(old.id);
      const byNumber = await invoices.listInvoices(alice, { limit: 2, q: oldNumber.toLowerCase() });
      expect(byNumber.map((i: { id: string }) => i.id)).toEqual([old.id]);
      const byClient = await invoices.listInvoices(alice, { limit: 200, q: "NORTHW" });
      expect(byClient).toHaveLength(4);
      // "dra" matches drafts (shown as "Draft"); LIKE wildcards in the term are literal.
      expect(await invoices.listInvoices(alice, { q: "dra" })).toHaveLength(3);
      expect(await invoices.listInvoices(alice, { q: "%" })).toHaveLength(0);
      expect(await invoices.listInvoices(alice, { q: "_" })).toHaveLength(0);
      expect(await invoices.listInvoices(alice, { q: "x'; drop table invoice;--" })).toHaveLength(0);
      await expect(invoices.listInvoices(alice, { q: "a".repeat(101) })).rejects.toBeTruthy();
      // Another user and an admin never see alice's rows, search or not.
      expect(await invoices.listInvoices(bob, { q: "NORTHW" })).toHaveLength(0);
      expect(await invoices.listInvoices(admin, { q: oldNumber })).toHaveLength(0);
    });
  });

  describe("ownership: owner allowed, other user 404, admin 404", () => {
    it("clients", async () => {
      const c = await newClient();
      expect((await clients.getClient(alice, c.id)).name).toBe("Northwind");
      for (const stranger of [bob, admin]) {
        await expect(clients.getClient(stranger, c.id)).rejects.toMatchObject({ status: 404 });
        await expect(clients.updateClient(stranger, c.id, { name: "Hacked" })).rejects.toMatchObject({ status: 404 });
        await expect(clients.archiveClient(stranger, c.id)).rejects.toMatchObject({ status: 404 });
        expect(await clients.listClients(stranger)).toHaveLength(0);
      }
      expect((await clients.getClient(alice, c.id)).name).toBe("Northwind");
      expect((await clients.listClients(alice)).map((x) => x.id)).toEqual([c.id]);
    });

    it("invoices: read, edit, delete, transition, pay, share, duplicate", async () => {
      const s = await sent();
      const d = await draft();
      for (const stranger of [bob, admin]) {
        await expect(invoices.getInvoice(stranger, s.id)).rejects.toMatchObject({ status: 404 });
        await expect(invoices.updateInvoice(stranger, d.invoice.id, { version: 1, memo: "x" })).rejects.toMatchObject({ status: 404 });
        await expect(invoices.deleteInvoice(stranger, d.invoice.id)).rejects.toMatchObject({ status: 404 });
        await expect(invoices.transitionInvoice(stranger, d.invoice.id, { to: "sent", version: 1 })).rejects.toMatchObject({ status: 404 });
        await expect(invoices.transitionInvoice(stranger, d.invoice.id, { to: "void", version: 1, reason: "x" })).rejects.toMatchObject({ status: 404 });
        await expect(invoices.recordManualPayment(stranger, s.id, { version: 2 })).rejects.toMatchObject({ status: 404 });
        await expect(share.rotateShareToken(stranger, s.id)).rejects.toMatchObject({ status: 404 });
        await expect(share.revokeShareToken(stranger, s.id)).rejects.toMatchObject({ status: 404 });
        await expect(invoices.duplicateInvoice(stranger, s.id)).rejects.toMatchObject({ status: 404 });
        expect(await invoices.listInvoices(stranger)).toHaveLength(0);
      }
      // Nothing changed for the owner, and the original share link still works.
      expect((await invoices.getInvoice(alice, s.id)).invoice.status).toBe("sent");
      expect((await invoices.getInvoice(alice, d.invoice.id)).invoice.memo).toBe("");
      expect(await invoices.listInvoices(alice)).toHaveLength(2);
      expect(await share.resolveShareToken(s.shareToken)).not.toBeNull();
    });

    it("a stranger can't attach their invoice to someone else's client, and ids that aren't UUIDs are 404", async () => {
      const c = await newClient(alice);
      await expect(invoices.createInvoice(bob, { clientId: c.id })).rejects.toMatchObject({ status: 404 });
      await expect(invoices.createInvoice(admin, { clientId: c.id })).rejects.toMatchObject({ status: 404 });
      await expect(invoices.getInvoice(alice, "not-a-uuid")).rejects.toMatchObject({ status: 404 });
      await expect(clients.getClient(alice, "../etc")).rejects.toMatchObject({ status: 404 });
      // The composite foreign key is the backstop if a bug ever skipped the check.
      await expect(
        sql`insert into invoice (owner_id, client_id, issue_date, due_date) values (${bob.id}, ${c.id}, '2026-01-01', '2026-01-15')`,
      ).rejects.toMatchObject({ code: "23503" });
    });

    it("an admin is an ordinary owner of their own rows and gets counts, never content", async () => {
      const mine = await draft(admin);
      expect((await invoices.getInvoice(admin, mine.invoice.id)).invoice.id).toBe(mine.invoice.id);
      await draft(alice);
      expect(await invoices.listInvoices(admin)).toHaveLength(1); // not alice's
      const s = await stats.getAdminStats(admin);
      expect(s.invoicesByStatus.draft).toBeGreaterThanOrEqual(2);
      expect(s.users).toBeGreaterThanOrEqual(3);
      expect(s.ai.dailyCap).toBeGreaterThan(0);
      expect(JSON.stringify(s)).not.toMatch(/ic-|Northwind|ap@/);
      await expect(stats.getAdminStats(alice)).rejects.toMatchObject({ status: 403 });
    });

    it("the business profile is per owner", async () => {
      await profileMod.updateProfile(alice, { name: "Alice Co", address: "", contactEmail: "a@example.com", timeZone: "UTC", defaultTermsDays: 30 });
      expect((await profileMod.getProfile(alice)).name).toBe("Alice Co");
      expect((await profileMod.getProfile(bob)).name).toBe("");
      expect((await profileMod.getProfile(admin)).name).toBe("");
    });
  });

  describe("money is computed on the server, in integer cents", () => {
    it("stores line amounts, subtotal, tax and total from money.ts", async () => {
      const d = await draft(alice, { taxBp: 825, lines: [line(), line({ kind: "expense", description: "Test device", quantityX100: 100, unitPriceCents: 12_900 }), line({ quantityX100: 150, unitPriceCents: 333 })] });
      const expected = money.computeTotals(d.lines, 825);
      expect(d.lines.map((l) => l.amountCents)).toEqual([35_000, 12_900, 500]);
      expect(d.invoice).toMatchObject({ subtotalCents: 48_400, taxCents: expected.taxCents, totalCents: expected.totalCents });
      expect(d.invoice.totalCents).toBe(d.invoice.subtotalCents + d.invoice.taxCents);
    });

    it("refuses client-supplied totals and recomputes when lines or tax change", async () => {
      await expect(invoices.createInvoice(alice, { totalCents: 1, lines: [line()] })).rejects.toMatchObject({ name: "ZodError" });
      await expect(invoices.createInvoice(alice, { lines: [{ ...line(), amountCents: 1 }] })).resolves.toBeTruthy(); // extra key on a line is dropped, not trusted
      const d = await draft();
      const u = await invoices.updateInvoice(alice, d.invoice.id, { version: d.invoice.version, taxBp: 1_000 });
      expect(u.invoice).toMatchObject({ subtotalCents: 35_000, taxCents: 3_500, totalCents: 38_500, version: d.invoice.version + 1 });
      const u2 = await invoices.updateInvoice(alice, d.invoice.id, { version: u.invoice.version, lines: [line({ quantityX100: 100, unitPriceCents: 1_000 })] });
      expect(u2.invoice).toMatchObject({ subtotalCents: 1_000, taxCents: 100, totalCents: 1_100 });
      expect(u2.lines).toHaveLength(1);
    });

    it("keeps the largest possible invoice exact (bigint columns)", async () => {
      const big = { quantityX100: 9_999_999, unitPriceCents: 10_000_000 };
      const lines = Array.from({ length: 50 }, (_, i) => line({ ...big, description: `L${i}` }));
      const d = await draft(alice, { taxBp: 3_000, lines });
      expect(d.lines).toHaveLength(50);
      expect(d.invoice.subtotalCents).toBe(50 * 999_999_900_000);
      expect(d.invoice.totalCents).toBe(d.invoice.subtotalCents + d.invoice.taxCents);
      const [row] = await sql`select subtotal_cents::text as s from invoice where id = ${d.invoice.id}`;
      expect(row.s).toBe(String(50 * 999_999_900_000));
    });

    it("validates every input with zod", async () => {
      const bad: unknown[] = [
        { lines: Array.from({ length: 51 }, () => line()) },
        { lines: [line({ quantityX100: 0 })] },
        { lines: [line({ quantityX100: 10_000_000 })] },
        { lines: [line({ quantityX100: 1.5 })] },
        { lines: [line({ unitPriceCents: -1 })] },
        { lines: [line({ unitPriceCents: 10_000_001 })] },
        { lines: [line({ description: "" })] },
        { lines: [line({ description: "x".repeat(301) })] },
        { lines: [line({ kind: "gift" as "hours" })] },
        { taxBp: 3_001 },
        { taxBp: -1 },
        { memo: "x".repeat(1_001) },
        { issueDate: "2026-02-30" },
        { dueDate: "tomorrow" },
        { clientId: "nope" },
      ];
      for (const input of bad) await expect(invoices.createInvoice(alice, input), JSON.stringify(input).slice(0, 60)).rejects.toMatchObject({ name: "ZodError" });
      await expect(invoices.createInvoice(alice, { issueDate: "2026-03-10", dueDate: "2026-03-01" })).rejects.toMatchObject({ status: 400 });
      await expect(clients.createClient(alice, { name: "" })).rejects.toMatchObject({ name: "ZodError" });
      await expect(clients.createClient(alice, { name: "x", hourlyRateCents: 100_001 })).rejects.toMatchObject({ name: "ZodError" });
      await expect(clients.createClient(alice, { name: "x", email: "not-an-email" })).rejects.toMatchObject({ name: "ZodError" });
      await expect(profileMod.updateProfile(alice, { name: "x", address: "", contactEmail: "", timeZone: "Mars/Base", defaultTermsDays: 14 })).rejects.toMatchObject({ name: "ZodError" });
      await expect(profileMod.updateProfile(alice, { name: "x", address: "", contactEmail: "", timeZone: "UTC", defaultTermsDays: 91 })).rejects.toMatchObject({ name: "ZodError" });
    });

    it("the database itself refuses inconsistent money", async () => {
      const d = await draft();
      await expect(sql`update invoice set total_cents = 5 where id = ${d.invoice.id}`).rejects.toMatchObject({ code: "23514" });
      await expect(sql`update invoice set status = 'sent' where id = ${d.invoice.id}`).rejects.toMatchObject({ code: "23514" }); // no number, snapshot or sent_at
      await expect(sql`update invoice set tax_bp = 3001 where id = ${d.invoice.id}`).rejects.toMatchObject({ code: "23514" });
    });
  });

  describe("state machine and immutability", () => {
    it("draft -> sent freezes the invoice: number, client snapshot, totals, share token", async () => {
      const c = await newClient(alice, { name: "Original Name" });
      const d = await invoices.createInvoice(alice, { clientId: c.id, taxBp: 500, lines: [line()] });
      expect(d.invoice.number).toBeNull();
      const r = await invoices.transitionInvoice(alice, d.invoice.id, { to: "sent", version: d.invoice.version });
      expect(r.shareToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(r.detail.invoice).toMatchObject({ status: "sent", number: "INV-0001", version: d.invoice.version + 1, hasShareLink: true });
      expect(r.detail.invoice.clientSnapshot).toEqual({ name: "Original Name", email: "ap@northwind.example", address: "1 Main St" });
      expect(r.detail.invoice.sentAt).toBeTruthy();
      // Changing the client afterwards doesn't touch the sent invoice's snapshot.
      await clients.updateClient(alice, c.id, { name: "Renamed", email: null });
      expect((await invoices.getInvoice(alice, d.invoice.id)).invoice.clientSnapshot).toMatchObject({ name: "Original Name", email: "ap@northwind.example" });
    });

    it("sent, paid and void invoices can't be edited, re-sent or deleted; the lines don't change", async () => {
      const s = await sent();
      const v = s.detail.invoice.version;
      const before = (await invoices.getInvoice(alice, s.id)).lines;
      const attempts: (() => Promise<unknown>)[] = [
        () => invoices.updateInvoice(alice, s.id, { version: v, memo: "sneaky" }),
        () => invoices.updateInvoice(alice, s.id, { version: v, lines: [line({ unitPriceCents: 1 })] }),
        () => invoices.updateInvoice(alice, s.id, { version: v, clientId: null }),
        () => invoices.updateInvoice(alice, s.id, { version: v, taxBp: 0 }),
        () => invoices.deleteInvoice(alice, s.id),
        () => invoices.transitionInvoice(alice, s.id, { to: "sent", version: v }),
      ];
      for (const a of attempts) await expect(a()).rejects.toMatchObject({ status: 409 });

      const paid = await invoices.recordManualPayment(alice, s.id, { version: v });
      expect(paid.invoice.status).toBe("paid");
      await expect(invoices.updateInvoice(alice, s.id, { version: paid.invoice.version, memo: "x" })).rejects.toMatchObject({ status: 409 });
      await expect(invoices.transitionInvoice(alice, s.id, { to: "void", version: paid.invoice.version, reason: "oops" })).rejects.toMatchObject({ status: 409 });
      await expect(invoices.recordManualPayment(alice, s.id, { version: paid.invoice.version })).rejects.toMatchObject({ status: 409 });
      await expect(invoices.deleteInvoice(alice, s.id)).rejects.toMatchObject({ status: 409 });

      const s2 = await sent();
      const voided = await invoices.transitionInvoice(alice, s2.id, { to: "void", version: s2.detail.invoice.version, reason: "Wrong client" });
      expect(voided.detail.invoice).toMatchObject({ status: "void", voidReason: "Wrong client", number: "INV-0002" });
      for (const to of ["sent", "void"] as const) {
        await expect(invoices.transitionInvoice(alice, s2.id, { to, version: voided.detail.invoice.version, reason: "again" })).rejects.toMatchObject({ status: 409 });
      }
      await expect(invoices.recordManualPayment(alice, s2.id, { version: voided.detail.invoice.version })).rejects.toMatchObject({ status: 409 });
      await expect(invoices.updateInvoice(alice, s2.id, { version: voided.detail.invoice.version, memo: "x" })).rejects.toMatchObject({ status: 409 });

      expect((await invoices.getInvoice(alice, s.id)).lines).toEqual(before);
      const [{ memo }] = await sql`select memo from invoice where id = ${s.id}`;
      expect(memo).toBe("");
    });

    it("a draft can be voided (with a reason) or deleted; there is no way to 'pay' a draft", async () => {
      const d1 = await draft();
      await expect(invoices.transitionInvoice(alice, d1.invoice.id, { to: "void", version: d1.invoice.version })).rejects.toMatchObject({ name: "ZodError" });
      await expect(invoices.transitionInvoice(alice, d1.invoice.id, { to: "void", version: d1.invoice.version, reason: "x".repeat(201) })).rejects.toMatchObject({ name: "ZodError" });
      await expect(invoices.transitionInvoice(alice, d1.invoice.id, { to: "paid", version: d1.invoice.version })).rejects.toMatchObject({ name: "ZodError" });
      await expect(invoices.recordManualPayment(alice, d1.invoice.id, { version: d1.invoice.version })).rejects.toMatchObject({ status: 409 });
      const v = await invoices.transitionInvoice(alice, d1.invoice.id, { to: "void", version: d1.invoice.version, reason: "Not needed" });
      expect(v.detail.invoice).toMatchObject({ status: "void", number: null });
      expect(v.shareToken).toBeUndefined();

      const d2 = await draft();
      await invoices.deleteInvoice(alice, d2.invoice.id);
      await expect(invoices.getInvoice(alice, d2.invoice.id)).rejects.toMatchObject({ status: 404 });
    });

    it("sending needs a client, a line and a total over zero (422), and a failed send takes no number", async () => {
      const noClient = await invoices.createInvoice(alice, { lines: [line()] });
      await expect(invoices.transitionInvoice(alice, noClient.invoice.id, { to: "sent", version: 1 })).rejects.toMatchObject({ status: 422 });
      const c = await newClient();
      const noLines = await invoices.createInvoice(alice, { clientId: c.id });
      await expect(invoices.transitionInvoice(alice, noLines.invoice.id, { to: "sent", version: 1 })).rejects.toMatchObject({ status: 422 });
      const zero = await invoices.createInvoice(alice, { clientId: c.id, lines: [line({ unitPriceCents: 0 })] });
      await expect(invoices.transitionInvoice(alice, zero.invoice.id, { to: "sent", version: 1 })).rejects.toMatchObject({ status: 422 });
      const ok = await invoices.createInvoice(alice, { clientId: c.id, lines: [line()] });
      const r = await invoices.transitionInvoice(alice, ok.invoice.id, { to: "sent", version: 1 });
      expect(r.detail.invoice.number).toBe("INV-0001");
    });

    it("a stale version is 409 on edit, send, void and payment; the current version works", async () => {
      const d = await draft();
      const v = d.invoice.version;
      const u = await invoices.updateInvoice(alice, d.invoice.id, { version: v, memo: "first" });
      await expect(invoices.updateInvoice(alice, d.invoice.id, { version: v, memo: "second" })).rejects.toMatchObject({ status: 409 });
      await expect(invoices.transitionInvoice(alice, d.invoice.id, { to: "sent", version: v })).rejects.toMatchObject({ status: 409 });
      await expect(invoices.transitionInvoice(alice, d.invoice.id, { to: "void", version: v, reason: "x" })).rejects.toMatchObject({ status: 409 });
      expect((await invoices.getInvoice(alice, d.invoice.id)).invoice.memo).toBe("first");
      const r = await invoices.transitionInvoice(alice, d.invoice.id, { to: "sent", version: u.invoice.version });
      await expect(invoices.recordManualPayment(alice, d.invoice.id, { version: u.invoice.version })).rejects.toMatchObject({ status: 409 });
      await expect(invoices.recordManualPayment(alice, d.invoice.id, { version: r.detail.invoice.version })).resolves.toBeTruthy();
    });

    it("sending a draft whose client was archived is refused (409) before a number is taken", async () => {
      const d = await draft();
      await clients.archiveClient(alice, d.invoice.clientId!);
      await expect(invoices.transitionInvoice(alice, d.invoice.id, { to: "sent", version: d.invoice.version })).rejects.toMatchObject({ status: 409 });
      const after = await invoices.getInvoice(alice, d.invoice.id);
      expect(after.invoice).toMatchObject({ status: "draft", number: null, hasShareLink: false });
      const rows = await sql`select next_number as next from business_profile where owner_id = ${alice.id}`;
      expect(rows[0]?.next ?? 1).toBe(1);
      // Voiding the draft is still allowed, and an active client still sends as INV-0001.
      const e = await draft();
      const sentOk = await invoices.transitionInvoice(alice, e.invoice.id, { to: "sent", version: e.invoice.version });
      expect(sentOk.detail.invoice.number).toBe("INV-0001");
      await expect(invoices.transitionInvoice(alice, d.invoice.id, { to: "void", version: d.invoice.version, reason: "client archived" })).resolves.toBeTruthy();
    });

    it("two racing sends of the same invoice: exactly one wins, one number is used", async () => {
      const d = await draft();
      const results = await Promise.allSettled([1, 2, 3, 4].map(() => invoices.transitionInvoice(alice, d.invoice.id, { to: "sent", version: d.invoice.version })));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ status: 409 });
      const [{ next }] = await sql`select next_number as next from business_profile where owner_id = ${alice.id}`;
      expect(next).toBe(2);
    });

    it("manual payment records the full balance once", async () => {
      const s = await sent(alice, { taxBp: 825 });
      const paid = await invoices.recordManualPayment(alice, s.id, { version: s.detail.invoice.version, note: "Cheque 1042" });
      expect(paid.invoice).toMatchObject({ status: "paid", paidCents: s.detail.invoice.totalCents });
      expect(paid.invoice.paidAt).toBeTruthy();
      expect(paid.payments).toHaveLength(1);
      expect(paid.payments[0]).toMatchObject({ method: "manual", amountCents: s.detail.invoice.totalCents, note: "Cheque 1042", flag: null });
    });

    it("duplicate makes a fresh draft from any state", async () => {
      const s = await sent(alice, { memo: "Thanks", taxBp: 700 });
      const dup = await invoices.duplicateInvoice(alice, s.id);
      expect(dup.invoice).toMatchObject({ status: "draft", number: null, memo: "Thanks", taxBp: 700, totalCents: s.detail.invoice.totalCents, hasShareLink: false });
      expect(dup.invoice.clientId).toBe(s.detail.invoice.clientId);
      expect(dup.lines.map((l) => l.description)).toEqual(["Design work"]);
    });

    it("archived clients keep their invoices but can't take new ones", async () => {
      const s = await sent();
      await clients.archiveClient(alice, s.detail.invoice.clientId!);
      expect(await clients.listClients(alice)).toHaveLength(0);
      expect(await clients.listClients(alice, { includeArchived: true })).toHaveLength(1);
      expect((await invoices.getInvoice(alice, s.id)).clientName).toBe("Northwind");
      await expect(invoices.createInvoice(alice, { clientId: s.detail.invoice.clientId })).rejects.toMatchObject({ status: 409 });
      await expect(clients.archiveClient(alice, s.detail.invoice.clientId!)).rejects.toMatchObject({ status: 404 });
      expect((await invoices.duplicateInvoice(alice, s.id)).invoice.clientId).toBeNull();
    });
  });

  describe("numbering", () => {
    it("10 concurrent sends get 10 distinct, consecutive numbers", async () => {
      const c = await newClient();
      const drafts = await Promise.all(Array.from({ length: 10 }, (_, i) => invoices.createInvoice(alice, { clientId: c.id, lines: [line({ description: `Job ${i}` })] })));
      const results = await Promise.all(drafts.map((d) => invoices.transitionInvoice(alice, d.invoice.id, { to: "sent", version: d.invoice.version })));
      const numbers = results.map((r) => r.detail.invoice.number!).sort();
      expect(numbers).toEqual(Array.from({ length: 10 }, (_, i) => `INV-${String(i + 1).padStart(4, "0")}`));
      expect(new Set(numbers).size).toBe(10);
      const [{ next }] = await sql`select next_number as next from business_profile where owner_id = ${alice.id}`;
      expect(next).toBe(11);
    });

    it("sends by different owners at once keep separate counters", async () => {
      const [a, b] = await Promise.all([draft(alice), draft(bob)]);
      const [ra, rb] = await Promise.all([
        invoices.transitionInvoice(alice, a.invoice.id, { to: "sent", version: a.invoice.version }),
        invoices.transitionInvoice(bob, b.invoice.id, { to: "sent", version: b.invoice.version }),
      ]);
      expect(ra.detail.invoice.number).toBe("INV-0001");
      expect(rb.detail.invoice.number).toBe("INV-0001");
    });

    it("deleting drafts and voiding drafts leaves no gap; a voided sent invoice keeps its number", async () => {
      const d1 = await draft();
      await invoices.deleteInvoice(alice, d1.invoice.id);
      const first = await sent();
      const dv = await draft();
      await invoices.transitionInvoice(alice, dv.invoice.id, { to: "void", version: dv.invoice.version, reason: "No" });
      const second = await sent();
      await invoices.transitionInvoice(alice, second.id, { to: "void", version: second.detail.invoice.version, reason: "Wrong" });
      const third = await sent();
      expect([first, second, third].map((s) => s.detail.invoice.number)).toEqual(["INV-0001", "INV-0002", "INV-0003"]);
      const rows = await sql`select number from invoice where owner_id = ${alice.id} and number is not null order by number`;
      expect(rows.map((r) => r.number)).toEqual(["INV-0001", "INV-0002", "INV-0003"]);
    });

    it("the database refuses a duplicate number for one owner", async () => {
      const s = await sent();
      const d = await draft();
      await expect(
        sql`update invoice set number = 'INV-0001', status = 'sent', client_snapshot = '{}', sent_at = now() where id = ${d.invoice.id}`,
      ).rejects.toMatchObject({ code: "23505" });
      expect(s.detail.invoice.number).toBe("INV-0001");
    });
  });

  describe("share links", () => {
    it("stores only the sha256 of the token and finds the invoice by it", async () => {
      const s = await sent();
      const token = s.shareToken!;
      const [row] = await sql`select * from invoice where id = ${s.id}`;
      expect(row.share_token_hash).toBe(share.hashShareToken(token));
      expect(row.share_token_hash).toMatch(/^[0-9a-f]{64}$/);
      // The token itself is nowhere in the row, any other table, or the owner's view of the invoice.
      expect(JSON.stringify(row)).not.toContain(token);
      expect(JSON.stringify(await invoices.getInvoice(alice, s.id))).not.toContain(token);
      expect(JSON.stringify(await invoices.getInvoice(alice, s.id))).not.toContain("shareTokenHash");
      const found = await share.resolveShareToken(token);
      expect(found?.id).toBe(s.id);
    });

    it("tokens are unguessable: 256 bits, all different", () => {
      const tokens = new Set(Array.from({ length: 200 }, () => share.generateShareToken()));
      expect(tokens.size).toBe(200);
      for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it("compares hashes in constant time", () => {
      const h = share.hashShareToken("a");
      expect(share.hashesEqual(h, h)).toBe(true);
      expect(share.hashesEqual(h, share.hashShareToken("b"))).toBe(false);
      expect(share.hashesEqual(h, h.slice(0, 63))).toBe(false);
      expect(share.hashesEqual(h, "")).toBe(false);
    });

    it("unknown, malformed, draft and never-sent tokens all resolve to nothing", async () => {
      const d = await draft();
      for (const t of [share.generateShareToken(), "", "short", "x".repeat(44), `${"a".repeat(42)}!`, null, undefined, 42, { toString: () => "x" }]) {
        expect(await share.resolveShareToken(t)).toBeNull();
        expect(await share.getPublicInvoice(t)).toBeNull();
      }
      // Even if a hash somehow sat on a draft, the draft isn't public.
      const token = share.generateShareToken();
      await sql`update invoice set share_token_hash = ${share.hashShareToken(token)} where id = ${d.invoice.id}`;
      expect(await share.resolveShareToken(token)).toBeNull();
      await expect(share.rotateShareToken(alice, d.invoice.id)).rejects.toMatchObject({ status: 409 });
    });

    it("rotating gives a new token and the old one 404s at once", async () => {
      const s = await sent();
      const { token } = await share.rotateShareToken(alice, s.id);
      expect(token).not.toBe(s.shareToken);
      expect(await share.resolveShareToken(s.shareToken)).toBeNull();
      expect(await share.getPublicInvoice(s.shareToken)).toBeNull();
      expect((await share.resolveShareToken(token))?.id).toBe(s.id);
      // Rotation doesn't change the invoice's version or content.
      expect((await invoices.getInvoice(alice, s.id)).invoice.version).toBe(s.detail.invoice.version);
    });

    it("revoking turns the link off; rotating brings a new one", async () => {
      const s = await sent();
      await share.revokeShareToken(alice, s.id);
      expect(await share.resolveShareToken(s.shareToken)).toBeNull();
      expect((await invoices.getInvoice(alice, s.id)).invoice.hasShareLink).toBe(false);
      const { token } = await share.rotateShareToken(alice, s.id);
      expect((await share.resolveShareToken(token))?.id).toBe(s.id);
    });

    it("paid and void invoices stay viewable at their link, with their status", async () => {
      const a = await sent();
      await invoices.recordManualPayment(alice, a.id, { version: a.detail.invoice.version });
      expect((await share.getPublicInvoice(a.shareToken))?.status).toBe("paid");
      const b = await sent();
      await invoices.transitionInvoice(alice, b.id, { to: "void", version: b.detail.invoice.version, reason: "Private reason" });
      const pub = await share.getPublicInvoice(b.shareToken);
      expect(pub?.status).toBe("void");
      expect(JSON.stringify(pub)).not.toContain("Private reason");
    });

    it("the public view has what the client page needs and no personal data beyond it", async () => {
      await profileMod.updateProfile(alice, { name: "Alice Design", address: "9 Secret Lane", contactEmail: "alice@private.example", timeZone: "UTC", defaultTermsDays: 14 });
      const c = await newClient(alice, { name: "Northwind Bakery", email: "ap@northwind.example", address: "1 Client Road" });
      const d = await invoices.createInvoice(alice, { clientId: c.id, taxBp: 1_000, memo: "Net 14", lines: [line()] });
      const r = await invoices.transitionInvoice(alice, d.invoice.id, { to: "sent", version: d.invoice.version });
      const pub = await share.getPublicInvoice(r.shareToken);
      expect(pub).toMatchObject({
        number: "INV-0001",
        status: "sent",
        overdue: false,
        businessName: "Alice Design",
        clientName: "Northwind Bakery",
        memo: "Net 14",
        subtotalCents: 35_000,
        taxCents: 3_500,
        totalCents: 38_500,
        balanceCents: 38_500,
      });
      expect(pub!.lines).toEqual([{ kind: "hours", description: "Design work", quantityX100: 350, unitPriceCents: 10_000, amountCents: 35_000 }]);
      const text = JSON.stringify(pub);
      for (const secret of ["ap@northwind.example", "1 Client Road", "9 Secret Lane", "alice@private.example", alice.id, d.invoice.id, c.id, "shareToken", "ownerId", "version"]) {
        expect(text, secret).not.toContain(secret);
      }
    });
  });

  describe("overdue is computed on read, in the owner's time zone", () => {
    it("sent and past due is overdue; draft, paid and not-yet-due are not", async () => {
      const today = common.todayIn("UTC");
      const yesterday = common.addDays(today, -1);
      const lateSent = await sent(alice, { issueDate: common.addDays(today, -10), dueDate: yesterday });
      const lateDraft = await draft(alice, { issueDate: common.addDays(today, -10), dueDate: yesterday });
      const latePaid = await sent(alice, { issueDate: common.addDays(today, -10), dueDate: yesterday });
      await invoices.recordManualPayment(alice, latePaid.id, { version: latePaid.detail.invoice.version });
      const future = await sent(alice, { dueDate: common.addDays(today, 5) });
      const view = async (id: string) => (await invoices.getInvoice(alice, id)).invoice.overdue;
      expect(await view(lateSent.id)).toBe(true);
      expect(await view(lateDraft.invoice.id)).toBe(false);
      expect(await view(latePaid.id)).toBe(false);
      expect(await view(future.id)).toBe(false);
      expect((await invoices.listInvoices(alice, { status: "overdue" })).map((i) => i.id)).toEqual([lateSent.id]);
      expect((await invoices.listInvoices(alice, { status: "sent" })).map((i) => i.id).sort()).toEqual([lateSent.id, future.id].sort());
      const summary = await invoices.getInvoiceSummary(alice);
      expect(summary.overdueCents).toBe(lateSent.detail.invoice.totalCents);
      expect(summary.outstandingCents).toBe(lateSent.detail.invoice.totalCents + future.detail.invoice.totalCents);
      expect(summary.paidThisMonthCents).toBe(latePaid.detail.invoice.totalCents);
      expect(summary.counts).toMatchObject({ draft: 1, sent: 2, paid: 1 });
    });

    it("the same due date is overdue in one time zone and not in another", async () => {
      const earliest = common.todayIn("Etc/GMT+12"); // UTC-12: the last place to reach today's date
      const east = { name: "East", address: "", contactEmail: "", timeZone: "Pacific/Kiritimati", defaultTermsDays: 14 }; // UTC+14
      const west = { ...east, name: "West", timeZone: "Etc/GMT+12" };
      await profileMod.updateProfile(alice, east);
      await profileMod.updateProfile(bob, west);
      const a = await sent(alice, { issueDate: common.addDays(earliest, -3), dueDate: earliest });
      const b = await sent(bob, { issueDate: common.addDays(earliest, -3), dueDate: earliest });
      expect((await invoices.getInvoice(alice, a.id)).invoice.overdue).toBe(true);
      expect((await invoices.getInvoice(bob, b.id)).invoice.overdue).toBe(false);
      expect((await share.getPublicInvoice(a.shareToken))?.overdue).toBe(true);
      expect((await share.getPublicInvoice(b.shareToken))?.overdue).toBe(false);
    });
  });

  describe("caps and rate limits", () => {
    it("300 writes per user per hour, then 429 with nothing written; other users are unaffected", async () => {
      await sql`insert into rate_event (user_id, kind) select ${alice.id}, 'api_write' from generate_series(1, 300)`;
      await expect(newClient(alice)).rejects.toMatchObject({ status: 429 });
      await expect(invoices.createInvoice(alice, {})).rejects.toMatchObject({ status: 429 });
      expect(await sql`select 1 from client where owner_id = ${alice.id}`).toHaveLength(0);
      expect(await sql`select 1 from invoice where owner_id = ${alice.id}`).toHaveLength(0);
      await expect(newClient(bob)).resolves.toBeTruthy();
      // Reads aren't charged.
      await expect(clients.listClients(alice)).resolves.toEqual([]);
    });

    it("a refused write isn't charged", async () => {
      const before = async () => Number((await sql`select count(*)::int as n from rate_event where user_id = ${alice.id}`)[0].n);
      const d = await draft();
      const n = await before();
      await expect(invoices.updateInvoice(alice, d.invoice.id, { version: 99, memo: "x" })).rejects.toMatchObject({ status: 409 });
      expect(await before()).toBe(n);
    });

    it("the 200-client cap counts archived clients too, so archiving frees no slot", async () => {
      await sql`insert into client (owner_id, name, archived_at) select ${alice.id}, 'old' || g, now() from generate_series(1, 150) g`;
      await sql`insert into client (owner_id, name) select ${alice.id}, 'c' || g from generate_series(1, 50) g`;
      await expect(newClient(alice)).rejects.toMatchObject({ status: 409 });
      const [active] = await clients.listClients(alice);
      await clients.archiveClient(alice, active.id);
      await expect(newClient(alice)).rejects.toMatchObject({ status: 409 });
      await sql`delete from client where owner_id = ${alice.id} and name = 'old1'`;
      await expect(newClient(alice)).resolves.toBeTruthy();
    });

    it("at most 200 active clients and 2,000 invoices", async () => {
      await sql`insert into client (owner_id, name) select ${alice.id}, 'c' || g from generate_series(1, 200) g`;
      await expect(newClient(alice)).rejects.toMatchObject({ status: 409 });
      await sql`insert into invoice (owner_id, issue_date, due_date) select ${bob.id}, '2026-01-01', '2026-01-15' from generate_series(1, 2000)`;
      await expect(invoices.createInvoice(bob, {})).rejects.toMatchObject({ status: 409 });
      await expect(invoices.createInvoice(alice, {})).resolves.toBeTruthy();
    });
  });

  describe("logs", () => {
    it("carry ids and codes, never names, emails, descriptions or the token", async () => {
      const out: string[] = [];
      vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
      vi.spyOn(console, "error").mockImplementation((...a) => void out.push(a.join(" ")));
      try {
        const c = await newClient(alice, { name: "Zebra Holdings", email: "zebra@private.example" });
        const d = await invoices.createInvoice(alice, { clientId: c.id, lines: [line({ description: "Confidential vault audit" })] });
        const r = await invoices.transitionInvoice(alice, d.invoice.id, { to: "sent", version: d.invoice.version });
        await invoices.recordManualPayment(alice, d.invoice.id, { version: r.detail.invoice.version, note: "Cheque from Zebra" });
        const logged = out.join("\n");
        expect(logged).toContain("invoice.sent");
        expect(logged).toContain("invoice.paid");
        for (const secret of ["Zebra", "zebra@private.example", "Confidential", "vault", r.shareToken!, "Cheque"]) expect(logged, secret).not.toContain(secret);
      } finally {
        vi.restoreAllMocks();
      }
    });
  });
});
