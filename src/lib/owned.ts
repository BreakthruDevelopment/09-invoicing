import { type SQL, and, eq } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * Ownership, once. For tables whose rows are private to their owner, admin included, so `can()` (which lets admin
 * through) is deliberately not used. Put this fragment in every select, update and delete of such a table; extra
 * conditions are ANDed in. It only filters: when it matches zero rows the caller turns that into
 * `NotFoundError` (404, so a stranger can't tell a missing row from someone else's). Tables key the owner as
 * `ownerId` or `userId`.
 */
export function ownedBy(
  table: { ownerId: PgColumn } | { userId: PgColumn },
  actor: { id: string },
  ...and_: (SQL | undefined)[]
): SQL {
  const column = "ownerId" in table ? table.ownerId : table.userId;
  return and(eq(column, actor.id), ...and_) as SQL;
}
