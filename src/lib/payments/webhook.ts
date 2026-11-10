import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { BadRequestError } from "@/lib/errors";
import { markPaidInTx } from "@/lib/invoices";
import { log } from "@/lib/log";
import { paymentsConfig } from "./config";
import { invoiceRef } from "./invoice-ref";
import { verifyStripeSignature } from "./signature";

const { invoice, payment, stripeEvent } = schema;

export const WEBHOOK_BODY_LIMIT = 64 * 1024;
const HANDLED_TYPE = "checkout.session.completed";

const envelope = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9_]{1,200}$/),
  type: z.string().min(1).max(100),
  livemode: z.boolean(),
  data: z.object({ object: z.unknown() }),
});

const session = z.object({
  id: z.string().regex(/^cs_[A-Za-z0-9_]{1,250}$/),
  payment_status: z.string().max(40),
  currency: z.string().max(10).nullable(),
  amount_total: z.number().int().min(0).nullable(),
  metadata: z.object({ invoice_id: z.string().max(100).optional(), invoice_hash: z.string().max(100).optional() }).nullish(),
});

export type WebhookOutcome = "paid" | "flagged" | "duplicate" | "ignored";
export type WebhookResult = { status: 200; body: { received: true; outcome: WebhookOutcome } } | { status: 400; body: { error: string } };

const rejected = (error: string): WebhookResult => ({ status: 400, body: { error } });

/**
 * Handle one Stripe webhook delivery. `rawBody` is the exact bytes received, verified before anything is parsed.
 *
 * Order of refusals: no test-mode Stripe configured or a bad/stale signature (400, `stripe.signature_invalid`, no
 * body logged), then a live-mode event (400). Only `checkout.session.completed` is handled; other types are
 * acknowledged and ignored. Handling runs in ONE transaction: the event id is inserted first (a duplicate id means a
 * replay: 200, nothing else happens), the invoice row is locked (so it serializes with the owner's manual payment
 * and with the demo provider), and then:
 *  - payment_status other than "paid": ignored;
 *  - invoice void: a flagged `invoice_void` payment (money arrived; the owner must refund), never paid;
 *  - invoice already paid (a manual payment won the race, or a second session): a flagged `duplicate_payment` row;
 *  - currency not usd, amount not equal to the balance, or the metadata hash not ours: a flagged `amount_mismatch`
 *    payment, the invoice stays `sent`;
 *  - otherwise the balance is recorded and the invoice becomes paid.
 * A failure inside the transaction rolls back the event row too, so Stripe's retry is processed normally.
 */
export async function handleStripeWebhook(rawBody: Buffer, signatureHeader: string | null): Promise<WebhookResult> {
  const config = paymentsConfig();
  if (config.mode !== "stripe") {
    log.warn("stripe.signature_invalid", { reason: "not_configured" });
    return rejected("Invalid signature");
  }
  const verdict = verifyStripeSignature(rawBody, signatureHeader, config.webhookSecret);
  if (!verdict.ok) {
    log.warn("stripe.signature_invalid", { reason: verdict.reason });
    return rejected("Invalid signature");
  }

  // Signed by our endpoint secret, so now it is safe to parse.
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
  } catch {
    return rejected("Invalid payload");
  }
  const parsed = envelope.safeParse(json);
  if (!parsed.success) return rejected("Invalid payload");
  const event = parsed.data;

  if (event.livemode) {
    log.warn("stripe.livemode_refused", { eventId: event.id });
    return rejected("Live-mode events are not accepted");
  }
  if (event.type !== HANDLED_TYPE) return { status: 200, body: { received: true, outcome: "ignored" } };

  const outcome = await db().transaction(async (tx): Promise<WebhookOutcome> => {
    const inserted = await tx.insert(stripeEvent).values({ id: event.id, type: event.type }).onConflictDoNothing().returning({ id: stripeEvent.id });
    if (inserted.length === 0) return "duplicate"; // a replay (or the same delivery racing itself): no-op

    const s = session.safeParse(event.data.object);
    if (!s.success) throw new BadRequestError("Invalid payload"); // rolls the event row back; Stripe may retry
    const sess = s.data;
    if (sess.payment_status !== "paid") return "ignored";

    const invoiceId = z.string().uuid().safeParse(sess.metadata?.invoice_id);
    if (!invoiceId.success) {
      log.warn("stripe.event_unmatched", { eventId: event.id, reason: "no_invoice_id" });
      return "ignored";
    }
    const [row] = await tx.select().from(invoice).where(eq(invoice.id, invoiceId.data)).for("update");
    if (!row || row.status === "draft") {
      log.warn("stripe.event_unmatched", { eventId: event.id, reason: "unknown_invoice" });
      return "ignored";
    }
    const [seen] = await tx.select({ id: payment.id }).from(payment).where(eq(payment.stripeSessionId, sess.id));
    if (seen) return "duplicate"; // another event for a session we already recorded

    const amount = sess.amount_total ?? 0;
    const currency = (sess.currency ?? "").toLowerCase().replace(/[^a-z]/g, "");

    if (row.status === "paid") {
      // Paid already (a manual payment won the race, or a second session after a link rotation). The card money is
      // real, so keep it as a flagged row the owner can see and refund; it never changes the invoice.
      await tx.insert(payment).values({
        invoiceId: row.id,
        ownerId: row.ownerId,
        method: "stripe",
        amountCents: amount,
        stripeSessionId: sess.id,
        flag: "duplicate_payment",
        note: "Paid by card after the invoice was already paid. Refund it in Stripe.",
      });
      log.warn("stripe.payment_flagged", { invoiceId: row.id, flag: "duplicate_payment" });
      return "flagged";
    }
    if (row.status === "void") {
      await tx.insert(payment).values({
        invoiceId: row.id,
        ownerId: row.ownerId,
        method: "stripe",
        amountCents: amount,
        stripeSessionId: sess.id,
        flag: "invoice_void",
        note: "Paid by card after the invoice was voided. Refund it in Stripe.",
      });
      log.warn("stripe.payment_flagged", { invoiceId: row.id, flag: "invoice_void" });
      return "flagged";
    }

    const balance = row.totalCents - row.paidCents;
    const matches = sess.currency === "usd" && amount === balance && sess.metadata?.invoice_hash === invoiceRef(row);
    if (!matches) {
      await tx.insert(payment).values({
        invoiceId: row.id,
        ownerId: row.ownerId,
        method: "stripe",
        amountCents: amount,
        stripeSessionId: sess.id,
        flag: "amount_mismatch",
        note: `Card payment of ${amount} ${currency.toUpperCase() || "?"} cents did not match the balance of ${balance} cents. The invoice is not marked paid.`.slice(0, 200),
      });
      log.warn("stripe.payment_flagged", { invoiceId: row.id, flag: "amount_mismatch" });
      return "flagged";
    }

    await markPaidInTx(tx, row, { method: "stripe", stripeSessionId: sess.id, note: "Stripe test-mode Checkout" });
    return "paid";
  });

  return { status: 200, body: { received: true, outcome } };
}
