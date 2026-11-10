import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, it } from "vitest";
import { safeErrorFields } from "@/lib/safe-error";

describe("safeErrorFields", () => {
  it("keeps only the code and constraint of a database error", () => {
    const cause = Object.assign(new Error("x"), { code: "23505", constraint_name: "item_pkey", detail: "Key (id)=(secret) already exists." });
    const out = safeErrorFields(new DrizzleQueryError("select $1", ["secret"], cause));
    expect(out).toEqual({ error: "database query failed", name: "Error", code: "23505", constraint: "item_pkey" });
  });

  it("drops a code or constraint that doesn't look like one", () => {
    const cause = { code: "secret@example.com", constraint_name: "has spaces (secret)" };
    const out = safeErrorFields(new DrizzleQueryError("select $1", ["x"], cause as unknown as Error));
    expect(out).toEqual({ error: "database query failed", name: "Error" });
  });

  it("passes ordinary errors and non-errors through safely", () => {
    expect(safeErrorFields(new TypeError("nope"))).toEqual({ error: "nope", name: "TypeError" });
    expect(safeErrorFields("secret string")).toEqual({ error: "non-error thrown" });
  });
});

describe("safeErrorFields (other drivers, wrapped errors, syntax errors)", () => {
  const CANARY = "secret-canary@example.com";

  it("recognises node-postgres and Neon shaped errors by their own severity and detail", () => {
    const err = Object.assign(new Error(`duplicate key value (${CANARY})`), { severity: "ERROR", code: "23505", detail: `Key (email)=(${CANARY}) already exists.`, constraint: "user_email_unique" });
    const out = safeErrorFields(err);
    expect(JSON.stringify(out)).not.toContain(CANARY);
    expect(out).toMatchObject({ error: "database query failed", code: "23505", constraint: "user_email_unique" });
  });

  it("finds a database error several causes deep", () => {
    const db = Object.assign(new Error(`params: ${CANARY}`), { name: "PostgresError", code: "23503", constraint_name: "fk_owner" });
    const wrapped = new Error("create failed", { cause: new Error("tx failed", { cause: new Error("step failed", { cause: db }) }) });
    const out = safeErrorFields(wrapped);
    expect(out).toMatchObject({ error: "database query failed", code: "23503", constraint: "fk_owner" });
    expect(JSON.stringify(out)).not.toContain(CANARY);
  });

  it("does not loop on a cyclic cause chain", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(safeErrorFields(a)).toEqual({ error: "a", name: "Error" });
  });

  it("redacts a SyntaxError from JSON.parse", () => {
    let err: unknown;
    try {
      JSON.parse(`{"note": "${CANARY}" oops`);
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toContain("JSON");
    const out = safeErrorFields(err);
    expect(out.error).toBe("invalid JSON or syntax");
    expect(JSON.stringify(out)).not.toContain(CANARY);
  });

  it("does not mistake a Node system error for a database error", () => {
    expect(safeErrorFields(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))).toEqual({ error: "connect ECONNREFUSED", name: "Error" });
  });
});
