import { createHash } from "node:crypto";

export const CURRENCY = "usd";

/**
 * The hash that goes into a Checkout session's metadata next to the invoice id. The webhook recomputes it from the
 * stored invoice, so a session made for another invoice, number or amount can never mark this one paid.
 */
export function invoiceRef(invoice: { id: string; number: string | null; totalCents: number }): string {
  return createHash("sha256").update(`invoice:${invoice.id}:${invoice.number ?? ""}:${invoice.totalCents}:${CURRENCY}`, "utf8").digest("hex");
}
