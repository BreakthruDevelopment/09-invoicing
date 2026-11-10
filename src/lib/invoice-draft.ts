import "server-only";
import { and, asc, desc, eq, ne, notInArray } from "drizzle-orm";
import { z } from "zod";
import { AiError } from "@/lib/ai";
import {
  type InvoiceDraft,
  invoiceFromNotesDetailed,
  invoiceFromNotesInput,
  invoiceFromNotesSchema,
  splitNotes,
} from "@/lib/ai/invoice-from-notes";
import { applyInvoiceGuardrails } from "@/lib/ai/invoice-guardrails";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { BadRequestError, ConflictError, NotFoundError, TooManyRequestsError, UnprocessableError } from "@/lib/errors";
import { addDays, parseId, todayIn, writeTx } from "@/lib/invoice-common";
import { MAX_LINES, computeTotals } from "@/lib/money";
import { dateSchema, idSchema, lineInput } from "@/lib/invoice-schemas";
import { type InvoiceDetail, getInvoice, loadDraftForUpdate } from "@/lib/invoices";
import { log } from "@/lib/log";
import { ownedBy } from "@/lib/owned";
import { type Tx, consumeRate, releaseDaily, releaseRate, reserveDaily } from "@/lib/usage";

const { client, invoiceLine, invoice, notesDraft, businessProfile } = schema;

export const INVOICE_DRAFTS_PER_HOUR = 10;
/** Saved drafts kept per owner; older ones are deleted when a new one is saved. */
export const NOTES_DRAFTS_KEPT = 20;
/** The invoice period, when the caller doesn't give one: the 7 days ending today in the owner's time zone. */
export const DEFAULT_PERIOD_DAYS = 7;
const MAX_PERIOD_DAYS = 366;

const periodSchema = z
  .object({ from: dateSchema, to: dateSchema })
  .strict()
  .refine((p) => p.from <= p.to, { message: "The period can't end before it starts", path: ["to"] })
  .refine((p) => Date.parse(p.to) - Date.parse(p.from) <= (MAX_PERIOD_DAYS - 1) * 86_400_000, {
    message: `The period can be up to ${MAX_PERIOD_DAYS} days`,
    path: ["to"],
  });
export type Period = z.infer<typeof periodSchema>;

/**
 * Route input for "Draft from notes". The client's rate is never accepted from the browser: it's looked up from
 * `clientId` (owner's clients only). Unknown keys, `clientRateCents` included, are a 400.
 */
export const draftFromNotesInput = z
  .object({
    notes: invoiceFromNotesInput.shape.notes,
    clientId: idSchema,
    period: periodSchema.optional(),
  })
  .strict();

/** Route input for "Add to invoice": the saved draft's id and which of its lines (0-based), never amounts. */
export const addDraftLinesInput = z
  .object({
    draftId: idSchema,
    lineIndexes: z
      .array(z.number().int().min(0).max(19))
      .min(1)
      .max(20)
      .refine((a) => new Set(a).size === a.length, "Each line can be picked once"),
    version: z.number().int().min(1),
  })
  .strict();

/** What is saved in `notes_draft.data`: the model answer the guardrails saw, and what the owner was shown. */
const storedDraft = z.object({
  v: z.literal(1),
  model: invoiceFromNotesSchema,
  period: periodSchema,
  shown: z
    .array(z.object({ kind: z.string(), quantityX100: z.number().int(), sourceLines: z.array(z.string()), evidence: z.string() }))
    .max(20),
});

export type SavedInvoiceDraft = InvoiceDraft & { draftId: string; clientId: string; period: Period };

async function loadClientRate(reader: Pick<Tx, "select">, actor: Actor, clientId: string) {
  const [c] = await reader
    .select({ rate: client.hourlyRateCents, archivedAt: client.archivedAt })
    .from(client)
    .where(ownedBy(client, actor, eq(client.id, clientId)));
  if (!c) throw new NotFoundError("Client not found");
  if (c.archivedAt) throw new ConflictError("That client is archived.");
  return c.rate;
}

/**
 * "Draft from notes": checks the caller and the client (ownership, then the rate from the client's own row), takes
 * one slot from the per-user hourly limit and the app-wide daily cap (one short transaction, committed before the
 * slow model call), drafts, and saves the notes plus the validated model answer in `notes_draft` (last 20 per
 * owner). Nothing goes on an invoice until `addDraftLinesToInvoice`. Neither the notes nor the lines are logged.
 */
export async function draftInvoiceFromNotes(actor: Actor, raw: unknown): Promise<SavedInvoiceDraft> {
  assertCan(actor, "create");
  const input = draftFromNotesInput.parse(raw);
  const clientRateCents = await loadClientRate(db(), actor, input.clientId);
  let period: Period;
  if (input.period) period = input.period;
  else {
    const [p] = await db().select({ tz: businessProfile.timeZone }).from(businessProfile).where(eq(businessProfile.ownerId, actor.id));
    const today = todayIn(p?.tz ?? "UTC");
    period = { from: addDays(today, -(DEFAULT_PERIOD_DAYS - 1)), to: today };
  }

  await db().transaction(async (tx) => {
    await consumeRate(tx, actor.id, "ai", INVOICE_DRAFTS_PER_HOUR, "You can draft 10 invoices from notes per hour. Try again later.");
    if (!(await reserveDaily(tx, "ai", env().AI_DAILY_CAP))) {
      // Throwing rolls the rate row back too.
      throw new TooManyRequestsError("The daily AI limit has been reached. Try again tomorrow.");
    }
  });

  try {
    const { draft, model } = await invoiceFromNotesDetailed({ notes: input.notes, clientRateCents, period });
    const data: z.infer<typeof storedDraft> = {
      v: 1,
      model,
      period,
      shown: draft.lines.map((l) => ({ kind: l.kind, quantityX100: l.quantityX100, sourceLines: l.sourceLines, evidence: l.evidence })),
    };
    const saved = await db().transaction(async (tx) => {
      const [row] = await tx
        .insert(notesDraft)
        .values({ ownerId: actor.id, clientId: input.clientId, notes: input.notes, data, mode: draft.demo ? "demo" : "live" })
        .returning({ id: notesDraft.id });
      const keep = tx
        .select({ id: notesDraft.id })
        .from(notesDraft)
        .where(ownedBy(notesDraft, actor))
        .orderBy(desc(notesDraft.createdAt), desc(notesDraft.id))
        .limit(NOTES_DRAFTS_KEPT);
      await tx.delete(notesDraft).where(ownedBy(notesDraft, actor, ne(notesDraft.id, row.id), notInArray(notesDraft.id, keep)));
      return row;
    });
    // Counts and codes only: never the notes, descriptions or evidence.
    log.info("invoice.draft", {
      task: "invoice-from-notes",
      mode: draft.demo ? "demo" : "live",
      lines: draft.lines.length,
      dropped: draft.dropped.length,
      droppedCodes: draft.dropped.map((d) => d.code),
    });
    return { ...draft, draftId: saved.id, clientId: input.clientId, period };
  } catch (err) {
    // Give the slot back when no model work happened; an answer that failed validation did cost a call.
    if (err instanceof AiError ? err.kind !== "invalid_output" : false) {
      await db()
        .transaction(async (tx) => {
          await releaseRate(tx, actor.id, "ai");
          await releaseDaily(tx, "ai");
        })
        .catch(() => log.warn("invoice.draft.release_failed"));
    }
    throw err;
  }
}

/**
 * "Add to invoice": copies chosen lines of a saved draft onto a draft invoice, as `source: ai`.
 *
 * Nothing about the lines comes from the browser except which ones (indexes). Under one transaction that locks the
 * invoice and then the saved draft:
 * - the invoice must be the actor's, still a draft, and `version` must match (409 otherwise);
 * - the rate comes from the invoice's own client row (`ownedBy`), and the guardrails are re-run on the saved notes
 *   and the saved model answer, so quantity, price and amount are derived here, with `money.ts`;
 * - the saved draft is single-use: it is marked added in the same transaction, so a retry or a race gets 409;
 * - the invoice totals are recomputed from all lines and `version` goes up by one.
 */
export async function addDraftLinesToInvoice(actor: Actor, invoiceId: string, raw: unknown): Promise<InvoiceDetail> {
  const id = parseId(invoiceId, "Invoice");
  const input = addDraftLinesInput.parse(raw);
  const draftId = parseId(input.draftId, "Draft");

  const added = await writeTx(actor, async (tx) => {
    const row = await loadDraftForUpdate(tx, actor, id, input.version); // invoice lock first, always
    if (!row.clientId) throw new UnprocessableError("Choose a client for this invoice first.");
    const rate = await loadClientRate(tx, actor, row.clientId);

    const [saved] = await tx.select().from(notesDraft).where(ownedBy(notesDraft, actor, eq(notesDraft.id, draftId))).for("update");
    if (!saved) throw new NotFoundError("Draft not found");
    if (saved.addedAt) throw new ConflictError("This draft was already added to an invoice. Draft again to add more.");
    if (saved.clientId !== row.clientId) throw new UnprocessableError("This draft was made for a different client than this invoice's.");
    const data = storedDraft.safeParse(saved.data);
    if (!data.success) throw new ConflictError("This saved note has no drafted lines. Draft from the notes again.");

    const checked = applyInvoiceGuardrails(data.data.model, { noteLines: splitNotes(saved.notes), clientRateCents: rate });
    const same =
      checked.lines.length === data.data.shown.length &&
      checked.lines.every((l, i) => {
        const s = data.data.shown[i];
        return l.kind === s.kind && l.quantityX100 === s.quantityX100 && l.evidence === s.evidence && l.sourceLines.join() === s.sourceLines.join();
      });
    if (!same) throw new ConflictError("This draft no longer matches the notes or the client's rate. Draft again.");

    // Draft order, whatever order the caller listed them in.
    const picked = [...input.lineIndexes]
      .sort((x, y) => x - y)
      .map((i) => {
        const l = checked.lines[i];
        if (!l) throw new BadRequestError("That line isn't in the draft.");
        return lineInput.parse({ kind: l.kind, description: l.description, quantityX100: l.quantityX100, unitPriceCents: l.unitPriceCents, source: "ai" });
      });

    const existing = await tx.select().from(invoiceLine).where(eq(invoiceLine.invoiceId, row.id)).orderBy(asc(invoiceLine.position));
    if (existing.length + picked.length > MAX_LINES) throw new ConflictError(`An invoice can have up to ${MAX_LINES} lines.`);

    const totals = computeTotals([...existing, ...picked], row.taxBp);
    await tx.insert(invoiceLine).values(
      picked.map((l, i) => ({
        ...l,
        source: "ai" as const,
        invoiceId: row.id,
        ownerId: actor.id,
        position: existing.length + i + 1,
        amountCents: totals.lineAmounts[existing.length + i],
      })),
    );
    await tx
      .update(invoice)
      .set({
        subtotalCents: totals.subtotalCents,
        taxCents: totals.taxCents,
        totalCents: totals.totalCents,
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(invoice.id, row.id));
    await tx.update(notesDraft).set({ addedAt: new Date(), addedInvoiceId: row.id }).where(and(eq(notesDraft.id, saved.id), eq(notesDraft.ownerId, actor.id)));
    return picked.length;
  });

  log.info("invoice.draft.added", { invoiceId: id, lines: added });
  return getInvoice(actor, id);
}
