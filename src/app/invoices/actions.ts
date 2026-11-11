"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import type { ClientInvoice, NotesReview, ServerTotals } from "@/components/invoicing/types";
import { requireUser } from "@/lib/auth/session";
import { actionMessage } from "@/lib/action-message";
import { BadRequestError } from "@/lib/errors";
import { parseCents, parseQuantityX100, parseTaxBp } from "@/lib/form-money";
import { draftInvoiceFromNotes, addDraftLinesToInvoice } from "@/lib/invoice-draft";
import { presentInvoice } from "@/lib/invoice-present";
import { lineInput } from "@/lib/invoice-schemas";
import {
  createInvoice,
  deleteInvoice,
  duplicateInvoice,
  recordManualPayment,
  transitionInvoice,
  updateInvoice,
} from "@/lib/invoices";
import { computeTotals } from "@/lib/money";
import { shareUrl } from "@/lib/api";
import { rotateShareToken } from "@/lib/share";

export type ActionFail = { ok: false; error: string };
export type SavedInvoice = { ok: true; invoice: ClientInvoice; shareUrl?: string };

const editorLine = z.object({
  kind: z.enum(["hours", "fixed", "expense"]),
  description: z.string().max(300),
  quantity: z.string().max(20),
  unitPrice: z.string().max(20),
  source: z.enum(["manual", "ai"]).optional(),
});

const editorFields = {
  version: z.number().int().min(1),
  clientId: z.string().max(64),
  issueDate: z.string().max(10),
  dueDate: z.string().max(10),
  taxPercent: z.string().max(8),
  memo: z.string().max(1_000),
  lines: z.array(editorLine).max(50),
};

const editorInput = z.object({ id: z.string().uuid(), ...editorFields }).strict();

const quoteInput = z
  .object({
    taxPercent: z.string().max(8),
    lines: z.array(editorLine).max(50),
  })
  .strict();

const notesInput = z
  .object({
    clientId: z.string().uuid(),
    notes: z.string().max(6_000),
    periodFrom: z.string().max(10),
    periodTo: z.string().max(10),
  })
  .strict();

const addInput = z
  .object({
    invoiceId: z.string().uuid(),
    draftId: z.string().uuid(),
    lineIndexes: z.array(z.number().int().min(0).max(19)).min(1).max(20),
    version: z.number().int().min(1),
  })
  .strict();

function blankLine(line: z.infer<typeof editorLine>): boolean {
  return line.description.trim() === "" && line.quantity.trim() === "" && line.unitPrice.trim() === "";
}

function taxOrThrow(raw: string): number {
  const taxBp = parseTaxBp(raw);
  if (taxBp === null) throw new BadRequestError("Enter a tax rate from 0 to 30, like 8.25.");
  return taxBp;
}

/** Lines the owner filled in. A half-finished row is an error rather than a silent drop. */
function linesOrThrow(lines: z.infer<typeof editorLine>[]) {
  const kept: { kind: "hours" | "fixed" | "expense"; description: string; quantityX100: number; unitPriceCents: number; source: "manual" | "ai" }[] = [];
  lines.forEach((line, index) => {
    if (blankLine(line)) return;
    const quantityX100 = parseQuantityX100(line.quantity);
    const unitPriceCents = parseCents(line.unitPrice);
    const where = `Line ${index + 1}`;
    if (quantityX100 === null) throw new BadRequestError(`${where}: enter a quantity like 1 or 3.5.`);
    if (unitPriceCents === null) throw new BadRequestError(`${where}: enter a price in dollars, like 100.00.`);
    const parsed = lineInput.parse({
      kind: line.kind,
      description: line.description,
      quantityX100,
      unitPriceCents,
      source: line.source ?? "manual",
    });
    kept.push(parsed);
  });
  return kept;
}

function clientIdOrNull(raw: string): string | null {
  const id = raw.trim();
  if (!id) return null;
  if (!z.string().uuid().safeParse(id).success) throw new BadRequestError("Choose a client from the list.");
  return id;
}

async function fail(err: unknown): Promise<ActionFail> {
  unstable_rethrow(err);
  return { ok: false, error: actionMessage(err) };
}

/**
 * Totals for the lines currently on screen. Nothing is saved. Amounts come from `computeTotals`.
 * A line the owner is still typing is left out and reported, so the page never invents a figure.
 */
export async function quoteDraft(raw: unknown): Promise<{ ok: true; totals: ServerTotals; skipped: number } | ActionFail> {
  try {
    await requireUser();
    const input = quoteInput.parse(raw);
    const taxBp = taxOrThrow(input.taxPercent);
    const amounts: (number | null)[] = input.lines.map(() => null);
    const ready: { quantityX100: number; unitPriceCents: number }[] = [];
    const readyAt: number[] = [];
    let skipped = 0;
    input.lines.forEach((line, index) => {
      if (blankLine(line)) return;
      const quantityX100 = parseQuantityX100(line.quantity);
      const unitPriceCents = parseCents(line.unitPrice);
      if (quantityX100 === null || unitPriceCents === null || line.description.trim() === "") {
        skipped += 1;
        return;
      }
      ready.push({ quantityX100, unitPriceCents });
      readyAt.push(index);
    });
    const totals = computeTotals(ready, taxBp);
    readyAt.forEach((index, i) => {
      amounts[index] = totals.lineAmounts[i] ?? null;
    });
    return {
      ok: true,
      skipped,
      totals: { amounts, subtotalCents: totals.subtotalCents, taxCents: totals.taxCents, totalCents: totals.totalCents, taxBp },
    };
  } catch (err) {
    return fail(err);
  }
}

export async function saveDraft(raw: unknown): Promise<SavedInvoice | ActionFail> {
  try {
    const user = await requireUser();
    const input = editorInput.parse(raw);
    const detail = await updateInvoice(user, input.id, {
      version: input.version,
      clientId: clientIdOrNull(input.clientId),
      issueDate: input.issueDate,
      dueDate: input.dueDate,
      taxBp: taxOrThrow(input.taxPercent),
      memo: input.memo,
      lines: linesOrThrow(input.lines),
    });
    revalidatePath("/invoices");
    revalidatePath(`/invoices/${detail.invoice.id}`);
    return { ok: true, invoice: presentInvoice(detail) };
  } catch (err) {
    return fail(err);
  }
}

const createShape = z
  .object({
    clientId: z.string().max(64),
    issueDate: z.string().max(10),
    dueDate: z.string().max(10),
    taxPercent: z.string().max(8),
    memo: z.string().max(1_000),
  })
  .strict();

/** Start a draft. The editor (and its server totals) live on the invoice page after this. */
export async function startDraft(raw: unknown): Promise<{ ok: true; id: string } | ActionFail> {
  try {
    const user = await requireUser();
    const input = createShape.parse(raw);
    const detail = await createInvoice(user, {
      clientId: clientIdOrNull(input.clientId),
      issueDate: input.issueDate,
      dueDate: input.dueDate,
      taxBp: taxOrThrow(input.taxPercent),
      memo: input.memo,
      lines: [],
    });
    revalidatePath("/invoices");
    return { ok: true, id: detail.invoice.id };
  } catch (err) {
    return fail(err);
  }
}

export async function sendInvoice(id: string, version: number): Promise<SavedInvoice | ActionFail> {
  try {
    const user = await requireUser();
    const result = await transitionInvoice(user, id, { to: "sent", version });
    revalidatePath("/invoices");
    revalidatePath(`/invoices/${id}`);
    return {
      ok: true,
      invoice: presentInvoice(result.detail),
      shareUrl: result.shareToken ? shareUrl(result.shareToken) : undefined,
    };
  } catch (err) {
    return fail(err);
  }
}

export async function voidInvoice(id: string, version: number, reason: string): Promise<SavedInvoice | ActionFail> {
  try {
    const user = await requireUser();
    const result = await transitionInvoice(user, id, { to: "void", version, reason });
    revalidatePath("/invoices");
    revalidatePath(`/invoices/${id}`);
    return { ok: true, invoice: presentInvoice(result.detail) };
  } catch (err) {
    return fail(err);
  }
}

export async function removeDraft(id: string): Promise<{ ok: true } | ActionFail> {
  try {
    const user = await requireUser();
    await deleteInvoice(user, id);
    revalidatePath("/invoices");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function copyInvoice(id: string): Promise<{ ok: true; id: string } | ActionFail> {
  try {
    const user = await requireUser();
    const detail = await duplicateInvoice(user, id);
    revalidatePath("/invoices");
    return { ok: true, id: detail.invoice.id };
  } catch (err) {
    return fail(err);
  }
}

export async function recordPayment(id: string, version: number, note: string): Promise<SavedInvoice | ActionFail> {
  try {
    const user = await requireUser();
    const detail = await recordManualPayment(user, id, { version, note });
    revalidatePath("/invoices");
    revalidatePath(`/invoices/${id}`);
    return { ok: true, invoice: presentInvoice(detail) };
  } catch (err) {
    return fail(err);
  }
}

/** Rotate returns the new address once. The previous link stops working in the same save. */
export async function rotateLink(id: string): Promise<{ ok: true; shareUrl: string } | ActionFail> {
  try {
    const user = await requireUser();
    const { token } = await rotateShareToken(user, id);
    revalidatePath(`/invoices/${id}`);
    return { ok: true, shareUrl: shareUrl(token) };
  } catch (err) {
    return fail(err);
  }
}

export async function draftFromNotes(raw: unknown): Promise<{ ok: true; review: NotesReview } | ActionFail> {
  try {
    const user = await requireUser();
    const input = notesInput.parse(raw);
    if ((input.periodFrom === "") !== (input.periodTo === "")) {
      throw new BadRequestError("Enter both dates for the period, or leave both blank.");
    }
    const period =
      input.periodFrom === "" && input.periodTo === ""
        ? undefined
        : { from: input.periodFrom, to: input.periodTo };
    const draft = await draftInvoiceFromNotes(user, {
      notes: input.notes,
      clientId: input.clientId,
      ...(period ? { period } : {}),
    });
    return {
      ok: true,
      review: {
        draftId: draft.draftId,
        demo: draft.demo,
        subtotalCents: draft.subtotalCents,
        assumptions: draft.assumptions,
        unbillable: draft.unbillable,
        dropped: draft.dropped.map((row) => ({ reason: row.reason, description: row.description })),
        period: draft.period,
        lines: draft.lines.map((line) => ({
          kind: line.kind,
          description: line.description,
          quantityX100: line.quantityX100,
          unitPriceCents: line.unitPriceCents,
          amountCents: line.amountCents,
          sourceLines: line.sourceLines,
          evidence: line.evidence,
        })),
      },
    };
  } catch (err) {
    return fail(err);
  }
}

export async function addNotesLines(raw: unknown): Promise<SavedInvoice | ActionFail> {
  try {
    const user = await requireUser();
    const input = addInput.parse(raw);
    const detail = await addDraftLinesToInvoice(user, input.invoiceId, {
      draftId: input.draftId,
      lineIndexes: input.lineIndexes,
      version: input.version,
    });
    revalidatePath("/invoices");
    revalidatePath(`/invoices/${input.invoiceId}`);
    return { ok: true, invoice: presentInvoice(detail) };
  } catch (err) {
    return fail(err);
  }
}
