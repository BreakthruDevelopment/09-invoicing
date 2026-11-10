import "server-only";
import { AiError } from "@/lib/ai";
import { type InvoiceDraft, invoiceFromNotes, invoiceFromNotesInput } from "@/lib/ai/invoice-from-notes";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { TooManyRequestsError } from "@/lib/errors";
import { log } from "@/lib/log";
import { consumeRate, releaseDaily, releaseRate, reserveDaily } from "@/lib/usage";

export const INVOICE_DRAFTS_PER_HOUR = 10;

/**
 * "Draft from notes": checks the caller, takes one slot from the per-user hourly limit and the app-wide daily
 * cap (one short transaction, committed before the slow model call), then drafts. Nothing is stored: the owner
 * reviews the draft first. (Saving it, and "Add to invoice", wait for issue #1's tables.)
 */
export async function draftInvoiceFromNotes(actor: Actor, raw: unknown): Promise<InvoiceDraft> {
  assertCan(actor, "create");
  const input = invoiceFromNotesInput.parse(raw);

  await db().transaction(async (tx) => {
    await consumeRate(tx, actor.id, "ai", INVOICE_DRAFTS_PER_HOUR, "You can draft 10 invoices from notes per hour. Try again later.");
    if (!(await reserveDaily(tx, "ai", env().AI_DAILY_CAP))) {
      // Throwing rolls the rate row back too.
      throw new TooManyRequestsError("The daily AI limit has been reached. Try again tomorrow.");
    }
  });

  try {
    const draft = await invoiceFromNotes(input);
    // Counts and codes only: never the notes, descriptions or evidence.
    log.info("invoice.draft", {
      task: "invoice-from-notes",
      mode: draft.demo ? "demo" : "live",
      lines: draft.lines.length,
      dropped: draft.dropped.length,
      droppedCodes: draft.dropped.map((d) => d.code),
    });
    return draft;
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
