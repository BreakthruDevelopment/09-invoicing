import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { hashShareToken, hashesEqual, resolveShareToken } from "@/lib/share";
import { markPaidInTx } from "@/lib/invoices";
import { paymentsConfig } from "./config";

export const DEMO_PAYMENT_NOTE = "Demo payment, no money moved";

/**
 * The demo provider's confirm step: record the full balance as a `demo` payment and mark the invoice paid, instantly.
 * Allowed only while the provider is `demo` (with Stripe keys configured it is a 404, so the demo can't be used to
 * fake a payment). The caller is the payer holding the share link; the row is locked and re-checked, so a double
 * click or a racing owner's manual payment records exactly one payment.
 */
export async function confirmDemoPayment(token: unknown): Promise<{ status: "paid" }> {
  if (paymentsConfig().mode !== "demo") throw new NotFoundError("Not found");
  const found = await resolveShareToken(token);
  if (!found) throw new NotFoundError("Invoice not found");

  await db().transaction(async (tx) => {
    const [row] = await tx.select().from(schema.invoice).where(eq(schema.invoice.id, found.id)).for("update");
    // The link may have been rotated or revoked between the lookup and the lock.
    if (!row?.shareTokenHash || !hashesEqual(row.shareTokenHash, hashShareToken(token as string))) throw new NotFoundError("Invoice not found");
    if (row.status === "paid") throw new ConflictError("This invoice has already been paid.");
    if (row.status !== "sent") throw new ConflictError("This invoice can't be paid.");
    await markPaidInTx(tx, row, { method: "demo", note: DEMO_PAYMENT_NOTE });
  });
  return { status: "paid" };
}
