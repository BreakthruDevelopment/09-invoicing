/**
 * Describe an error for a log line without leaking what caused it.
 *
 * Some error messages embed user data:
 * - drizzle-orm's `DrizzleQueryError`: `Failed query: <sql>\nparams: <values>`.
 * - A Postgres error's `detail`: `Key (email)=(ada@example.com) already exists`.
 * - `JSON.parse`'s SyntaxError quotes a snippet of the body it choked on.
 * For these this returns a fixed message, plus (database errors only) the SQLSTATE `code` and `constraint` name.
 * Database errors are recognised anywhere in the `cause` chain (up to 5 levels) by their shape, not their class:
 * a `query`/`params` field, or the postgres.js, node-postgres and Neon fields `severity`, `routine`, `constraint`
 * and `detail`, so a driver swap doesn't silently reopen the leak.
 * Every other error keeps its `message`. That is only safe while our own code writes those messages from fixed
 * text, so never build an error message out of request data. Always log `safeErrorFields(err)`, never
 * `err.message` or the error object itself.
 */
export function safeErrorFields(err: unknown): { error: string; name?: string; code?: string; constraint?: string } {
  if (!(err instanceof Error)) return { error: "non-error thrown" };
  const chain = causeChain(err);
  if (chain.some(looksLikeDatabaseError)) {
    const fields: { code?: string; constraint?: string } = {};
    for (const link of chain) {
      const found = pick(link);
      fields.code ??= found.code;
      fields.constraint ??= found.constraint;
    }
    return { error: "database query failed", name: err.name, ...fields };
  }
  if (chain.some((e) => e instanceof SyntaxError)) return { error: "invalid JSON or syntax", name: err.name };
  return { error: err.message, name: err.name };
}

const MAX_CAUSE_DEPTH = 5;

function causeChain(err: Error): Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = [];
  let current: unknown = err;
  while (current && typeof current === "object" && chain.length < MAX_CAUSE_DEPTH) {
    chain.push(current as Record<string, unknown>);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function looksLikeDatabaseError(e: Record<string, unknown>): boolean {
  if (e.name === "DrizzleQueryError" || e.name === "PostgresError" || e.name === "DatabaseError") return true;
  return ["query", "params", "severity", "routine", "constraint", "constraint_name", "detail"].some((k) => Object.hasOwn(e, k));
}

function pick(source: Record<string, unknown>): { code?: string; constraint?: string } {
  const out: { code?: string; constraint?: string } = {};
  if (typeof source.code === "string" && /^[0-9A-Z]{5}$/.test(source.code)) out.code = source.code;
  const constraint = source.constraint_name ?? source.constraint;
  // Constraint names are schema identifiers; refuse anything that doesn't look like one.
  if (typeof constraint === "string" && /^[A-Za-z0-9_]{1,63}$/.test(constraint)) out.constraint = constraint;
  return out;
}
