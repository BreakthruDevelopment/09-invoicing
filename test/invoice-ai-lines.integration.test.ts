/**
 * "Draft from notes" storage and "Add to invoice" against a real Postgres (TEST_DATABASE_URL): the rate comes from
 * the invoice's own client, amounts are re-derived on the server, only draft invoices the actor owns accept lines,
 * a saved draft is single-use (also under concurrency), the 20-draft retention, the period default, and no notes in
 * the logs.
 */
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_SAMPLE_NOTES } from "@/lib/ai/invoice-from-notes";
import { resetEnvCache } from "@/lib/env";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("add AI draft lines to an invoice (Postgres)", () => {
  let sql: postgres.Sql;
  let draftMod: typeof import("@/lib/invoice-draft");
  let invoices: typeof import("@/lib/invoices");
  let clients: typeof import("@/lib/clients");
  let money: typeof import("@/lib/money");
  let common: typeof import("@/lib/invoice-common");

  const alice = { id: "ial-alice", role: "user" as const };
  const bob = { id: "ial-bob", role: "user" as const };
  const admin = { id: "ial-admin", role: "admin" as const };
  const owners = [alice, bob, admin].map((u) => u.id);

  let acme: string; // Alice's client, $100/h
  let other: string; // Alice's second client
  let bobsClient: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.APP_URL = "http://localhost:3000";
    sql = postgres(url!, { max: 4, onnotice: () => {} });
    await sql`delete from "user" where id like 'ial-%'`;
    for (const u of [alice, bob, admin]) {
      await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.id + "@test.local"}, ${u.role})`;
    }
    draftMod = await import("@/lib/invoice-draft");
    invoices = await import("@/lib/invoices");
    clients = await import("@/lib/clients");
    money = await import("@/lib/money");
    common = await import("@/lib/invoice-common");
  });
  afterAll(async () => {
    await sql`delete from "user" where id like 'ial-%'`;
    await sql`delete from daily_usage where kind = 'ai'`;
    await sql.end();
  });
  beforeEach(async () => {
    vi.stubEnv("AI_PROVIDER", "demo");
    vi.stubEnv("AI_DAILY_CAP", "10000");
    vi.stubEnv("LOG_LEVEL", "info");
    resetEnvCache();
    await sql`delete from notes_draft where owner_id = any(${owners})`;
    await sql`delete from invoice where owner_id = any(${owners})`;
    await sql`delete from client where owner_id = any(${owners})`;
    await sql`delete from business_profile where owner_id = any(${owners})`;
    await sql`delete from rate_event where user_id = any(${owners})`;
    await sql`delete from daily_usage where kind = 'ai'`;
    acme = (await clients.createClient(alice, { name: "Acme", hourlyRateCents: 10_000 })).id;
    other = (await clients.createClient(alice, { name: "Other", hourlyRateCents: 7_500 })).id;
    bobsClient = (await clients.createClient(bob, { name: "Bob's client", hourlyRateCents: 5_000 })).id;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetEnvCache();
  });

  const manual = { kind: "expense" as const, description: "Domain", quantityX100: 100, unitPriceCents: 1_500 };
  const newInvoice = async (owner = alice, clientId: string | null = acme, extra: Record<string, unknown> = {}) =>
    (await invoices.createInvoice(owner, { clientId, lines: [manual], ...extra })).invoice;
  const draft = (owner = alice, clientId = acme) => draftMod.draftInvoiceFromNotes(owner, { notes: DEMO_SAMPLE_NOTES, clientId });
  const lineRows = (invoiceId: string) =>
    sql`select position, kind, description, quantity_x100, unit_price_cents, amount_cents::int as amount_cents, source from invoice_line where invoice_id = ${invoiceId} order by position`;

  it("saves the draft, and the lines land as source ai with amounts derived on the server", async () => {
    const d = await draft();
    expect(d.lines.map((l) => l.amountCents)).toEqual([60_000, 45_000]); // 6 h x $100, flat $450
    const inv = await newInvoice(alice, acme, { taxBp: 825 });
    const out = await draftMod.addDraftLinesToInvoice(alice, inv.id, { draftId: d.draftId, lineIndexes: [0, 1], version: inv.version });

    const rows = await lineRows(inv.id);
    expect(rows.map((r) => [r.position, r.source, r.kind, r.quantity_x100, r.unit_price_cents, r.amount_cents])).toEqual([
      [1, "manual", "expense", 100, 1_500, 1_500],
      [2, "ai", "hours", 600, 10_000, 60_000],
      [3, "ai", "fixed", 100, 45_000, 45_000],
    ]);
    const totals = money.computeTotals(
      rows.map((r) => ({ quantityX100: r.quantity_x100, unitPriceCents: r.unit_price_cents })),
      825,
    );
    expect(out.invoice).toMatchObject({ subtotalCents: 106_500, taxCents: totals.taxCents, totalCents: totals.totalCents, version: inv.version + 1 });
    expect(out.lines).toHaveLength(3);
  });

  it("adds only the picked lines, in draft order", async () => {
    const d = await draft();
    const inv = await newInvoice();
    await draftMod.addDraftLinesToInvoice(alice, inv.id, { draftId: d.draftId, lineIndexes: [1], version: inv.version });
    expect((await lineRows(inv.id)).map((r) => r.kind)).toEqual(["expense", "fixed"]);
  });

  it("takes the rate from the invoice's client row at add time, not from anything saved or sent", async () => {
    const d = await draft(); // drafted while the rate was $100/h
    await clients.updateClient(alice, acme, { hourlyRateCents: 12_000 });
    const inv = await newInvoice();
    await draftMod.addDraftLinesToInvoice(alice, inv.id, { draftId: d.draftId, lineIndexes: [0], version: inv.version });
    const rows = await lineRows(inv.id);
    expect(rows[1]).toMatchObject({ unit_price_cents: 12_000, amount_cents: 72_000 });
  });

  it("never accepts amounts, rates, sources, lines or totals from the browser", async () => {
    const d = await draft();
    const inv = await newInvoice();
    const base = { draftId: d.draftId, lineIndexes: [0], version: inv.version };
    for (const extra of [
      { clientRateCents: 1 },
      { unitPriceCents: 1 },
      { amountCents: 1 },
      { source: "manual" },
      { totalCents: 1 },
      { lines: [{ kind: "fixed", description: "x", quantityX100: 100, unitPriceCents: 1 }] },
    ]) {
      await expect(draftMod.addDraftLinesToInvoice(alice, inv.id, { ...base, ...extra })).rejects.toMatchObject({ name: "ZodError" });
    }
    await expect(draftMod.addDraftLinesToInvoice(alice, inv.id, { ...base, lineIndexes: [] })).rejects.toMatchObject({ name: "ZodError" });
    await expect(draftMod.addDraftLinesToInvoice(alice, inv.id, { ...base, lineIndexes: [0, 0] })).rejects.toMatchObject({ name: "ZodError" });
    await expect(draftMod.addDraftLinesToInvoice(alice, inv.id, { ...base, lineIndexes: [5] })).rejects.toMatchObject({ status: 400 });
    expect(await lineRows(inv.id)).toHaveLength(1);
    // None of the refusals used up the draft.
    const ok = await draftMod.addDraftLinesToInvoice(alice, inv.id, base);
    expect(ok.lines).toHaveLength(2);
  });

  it("the draft route refuses a rate from the browser and a client that isn't the caller's", async () => {
    await expect(draftMod.draftInvoiceFromNotes(alice, { notes: "6h", clientId: acme, clientRateCents: 99_999 })).rejects.toMatchObject({ name: "ZodError" });
    await expect(draftMod.draftInvoiceFromNotes(alice, { notes: "6h", clientRateCents: 100 })).rejects.toMatchObject({ name: "ZodError" });
    await expect(draftMod.draftInvoiceFromNotes(bob, { notes: "6h", clientId: acme })).rejects.toMatchObject({ status: 404 });
    await expect(draftMod.draftInvoiceFromNotes(admin, { notes: "6h", clientId: acme })).rejects.toMatchObject({ status: 404 });
    await expect(draftMod.draftInvoiceFromNotes(alice, { notes: "6h", clientId: bobsClient })).rejects.toMatchObject({ status: 404 });
    await clients.archiveClient(alice, other);
    await expect(draftMod.draftInvoiceFromNotes(alice, { notes: "6h", clientId: other })).rejects.toMatchObject({ status: 409 });
    // Refused before any AI slot or saved row.
    expect((await sql`select count(*)::int as n from rate_event where user_id = any(${owners}) and kind = 'ai'`)[0].n).toBe(0);
    expect((await sql`select count(*)::int as n from notes_draft where owner_id = any(${owners})`)[0].n).toBe(0);
  });

  it("only a draft invoice takes lines: sent, paid and void are 409 and unchanged", async () => {
    const d = await draft();
    for (const end of ["sent", "paid", "void"] as const) {
      const inv = await newInvoice();
      let v = inv.version;
      if (end !== "void") v = (await invoices.transitionInvoice(alice, inv.id, { to: "sent", version: v })).detail.invoice.version;
      if (end === "paid") v = (await invoices.recordManualPayment(alice, inv.id, { version: v })).invoice.version;
      if (end === "void") v = (await invoices.transitionInvoice(alice, inv.id, { to: "void", version: v, reason: "test" })).detail.invoice.version;
      await expect(draftMod.addDraftLinesToInvoice(alice, inv.id, { draftId: d.draftId, lineIndexes: [0], version: v })).rejects.toMatchObject({ status: 409 });
      expect(await lineRows(inv.id)).toHaveLength(1);
    }
    const [{ added_at }] = await sql`select added_at from notes_draft where id = ${d.draftId}`;
    expect(added_at).toBeNull();
  });

  it("other users and admin get 404 on the invoice and on the draft", async () => {
    const d = await draft();
    const inv = await newInvoice();
    const bobInv = await newInvoice(bob, bobsClient);
    const body = { draftId: d.draftId, lineIndexes: [0], version: inv.version };
    await expect(draftMod.addDraftLinesToInvoice(bob, inv.id, body)).rejects.toMatchObject({ status: 404 });
    await expect(draftMod.addDraftLinesToInvoice(admin, inv.id, body)).rejects.toMatchObject({ status: 404 });
    // Bob's own draft invoice, Alice's saved draft.
    await expect(draftMod.addDraftLinesToInvoice(bob, bobInv.id, { ...body, version: bobInv.version })).rejects.toMatchObject({ status: 404 });
    await expect(draftMod.addDraftLinesToInvoice(alice, "not-a-uuid", body)).rejects.toMatchObject({ status: 404 });
    await expect(draftMod.addDraftLinesToInvoice(alice, inv.id, { ...body, draftId: crypto.randomUUID() })).rejects.toMatchObject({ status: 404 });
    expect(await lineRows(inv.id)).toHaveLength(1);
    expect(await lineRows(bobInv.id)).toHaveLength(1);
  });

  it("a stale version is 409 and a good one bumps it by one", async () => {
    const d = await draft();
    const inv = await newInvoice();
    await expect(draftMod.addDraftLinesToInvoice(alice, inv.id, { draftId: d.draftId, lineIndexes: [0], version: inv.version + 1 })).rejects.toMatchObject({ status: 409 });
    await expect(draftMod.addDraftLinesToInvoice(alice, inv.id, { draftId: d.draftId, lineIndexes: [0], version: inv.version })).resolves.toMatchObject({
      invoice: { version: inv.version + 1 },
    });
    // The version it was drafted against is now stale.
    const d2 = await draft();
    await expect(draftMod.addDraftLinesToInvoice(alice, inv.id, { draftId: d2.draftId, lineIndexes: [0], version: inv.version })).rejects.toMatchObject({ status: 409 });
  });

  it("a saved draft is single-use", async () => {
    const d = await draft();
    const a = await newInvoice();
    const b = await newInvoice();
    const first = await draftMod.addDraftLinesToInvoice(alice, a.id, { draftId: d.draftId, lineIndexes: [0], version: a.version });
    await expect(draftMod.addDraftLinesToInvoice(alice, a.id, { draftId: d.draftId, lineIndexes: [0], version: first.invoice.version })).rejects.toMatchObject({ status: 409 });
    await expect(draftMod.addDraftLinesToInvoice(alice, b.id, { draftId: d.draftId, lineIndexes: [1], version: b.version })).rejects.toMatchObject({ status: 409 });
    expect(await lineRows(a.id)).toHaveLength(2);
    expect(await lineRows(b.id)).toHaveLength(1);
    const [row] = await sql`select added_at, added_invoice_id from notes_draft where id = ${d.draftId}`;
    expect(row.added_invoice_id).toBe(a.id);
  });

  it("concurrent adds of one draft: exactly one wins, whether to the same invoice or two", async () => {
    const d = await draft();
    const a = await newInvoice();
    const same = await Promise.allSettled(
      [0, 1, 2, 3].map(() => draftMod.addDraftLinesToInvoice(alice, a.id, { draftId: d.draftId, lineIndexes: [0, 1], version: a.version })),
    );
    expect(same.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(same.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason.status === 409)).toBe(true);
    expect(await lineRows(a.id)).toHaveLength(3);

    const d2 = await draft();
    const [b, c] = [await newInvoice(), await newInvoice()];
    const two = await Promise.allSettled([b, c].map((i) => draftMod.addDraftLinesToInvoice(alice, i.id, { draftId: d2.draftId, lineIndexes: [0, 1], version: i.version })));
    expect(two.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await lineRows(b.id)).length + (await lineRows(c.id)).length).toBe(2 + 2); // two manual lines plus the two added once
  });

  it("concurrent adds of different drafts to one invoice: version lets one through, totals stay right", async () => {
    const [d1, d2] = [await draft(), await draft()];
    const inv = await newInvoice();
    const res = await Promise.allSettled([d1, d2].map((d) => draftMod.addDraftLinesToInvoice(alice, inv.id, { draftId: d.draftId, lineIndexes: [0, 1], version: inv.version })));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rows = await lineRows(inv.id);
    const [stored] = await sql`select subtotal_cents::int as s, version from invoice where id = ${inv.id}`;
    expect(stored.s).toBe(rows.reduce((n, r) => n + r.amount_cents, 0));
    expect(stored.version).toBe(inv.version + 1);
  });

  it("needs a client on the invoice, and the same client the draft was made for", async () => {
    const d = await draft();
    const noClient = await newInvoice(alice, null);
    await expect(draftMod.addDraftLinesToInvoice(alice, noClient.id, { draftId: d.draftId, lineIndexes: [0], version: noClient.version })).rejects.toMatchObject({ status: 422 });
    const otherInv = await newInvoice(alice, other);
    await expect(draftMod.addDraftLinesToInvoice(alice, otherInv.id, { draftId: d.draftId, lineIndexes: [0], version: otherInv.version })).rejects.toMatchObject({ status: 422 });
    expect(await lineRows(otherInv.id)).toHaveLength(1);
  });

  it("refuses to go past 50 lines", async () => {
    const d = await draft();
    const full = (await invoices.createInvoice(alice, { clientId: acme, lines: Array.from({ length: 49 }, (_, i) => ({ ...manual, description: `L${i}` })) })).invoice;
    await expect(draftMod.addDraftLinesToInvoice(alice, full.id, { draftId: d.draftId, lineIndexes: [0, 1], version: full.version })).rejects.toMatchObject({ status: 409 });
    expect(await lineRows(full.id)).toHaveLength(49);
  });

  it("refuses a saved note with no drafted lines (like the demo seed's) and a draft that no longer verifies", async () => {
    const [seeded] = await sql`insert into notes_draft (owner_id, client_id, notes, mode) values (${alice.id}, ${acme}, ${DEMO_SAMPLE_NOTES}, 'demo') returning id`;
    const inv = await newInvoice();
    await expect(draftMod.addDraftLinesToInvoice(alice, inv.id, { draftId: seeded.id, lineIndexes: [0], version: inv.version })).rejects.toMatchObject({ status: 409 });

    const d = await draft();
    await sql`update notes_draft set notes = replace(notes, '6h', '7h') where id = ${d.draftId}`; // the saved notes no longer back the saved answer
    await expect(draftMod.addDraftLinesToInvoice(alice, inv.id, { draftId: d.draftId, lineIndexes: [0], version: inv.version })).rejects.toMatchObject({ status: 409 });
    expect(await lineRows(inv.id)).toHaveLength(1);
  });

  it("keeps the last 20 saved drafts per owner and deletes older ones on insert", async () => {
    await sql`insert into notes_draft (owner_id, client_id, notes, created_at) values (${bob.id}, ${bobsClient}, 'bob keeps his', now() - interval '1 day')`;
    const ids: string[] = [];
    for (let i = 0; i < 23; i++) {
      await sql`delete from rate_event where user_id = ${alice.id}`; // stay under the 10 per hour cap for this test
      ids.push((await draft()).draftId);
    }
    const kept = (await sql`select id from notes_draft where owner_id = ${alice.id} order by created_at, id`).map((r) => r.id);
    expect(kept).toHaveLength(20);
    expect(kept).toContain(ids[22]);
    expect(kept).not.toContain(ids[0]);
    expect((await sql`select count(*)::int as n from notes_draft where owner_id = ${bob.id}`)[0].n).toBe(1);
  });

  it("defaults the period to the 7 days ending today in the owner's time zone, and checks one that's given", async () => {
    await sql`insert into business_profile (owner_id, time_zone) values (${alice.id}, 'Pacific/Auckland') on conflict (owner_id) do update set time_zone = 'Pacific/Auckland'`;
    const today = common.todayIn("Pacific/Auckland");
    const d = await draft();
    expect(d.period).toEqual({ from: common.addDays(today, -6), to: today });
    const [saved] = await sql`select data->'period' as period from notes_draft where id = ${d.draftId}`;
    expect(saved.period).toEqual(d.period);

    const given = await draftMod.draftInvoiceFromNotes(alice, { notes: DEMO_SAMPLE_NOTES, clientId: acme, period: { from: "2026-03-01", to: "2026-03-07" } });
    expect(given.period).toEqual({ from: "2026-03-01", to: "2026-03-07" });
    for (const period of [{ from: "2026-03-08", to: "2026-03-07" }, { from: "2026-02-30", to: "2026-03-07" }, { from: "2024-01-01", to: "2026-03-07" }, { from: "2026-03-01" }]) {
      await expect(draftMod.draftInvoiceFromNotes(alice, { notes: "6h", clientId: acme, period })).rejects.toMatchObject({ name: "ZodError" });
    }
  });

  it("never logs the notes, in either step", async () => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => void out.push(a.join(" ")));
    vi.spyOn(console, "warn").mockImplementation((...a) => void out.push(a.join(" ")));
    const notes = "Zebra-9Q-confidential 6h refactor of the vault module\nflat fee $450 for the Quokka audit";
    const d = await draftMod.draftInvoiceFromNotes(alice, { notes, clientId: acme });
    const inv = await newInvoice();
    await draftMod.addDraftLinesToInvoice(alice, inv.id, { draftId: d.draftId, lineIndexes: [0, 1], version: inv.version });
    await expect(draftMod.addDraftLinesToInvoice(alice, inv.id, { draftId: d.draftId, lineIndexes: [0], version: inv.version + 1 })).rejects.toBeTruthy();
    const logged = out.join("\n");
    expect(logged).toContain("invoice.draft");
    expect(logged).toContain("invoice.draft.added");
    for (const word of ["Zebra", "vault", "Quokka", "refactor"]) expect(logged).not.toContain(word);
  });
});
