import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, it, vi } from "vitest";
import { ConflictError, NotFoundError, PayloadTooLargeError, TooManyRequestsError } from "@/lib/errors";
import { errorInfo, errorResponse, readJson } from "@/lib/http";

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/items", { method: "POST", body, headers });

describe("readJson", () => {
  it("parses a JSON body", async () => {
    expect(await readJson(post('{"a":1}'))).toEqual({ a: 1 });
  });

  it("rejects a body over the cap with 413, by streaming count", async () => {
    const err = await readJson(post("x".repeat(2000)), 1000).catch((e) => e);
    expect(errorInfo(err).status).toBe(413);
  });

  it("rejects a lying small Content-Length on a big body, and an honest large one", async () => {
    const big = JSON.stringify({ body: "x".repeat(2000) });
    expect(errorInfo(await readJson(post(big, { "content-length": "10" }), 1000).catch((e) => e)).status).toBe(413);
    expect(errorInfo(await readJson(post("{}", { "content-length": "99999" }), 1000).catch((e) => e)).status).toBe(413);
  });

  it("accepts a body at exactly the cap", async () => {
    const body = JSON.stringify({ a: "x".repeat(100) });
    expect(await readJson(post(body), body.length)).toBeTruthy();
  });

  it("answers 400 for malformed JSON, an empty body, and invalid UTF-8", async () => {
    for (const bad of [post("{nope"), post(""), post(null), post(new Uint8Array([0xff, 0xfe, 0x7b]))]) {
      const info = errorInfo(await readJson(bad).catch((e) => e));
      expect(info.status).toBe(400);
      expect(info.body.error).toBe("Body must be valid JSON");
    }
  });
});

describe("errorResponse logging (issue #16)", () => {
  const CANARY = "secret-canary@example.com";

  async function logged(err: unknown) {
    const { log } = await import("@/lib/log");
    const spy = vi.spyOn(log, "error").mockImplementation(() => {});
    try {
      const res = errorResponse(err);
      return { res, lines: JSON.stringify(spy.mock.calls) };
    } finally {
      spy.mockRestore();
    }
  }

  it("never logs the parameters of a DrizzleQueryError, only the SQLSTATE and constraint", async () => {
    const cause = Object.assign(new Error(`duplicate key (${CANARY})`), { code: "23505", constraint_name: "user_email_unique", detail: `Key (email)=(${CANARY}) already exists.` });
    const err = new DrizzleQueryError("insert into \"user\" (email) values ($1)", [CANARY], cause);
    expect(err.message).toContain(CANARY); // the premise: the message itself carries the parameter
    const { res, lines } = await logged(err);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Something went wrong" });
    expect(lines).not.toContain(CANARY);
    expect(lines).not.toContain("insert into");
    expect(lines).toContain("23505");
    expect(lines).toContain("user_email_unique");
  });

  it("treats any error carrying .query or .params as a database error", async () => {
    const { lines } = await logged(Object.assign(new Error(`bad ${CANARY}`), { query: "select 1", params: [CANARY] }));
    expect(lines).not.toContain(CANARY);
  });

  it("treats a bare postgres.js PostgresError as a database error", async () => {
    const err = Object.assign(new Error("value too long"), { name: "PostgresError", code: "22001", detail: CANARY });
    const { lines } = await logged(err);
    expect(lines).not.toContain(CANARY);
    expect(lines).toContain("22001");
  });

  it("still logs the message of an ordinary error", async () => {
    const { lines } = await logged(new Error("provider exploded"));
    expect(lines).toContain("provider exploded");
  });

  it("maps typed errors without logging them", async () => {
    const { log } = await import("@/lib/log");
    const spy = vi.spyOn(log, "error").mockImplementation(() => {});
    for (const [err, status] of [
      [new NotFoundError(), 404],
      [new ConflictError(), 409],
      [new TooManyRequestsError(), 429],
      [new PayloadTooLargeError(10), 413],
    ] as const) {
      expect(errorResponse(err).status).toBe(status);
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
