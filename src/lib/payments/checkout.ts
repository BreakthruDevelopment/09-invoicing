import "server-only";
import { z } from "zod";
import { db } from "@/lib/db";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { resolveShareToken } from "@/lib/share";
import { consumeRate } from "@/lib/usage";
import { selectProvider } from "./providers";

/** From the spec's rate table: 5 checkout sessions per invoice per hour. */
export const CHECKOUTS_PER_INVOICE_PER_HOUR = 5;

/** The checkout request has no fields. `.strict()` makes anything extra a 400 instead of silently ignored. */
export const checkoutBody = z.object({}).strict();

/**
 * Start a payment for the invoice behind a share token, with no login. The amount is never an input: it is the
 * invoice's balance as stored on the server. Drafts (and unknown, rotated or malformed tokens) are a 404; paid and
 * void invoices are refused with 409.
 */
export async function startCheckout(token: unknown): Promise<{ provider: "demo" | "stripe"; url: string }> {
  const row = await resolveShareToken(token);
  if (!row) throw new NotFoundError("Invoice not found");
  if (row.status === "paid") throw new ConflictError("This invoice has already been paid.");
  if (row.status !== "sent") throw new ConflictError("This invoice can't be paid.");
  if (row.totalCents - row.paidCents <= 0) throw new ConflictError("There is nothing left to pay on this invoice.");

  // Its own short transaction, committed before any outside call, so a slow Stripe request never holds the lock.
  await db().transaction((tx) =>
    consumeRate(tx, row.ownerId, "checkout", CHECKOUTS_PER_INVOICE_PER_HOUR, "Too many payment attempts for this invoice. Try again in an hour.", { subject: row.id }),
  );

  const provider = selectProvider();
  const { url } = await provider.createCheckout(row, token as string);
  return { provider: provider.name, url };
}
