import "server-only";
import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import { type Db, db, schema } from "@/lib/db";
import { TooManyRequestsError } from "@/lib/errors";

/** A Drizzle handle: the pool or a transaction. */
export type Executor = Pick<Db, "select" | "insert" | "delete" | "execute">;

/**
 * A transaction handle, and only that. The per-user advisory lock is transaction-scoped, so on a pool
 * handle each statement may run on a different connection and the lock protects nothing (20 parallel
 * calls got 19 through the limit). Typing these functions with `Tx` makes passing `db()` a type error.
 *
 * Two rules the type can't enforce:
 * - The transaction must run at READ COMMITTED (Postgres's default; don't raise it). The count after the lock
 *   must see rows committed by whoever held the lock first. Under REPEATABLE READ or SERIALIZABLE the snapshot
 *   predates the lock and concurrent callers can all slip under the limit.
 * - Keep the transaction short. The lock serializes this user's attempts and the transaction pins a pooled
 *   connection. Never hold it across a slow call (an AI request, a fetch): consume or reserve in one small
 *   transaction, commit, do the work, and call `releaseRate`/`releaseDaily` in a new transaction if it fails.
 */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

type RateKind = (typeof schema.rateEvent.kind.enumValues)[number];
type DailyKind = (typeof schema.dailyUsage.kind.enumValues)[number];

const HOUR_SECONDS = 3600;
const today = sql`(now() at time zone 'utc')::date`;

/** Serialize work on one named resource for the rest of the transaction. */
export async function advisoryLock(tx: Tx, name: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${name}, 0))`);
}

/**
 * Atomically add one to today's (UTC) app-wide counter, only if it stays within `cap`.
 * Returns false, changing nothing, when the cap is reached.
 */
export async function reserveDaily(tx: Executor, kind: DailyKind, cap: number): Promise<boolean> {
  // The conditional below only guards the update branch; a fresh day's first insert would otherwise get through.
  if (!(cap >= 1)) return false;
  const rows = await tx.execute(sql`
    insert into daily_usage (day, kind, count) values (${today}, ${kind}, 1)
    on conflict (day, kind) do update set count = daily_usage.count + 1
      where daily_usage.count + 1 <= ${cap}::int
    returning count
  `);
  return rows.length > 0;
}

export async function dailyCount(kind: DailyKind): Promise<number> {
  const rows = await db().execute<{ count: number }>(sql`select count from daily_usage where day = ${today} and kind = ${kind}`);
  return rows.length ? Number(rows[0].count) : 0;
}

/**
 * Record one attempt for `userId` unless they already made `limit` in the last `opts.windowSeconds` (default one hour). Call inside a
 * transaction: the per-user lock keeps two concurrent requests from both slipping under the limit.
 */
export async function consumeRate(
  tx: Tx,
  userId: string,
  kind: RateKind,
  limit: number,
  message: string,
  opts: { windowSeconds?: number; now?: Date; subject?: string } = {},
): Promise<void> {
  const { rateEvent } = schema;
  // `subject` makes the limit per thing (one invoice) instead of per user; without it only subject-less rows count.
  const subjectIs = opts.subject === undefined ? isNull(rateEvent.subject) : eq(rateEvent.subject, opts.subject);
  await advisoryLock(tx, opts.subject === undefined ? `rate:${kind}:${userId}` : `rate:${kind}:${userId}:${opts.subject}`);
  const windowSeconds = opts.windowSeconds ?? HOUR_SECONDS;
  // `now` is a parameter so tests can pin the clock; production passes nothing and the database decides.
  const nowSql = opts.now ? sql`${opts.now.toISOString()}::timestamptz` : sql`now()`;
  const window = sql`make_interval(secs => ${windowSeconds})`;
  // Rows past the window can never count again.
  await tx
    .delete(rateEvent)
    .where(and(eq(rateEvent.userId, userId), eq(rateEvent.kind, kind), subjectIs, sql`${rateEvent.at} <= ${nowSql} - ${window}`));
  const [{ n }] = await tx
    .select({ n: count() })
    .from(rateEvent)
    .where(and(eq(rateEvent.userId, userId), eq(rateEvent.kind, kind), subjectIs, gt(rateEvent.at, sql`${nowSql} - ${window}`)));
  if (n >= limit) throw new TooManyRequestsError(message);
  await tx.insert(rateEvent).values({ userId, kind, subject: opts.subject ?? null, ...(opts.now ? { at: opts.now } : {}) });
}

/** Undo one `consumeRate` (the newest row) when the work it paid for never happened. */
export async function releaseRate(tx: Tx, userId: string, kind: RateKind): Promise<void> {
  // Same lock as consumeRate: two concurrent refunds must not both pick the same newest row.
  await advisoryLock(tx, `rate:${kind}:${userId}`);
  await tx.execute(sql`
    delete from rate_event where id = (
      select id from rate_event where user_id = ${userId} and kind = ${kind} order by at desc limit 1
    )
  `);
}

/** Undo one `reserveDaily` for today. Never goes below zero. */
export async function releaseDaily(tx: Executor, kind: DailyKind): Promise<void> {
  await tx.execute(sql`update daily_usage set count = greatest(count - 1, 0) where day = ${today} and kind = ${kind}`);
}

/** Read-only look at whether `userId` is already at `limit` for `kind` in the window (default one hour). Advisory: `consumeRate` decides. */
export async function rateIsFull(userId: string, kind: RateKind, limit: number, opts: { windowSeconds?: number } = {}): Promise<boolean> {
  const { rateEvent } = schema;
  const window = sql`make_interval(secs => ${opts.windowSeconds ?? HOUR_SECONDS})`;
  const [{ n }] = await db()
    .select({ n: count() })
    .from(rateEvent)
    .where(and(eq(rateEvent.userId, userId), eq(rateEvent.kind, kind), gt(rateEvent.at, sql`now() - ${window}`)));
  return n >= limit;
}
