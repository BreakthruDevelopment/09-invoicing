import "server-only";
import type { Actor } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { WRITES_PER_HOUR, idSchema } from "@/lib/invoice-schemas";
import { type Tx, consumeRate } from "@/lib/usage";
import { sql } from "drizzle-orm";

/** An id that isn't a UUID can't name a row: answer 404, not a database error. */
export function parseId(id: unknown, what: string): string {
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) throw new NotFoundError(`${what} not found`);
  return parsed.data;
}

/**
 * Every owner write runs in one transaction that first spends one of the user's 300 writes per hour. A refused
 * or failed write rolls the charge back with it. Never call `db()` inside `fn`: use `tx`.
 */
export function writeTx<T>(actor: Actor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db().transaction(async (tx) => {
    await consumeRate(tx, actor.id, "api_write", WRITES_PER_HOUR, "You're making changes too quickly. Try again in a few minutes.");
    return fn(tx);
  });
}

/** Today's date (`YYYY-MM-DD`) in a time zone. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The owner's profile, created with defaults on first use. Safe under concurrency. */
export async function ensureProfile(tx: Pick<Tx, "insert" | "select">, ownerId: string) {
  await tx.insert(schema.businessProfile).values({ ownerId }).onConflictDoNothing();
  const [row] = await tx.select().from(schema.businessProfile).where(sql`${schema.businessProfile.ownerId} = ${ownerId}`);
  return row;
}
