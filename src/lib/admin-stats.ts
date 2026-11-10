import "server-only";
import { count, isNull } from "drizzle-orm";
import { type Actor, ForbiddenError } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { dailyCount } from "@/lib/usage";

export type AdminStats = {
  users: number;
  invoicesByStatus: Record<(typeof schema.INVOICE_STATUSES)[number], number>;
  paymentsByMethod: Record<(typeof schema.PAYMENT_METHODS)[number], number>;
  ai: { callsToday: number; dailyCap: number };
};

/**
 * Counts only, for admins only. Nothing here names a user, a client or an amount: admins run the app, they don't
 * read owners' invoices (every owner query goes through `ownedBy`, which matches nothing for an admin).
 */
export async function getAdminStats(actor: Actor): Promise<AdminStats> {
  if (actor.role !== "admin") throw new ForbiddenError();
  const [[{ users }], statuses, methods, callsToday] = await Promise.all([
    db().select({ users: count() }).from(schema.user),
    db().select({ k: schema.invoice.status, n: count() }).from(schema.invoice).groupBy(schema.invoice.status),
    db().select({ k: schema.payment.method, n: count() }).from(schema.payment).where(isNull(schema.payment.flag)).groupBy(schema.payment.method),
    dailyCount("ai"),
  ]);
  const zero = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  const invoicesByStatus = zero(schema.INVOICE_STATUSES);
  for (const r of statuses) invoicesByStatus[r.k] = r.n;
  const paymentsByMethod = zero(schema.PAYMENT_METHODS);
  for (const r of methods) paymentsByMethod[r.k] = r.n;
  return { users, invoicesByStatus, paymentsByMethod, ai: { callsToday, dailyCap: env().AI_DAILY_CAP } };
}
