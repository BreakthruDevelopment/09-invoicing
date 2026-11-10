import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { parseId, todayIn, writeTx } from "@/lib/invoice-common";
import { ownedBy } from "@/lib/owned";

const { invoice, invoiceLine, businessProfile } = schema;

/** Statuses a client may see through a link. A draft has no public face. */
export const PUBLIC_STATUSES = ["sent", "paid", "void"] as const;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url, no padding

/** 32 random bytes, base64url (43 characters). Shown to the owner once; only its hash is stored. */
export function generateShareToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time comparison of two hex digests. */
export function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The internal row behind a share token, or null for anything else: a malformed token, an unknown one, a rotated
 * or revoked one, and a draft all look the same. Callers (the public page and API, the PDF and checkout routes)
 * must answer 404 for null and never say which case it was.
 */
export async function resolveShareToken(token: unknown) {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
  const hash = hashShareToken(token);
  const [row] = await db()
    .select()
    .from(invoice)
    .where(and(eq(invoice.shareTokenHash, hash), inArray(invoice.status, [...PUBLIC_STATUSES])))
    .limit(1);
  // The lookup is by an indexed hash (the token can't be reconstructed from it); the explicit constant-time
  // compare means nothing downstream trusts the database's equality alone.
  if (!row?.shareTokenHash || !hashesEqual(row.shareTokenHash, hash)) return null;
  return row;
}

/**
 * Everything the client's page needs, and nothing more: no ids, no owner, no client email or address, no void
 * reason. Business name comes from the owner's profile; the client's name from the frozen snapshot.
 */
export type PublicInvoice = {
  number: string;
  status: (typeof PUBLIC_STATUSES)[number];
  overdue: boolean;
  businessName: string;
  clientName: string;
  issueDate: string;
  dueDate: string;
  memo: string;
  lines: { kind: string; description: string; quantityX100: number; unitPriceCents: number; amountCents: number }[];
  subtotalCents: number;
  taxBp: number;
  taxCents: number;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  paidAt: string | null;
};

export async function getPublicInvoice(token: unknown): Promise<PublicInvoice | null> {
  const row = await resolveShareToken(token);
  if (!row || !row.number) return null;
  const [lines, [profile]] = await Promise.all([
    db()
      .select({
        kind: invoiceLine.kind,
        description: invoiceLine.description,
        quantityX100: invoiceLine.quantityX100,
        unitPriceCents: invoiceLine.unitPriceCents,
        amountCents: invoiceLine.amountCents,
      })
      .from(invoiceLine)
      .where(eq(invoiceLine.invoiceId, row.id))
      .orderBy(asc(invoiceLine.position)),
    db().select({ name: businessProfile.name, timeZone: businessProfile.timeZone }).from(businessProfile).where(eq(businessProfile.ownerId, row.ownerId)),
  ]);
  const status = row.status as PublicInvoice["status"];
  return {
    number: row.number,
    status,
    overdue: status === "sent" && row.dueDate < todayIn(profile?.timeZone ?? "UTC"),
    businessName: profile?.name ?? "",
    clientName: row.clientSnapshot?.name ?? "",
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    memo: row.memo,
    lines,
    subtotalCents: row.subtotalCents,
    taxBp: row.taxBp,
    taxCents: row.taxCents,
    totalCents: row.totalCents,
    paidCents: row.paidCents,
    balanceCents: status === "sent" ? row.totalCents - row.paidCents : 0,
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
  };
}

/** New token, returned once. The old link stops working in the same transaction. Not available on a draft. */
export async function rotateShareToken(actor: Actor, id: string): Promise<{ token: string }> {
  const invoiceId = parseId(id, "Invoice");
  return writeTx(actor, async (tx) => {
    const [row] = await tx.select().from(invoice).where(ownedBy(invoice, actor, eq(invoice.id, invoiceId))).for("update");
    if (!row) throw new NotFoundError("Invoice not found");
    assertCan(actor, "update", row);
    if (row.status === "draft") throw new ConflictError("Send the invoice first; a draft has no share link.");
    const token = generateShareToken();
    await tx.update(invoice).set({ shareTokenHash: hashShareToken(token), updatedAt: new Date() }).where(eq(invoice.id, row.id));
    return { token };
  });
}

/** Turn the link off without making a new one. The owner can rotate later to get a fresh link. */
export async function revokeShareToken(actor: Actor, id: string): Promise<void> {
  const invoiceId = parseId(id, "Invoice");
  await writeTx(actor, async (tx) => {
    const [row] = await tx.select().from(invoice).where(ownedBy(invoice, actor, eq(invoice.id, invoiceId))).for("update");
    if (!row) throw new NotFoundError("Invoice not found");
    assertCan(actor, "update", row);
    await tx.update(invoice).set({ shareTokenHash: null, updatedAt: new Date() }).where(eq(invoice.id, row.id));
  });
}
