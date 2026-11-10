import "server-only";
import { type SQL, and, asc, count, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import type { Invoice, InvoiceLine, Payment } from "@/lib/db/schema";
import { ConflictError, NotFoundError, UnprocessableError, BadRequestError } from "@/lib/errors";
import { addDays, ensureProfile, parseId, todayIn, writeTx } from "@/lib/invoice-common";
import {
  MAX_INVOICES_PER_USER,
  type LineInput,
  invoiceCreateInput,
  invoicePatchInput,
  listQuery,
  manualPaymentInput,
  transitionInput,
} from "@/lib/invoice-schemas";
import { log } from "@/lib/log";
import { computeTotals } from "@/lib/money";
import { ownedBy } from "@/lib/owned";
import { generateShareToken, hashShareToken } from "@/lib/share";
import type { Tx } from "@/lib/usage";

const { invoice, invoiceLine, payment, client, businessProfile } = schema;

/**
 * An invoice as callers see it: the stored row without the share-token hash, plus what is computed on read.
 * `overdue` = sent and past its due date in the owner's time zone (no scheduler involved).
 */
export type InvoiceView = Omit<Invoice, "shareTokenHash"> & { overdue: boolean; hasShareLink: boolean };
export type InvoiceListItem = InvoiceView & { clientName: string | null };
export type InvoiceDetail = { invoice: InvoiceView; clientName: string | null; lines: InvoiceLine[]; payments: Payment[] };

type Reader = Pick<Tx, "select">;

function toView(row: Invoice, today: string): InvoiceView {
  const { shareTokenHash, ...rest } = row;
  return { ...rest, overdue: row.status === "sent" && row.dueDate < today, hasShareLink: shareTokenHash !== null };
}

async function ownerToday(reader: Reader, ownerId: string): Promise<string> {
  const [p] = await reader.select({ tz: businessProfile.timeZone }).from(businessProfile).where(eq(businessProfile.ownerId, ownerId));
  return todayIn(p?.tz ?? "UTC");
}

export function formatInvoiceNumber(n: number): string {
  return `INV-${String(n).padStart(4, "0")}`;
}

/** The one way to load an owner's invoice. Other users, admins and unknown ids all get the same 404. */
async function loadOwned(tx: Reader, actor: Actor, id: string, lock = false): Promise<Invoice> {
  const q = tx.select().from(invoice).where(ownedBy(invoice, actor, eq(invoice.id, id)));
  const [row] = await (lock ? q.for("update") : q);
  if (!row) throw new NotFoundError("Invoice not found");
  assertCan(actor, "read", row);
  return row;
}

async function loadDraftForUpdate(tx: Tx, actor: Actor, id: string, version: number): Promise<Invoice> {
  const row = await loadOwned(tx, actor, id, true);
  assertCan(actor, "update", row);
  if (row.status !== "draft") throw new ConflictError("A sent invoice can't be changed. Void it and duplicate it instead.");
  if (row.version !== version) throw new ConflictError("This invoice was changed somewhere else. Reload and try again.");
  return row;
}

async function assertUsableClient(tx: Reader, actor: Actor, clientId: string): Promise<void> {
  const [c] = await tx.select({ archivedAt: client.archivedAt }).from(client).where(ownedBy(client, actor, eq(client.id, clientId)));
  if (!c) throw new NotFoundError("Client not found");
  if (c.archivedAt) throw new ConflictError("That client is archived.");
}

async function writeLines(tx: Tx, ownerId: string, invoiceId: string, lines: LineInput[], amounts: number[]): Promise<void> {
  await tx.delete(invoiceLine).where(and(eq(invoiceLine.invoiceId, invoiceId), eq(invoiceLine.ownerId, ownerId)));
  if (lines.length === 0) return;
  await tx.insert(invoiceLine).values(lines.map((l, i) => ({ ...l, invoiceId, ownerId, position: i + 1, amountCents: amounts[i] })));
}

function checkDates(issueDate: string, dueDate: string): void {
  if (dueDate < issueDate) throw new BadRequestError("The due date can't be before the issue date.");
}

async function insertDraft(
  tx: Tx,
  actor: Actor,
  input: { clientId?: string | null; issueDate?: string; dueDate?: string; taxBp: number; memo: string; lines: LineInput[] },
): Promise<Invoice> {
  const [{ n }] = await tx.select({ n: count() }).from(invoice).where(ownedBy(invoice, actor));
  if (n >= MAX_INVOICES_PER_USER) throw new ConflictError(`You can have up to ${MAX_INVOICES_PER_USER} invoices.`);
  if (input.clientId) await assertUsableClient(tx, actor, input.clientId);
  const profile = await ensureProfile(tx, actor.id);
  const issueDate = input.issueDate ?? todayIn(profile.timeZone);
  const dueDate = input.dueDate ?? addDays(issueDate, profile.defaultTermsDays);
  checkDates(issueDate, dueDate);
  const totals = computeTotals(input.lines, input.taxBp);
  const [row] = await tx
    .insert(invoice)
    .values({
      ownerId: actor.id,
      clientId: input.clientId ?? null,
      issueDate,
      dueDate,
      taxBp: input.taxBp,
      memo: input.memo,
      subtotalCents: totals.subtotalCents,
      taxCents: totals.taxCents,
      totalCents: totals.totalCents,
    })
    .returning();
  await writeLines(tx, actor.id, row.id, input.lines, totals.lineAmounts);
  return row;
}

export async function listInvoices(actor: Actor, rawQuery: unknown = {}): Promise<InvoiceListItem[]> {
  assertCan(actor, "create");
  const q = listQuery.parse(rawQuery);
  const today = await ownerToday(db(), actor.id);
  const conds: (SQL | undefined)[] = [];
  if (q.status === "overdue") conds.push(eq(invoice.status, "sent"), lt(invoice.dueDate, today));
  else if (q.status) conds.push(eq(invoice.status, q.status));
  if (q.clientId) conds.push(eq(invoice.clientId, q.clientId));
  const rows = await db()
    .select({ inv: invoice, clientName: client.name })
    .from(invoice)
    .leftJoin(client, and(eq(client.id, invoice.clientId), eq(client.ownerId, invoice.ownerId)))
    .where(ownedBy(invoice, actor, ...conds))
    .orderBy(desc(invoice.createdAt), desc(invoice.id))
    .limit(q.limit);
  return rows.map((r) => ({ ...toView(r.inv, today), clientName: r.clientName }));
}

export async function getInvoice(actor: Actor, id: string): Promise<InvoiceDetail> {
  const invoiceId = parseId(id, "Invoice");
  const row = await loadOwned(db(), actor, invoiceId);
  const [today, lines, payments, [c]] = await Promise.all([
    ownerToday(db(), actor.id),
    db().select().from(invoiceLine).where(eq(invoiceLine.invoiceId, row.id)).orderBy(asc(invoiceLine.position)),
    db().select().from(payment).where(eq(payment.invoiceId, row.id)).orderBy(asc(payment.receivedAt)),
    row.clientId ? db().select({ name: client.name }).from(client).where(eq(client.id, row.clientId)) : Promise.resolve([]),
  ]);
  return { invoice: toView(row, today), clientName: c?.name ?? null, lines, payments };
}

export async function createInvoice(actor: Actor, raw: unknown): Promise<InvoiceDetail> {
  assertCan(actor, "create");
  const input = invoiceCreateInput.parse(raw);
  const row = await writeTx(actor, (tx) => insertDraft(tx, actor, input));
  return getInvoice(actor, row.id);
}

/** Copy an invoice (any state) into a new draft: same client (if still active), lines, tax and memo; fresh dates. */
export async function duplicateInvoice(actor: Actor, id: string): Promise<InvoiceDetail> {
  const invoiceId = parseId(id, "Invoice");
  const row = await writeTx(actor, async (tx) => {
    const source = await loadOwned(tx, actor, invoiceId);
    const lines = await tx.select().from(invoiceLine).where(eq(invoiceLine.invoiceId, source.id)).orderBy(asc(invoiceLine.position));
    let clientId: string | null = null;
    if (source.clientId) {
      const [c] = await tx.select({ archivedAt: client.archivedAt }).from(client).where(ownedBy(client, actor, eq(client.id, source.clientId)));
      clientId = c && !c.archivedAt ? source.clientId : null;
    }
    return insertDraft(tx, actor, {
      clientId,
      taxBp: source.taxBp,
      memo: source.memo,
      lines: lines.map((l) => ({ kind: l.kind, description: l.description, quantityX100: l.quantityX100, unitPriceCents: l.unitPriceCents, source: l.source })),
    });
  });
  return getInvoice(actor, row.id);
}

/** Edit a draft. Needs the current `version`; a sent, paid or void invoice is refused (409), whoever asks. */
export async function updateInvoice(actor: Actor, id: string, raw: unknown): Promise<InvoiceDetail> {
  const invoiceId = parseId(id, "Invoice");
  const input = invoicePatchInput.parse(raw);
  await writeTx(actor, async (tx) => {
    const row = await loadDraftForUpdate(tx, actor, invoiceId, input.version);
    if (input.clientId) await assertUsableClient(tx, actor, input.clientId);
    const issueDate = input.issueDate ?? row.issueDate;
    const dueDate = input.dueDate ?? row.dueDate;
    checkDates(issueDate, dueDate);
    const taxBp = input.taxBp ?? row.taxBp;

    let lines: LineInput[];
    if (input.lines) lines = input.lines;
    else {
      const existing = await tx.select().from(invoiceLine).where(eq(invoiceLine.invoiceId, row.id)).orderBy(asc(invoiceLine.position));
      lines = existing.map((l) => ({ kind: l.kind, description: l.description, quantityX100: l.quantityX100, unitPriceCents: l.unitPriceCents, source: l.source }));
    }
    const totals = computeTotals(lines, taxBp);
    if (input.lines) await writeLines(tx, actor.id, row.id, lines, totals.lineAmounts);
    await tx
      .update(invoice)
      .set({
        clientId: input.clientId === undefined ? row.clientId : input.clientId,
        issueDate,
        dueDate,
        taxBp,
        memo: input.memo ?? row.memo,
        subtotalCents: totals.subtotalCents,
        taxCents: totals.taxCents,
        totalCents: totals.totalCents,
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(invoice.id, row.id));
  });
  return getInvoice(actor, invoiceId);
}

/** Only drafts can be deleted (they have no number, so no gap is left). */
export async function deleteInvoice(actor: Actor, id: string): Promise<void> {
  const invoiceId = parseId(id, "Invoice");
  await writeTx(actor, async (tx) => {
    const row = await loadOwned(tx, actor, invoiceId, true);
    assertCan(actor, "delete", row);
    if (row.status !== "draft") throw new ConflictError("Only a draft can be deleted. Void a sent invoice instead.");
    await tx.delete(invoice).where(eq(invoice.id, row.id)); // lines cascade
  });
}

export type TransitionResult = { detail: InvoiceDetail; shareToken?: string };

/**
 * The state machine, enforced here and nowhere else:
 * draft -> sent (a client, at least one line, total over zero; takes the next number; snapshots the client; makes the
 * share token), draft | sent -> void (a reason), sent -> paid (see `payInvoice`). paid and void are final.
 * The invoice row is locked for the whole transaction and `version` must match, so two racing requests can't both win.
 */
export async function transitionInvoice(actor: Actor, id: string, raw: unknown): Promise<TransitionResult> {
  const invoiceId = parseId(id, "Invoice");
  const input = transitionInput.parse(raw);
  let shareToken: string | undefined;

  await writeTx(actor, async (tx) => {
    const row = await loadOwned(tx, actor, invoiceId, true);
    assertCan(actor, "update", row);
    if (row.version !== input.version) throw new ConflictError("This invoice was changed somewhere else. Reload and try again.");
    const allowed = input.to === "sent" ? row.status === "draft" : row.status === "draft" || row.status === "sent";
    if (!allowed) throw new ConflictError(`A ${row.status} invoice can't be ${input.to === "sent" ? "sent" : "voided"}.`);

    if (input.to === "void") {
      await tx
        .update(invoice)
        .set({ status: "void", voidReason: input.reason, voidedAt: new Date(), version: row.version + 1, updatedAt: new Date() })
        .where(eq(invoice.id, row.id));
      log.info("invoice.voided", { invoiceId: row.id, from: row.status });
      return;
    }

    // draft -> sent
    if (!row.clientId) throw new UnprocessableError("Choose a client before sending.");
    const lines = await tx.select().from(invoiceLine).where(eq(invoiceLine.invoiceId, row.id)).orderBy(asc(invoiceLine.position));
    const totals = computeTotals(lines, row.taxBp); // recomputed from the stored lines, never trusted from the row
    if (lines.length === 0 || totals.totalCents <= 0) throw new UnprocessableError("Add at least one line with an amount before sending.");
    const [c] = await tx.select().from(client).where(ownedBy(client, actor, eq(client.id, row.clientId)));
    if (!c) throw new NotFoundError("Client not found");

    // Gap-free numbering: the counter row is locked until this transaction ends, so concurrent sends take
    // consecutive numbers one at a time, and a rollback gives the number back.
    await ensureProfile(tx, actor.id);
    const [profile] = await tx.select().from(businessProfile).where(eq(businessProfile.ownerId, actor.id)).for("update");
    await tx.update(businessProfile).set({ nextNumber: profile.nextNumber + 1, updatedAt: new Date() }).where(eq(businessProfile.ownerId, actor.id));

    shareToken = generateShareToken();
    await tx
      .update(invoice)
      .set({
        status: "sent",
        number: formatInvoiceNumber(profile.nextNumber),
        clientSnapshot: { name: c.name, email: c.email, address: c.address },
        subtotalCents: totals.subtotalCents,
        taxCents: totals.taxCents,
        totalCents: totals.totalCents,
        shareTokenHash: hashShareToken(shareToken),
        sentAt: new Date(),
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(invoice.id, row.id));
    log.info("invoice.sent", { invoiceId: row.id });
  });

  return { detail: await getInvoice(actor, invoiceId), shareToken };
}

export type PaymentParams = { method: "demo" | "stripe" | "manual"; note?: string; stripeSessionId?: string; expectedVersion?: number };

/**
 * Record the full balance and mark a sent invoice paid, in the caller's transaction with the row already locked.
 * Shared by the owner's manual record and (issue 9.2) the demo provider and the signed webhook.
 */
export async function markPaidInTx(tx: Tx, row: Invoice, params: PaymentParams): Promise<void> {
  if (row.status !== "sent") throw new ConflictError(`A ${row.status} invoice can't take a payment.`);
  if (params.expectedVersion !== undefined && row.version !== params.expectedVersion) {
    throw new ConflictError("This invoice was changed somewhere else. Reload and try again.");
  }
  const balance = row.totalCents - row.paidCents;
  await tx.insert(payment).values({
    invoiceId: row.id,
    ownerId: row.ownerId,
    method: params.method,
    amountCents: balance,
    stripeSessionId: params.stripeSessionId,
    note: params.note ?? "",
  });
  await tx
    .update(invoice)
    .set({ status: "paid", paidCents: row.totalCents, paidAt: new Date(), version: row.version + 1, updatedAt: new Date() })
    .where(eq(invoice.id, row.id));
  log.info("invoice.paid", { invoiceId: row.id, method: params.method });
}

/** The owner records that the full balance was paid some other way (cheque, transfer). */
export async function recordManualPayment(actor: Actor, id: string, raw: unknown): Promise<InvoiceDetail> {
  const invoiceId = parseId(id, "Invoice");
  const input = manualPaymentInput.parse(raw);
  await writeTx(actor, async (tx) => {
    const row = await loadOwned(tx, actor, invoiceId, true);
    assertCan(actor, "update", row);
    await markPaidInTx(tx, row, { method: "manual", note: input.note, expectedVersion: input.version });
  });
  return getInvoice(actor, invoiceId);
}

export type InvoiceSummary = { outstandingCents: number; overdueCents: number; paidThisMonthCents: number; counts: Record<string, number> };

/** Dashboard numbers for the caller's own invoices, summed in the database. */
export async function getInvoiceSummary(actor: Actor): Promise<InvoiceSummary> {
  assertCan(actor, "create");
  const [p] = await db().select({ tz: businessProfile.timeZone }).from(businessProfile).where(eq(businessProfile.ownerId, actor.id));
  const tz = p?.tz ?? "UTC";
  const today = todayIn(tz);
  const monthStart = `${today.slice(0, 7)}-01`;
  const [sums] = await db()
    .select({
      outstanding: sql<string>`coalesce(sum(${invoice.totalCents}) filter (where ${invoice.status} = 'sent'), 0)`,
      overdue: sql<string>`coalesce(sum(${invoice.totalCents}) filter (where ${invoice.status} = 'sent' and ${invoice.dueDate} < ${today}::date), 0)`,
      paid: sql<string>`coalesce(sum(${invoice.paidCents}) filter (where ${invoice.status} = 'paid' and (${invoice.paidAt} at time zone ${tz})::date >= ${monthStart}::date), 0)`,
    })
    .from(invoice)
    .where(ownedBy(invoice, actor));
  const byStatus = await db()
    .select({ status: invoice.status, n: count() })
    .from(invoice)
    .where(ownedBy(invoice, actor, inArray(invoice.status, ["draft", "sent", "paid", "void"])))
    .groupBy(invoice.status);
  return {
    outstandingCents: Number(sums.outstanding),
    overdueCents: Number(sums.overdue),
    paidThisMonthCents: Number(sums.paid),
    counts: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
  };
}
