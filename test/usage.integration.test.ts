/** consumeRate holds under a race only inside a transaction, which its `Tx` type now requires. */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("rate limits (Postgres)", () => {
  let sql: postgres.Sql;
  let usage: typeof import("@/lib/usage");
  let database: ReturnType<typeof import("@/lib/db").db>;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await sql`insert into "user" (id, name, email) values ('use-a', 'a', 'use-a@test.local') on conflict do nothing`;
    usage = await import("@/lib/usage");
    database = (await import("@/lib/db")).db();
  });
  afterAll(async () => {
    await sql`delete from "user" where id like 'use-%'`;
    await sql`delete from daily_usage where kind = 'demo_load'`;
    await sql.end();
  });

  it("lets exactly `limit` of 20 parallel calls through", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => database.transaction((tx) => usage.consumeRate(tx, "use-a", "api_write", 5, "slow down"))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(results.filter((r) => r.status === "rejected" && (r.reason as { status?: number }).status === 429)).toHaveLength(15);
  });

  it("rateIsFull reads the same window", async () => {
    expect(await usage.rateIsFull("use-a", "api_write", 5)).toBe(true);
    expect(await usage.rateIsFull("use-a", "api_write", 6)).toBe(false);
    expect(await usage.rateIsFull("use-a", "api_write", 5, { windowSeconds: 0 })).toBe(false);
  });

  it("the window slides: old attempts stop counting, new ones start to", async () => {
    await sql`insert into "user" (id, name, email) values ('use-b', 'b', 'use-b@test.local') on conflict do nothing`;
    const t0 = new Date(Date.now() - 2 * 3600_000);
    for (let i = 0; i < 3; i++) await database.transaction((tx) => usage.consumeRate(tx, "use-b", "ai", 3, "slow", { now: new Date(t0.getTime() + i * 1000) }));
    // Inside the hour after t0 the fourth is refused ...
    await expect(database.transaction((tx) => usage.consumeRate(tx, "use-b", "ai", 3, "slow", { now: new Date(t0.getTime() + 60_000) }))).rejects.toMatchObject({ status: 429 });
    // ... and an hour later the old rows no longer count (and are pruned).
    await database.transaction((tx) => usage.consumeRate(tx, "use-b", "ai", 3, "slow", { now: new Date(t0.getTime() + 3600_000 + 5_000) }));
    const [{ n }] = await sql`select count(*)::int as n from rate_event where user_id = 'use-b' and kind = 'ai'`;
    expect(n).toBe(1);
  });

  it("a subject makes the limit per thing: separate allowances, and subject-less calls don't count them", async () => {
    await sql`insert into "user" (id, name, email) values ('use-e', 'e', 'use-e@test.local') on conflict do nothing`;
    const run = (subject?: string) => database.transaction((tx) => usage.consumeRate(tx, "use-e", "checkout", 2, "slow", { subject }));
    await run("inv-1");
    await run("inv-1");
    await expect(run("inv-1")).rejects.toMatchObject({ status: 429 });
    await run("inv-2");
    await run(); // no subject: its own bucket
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => run("inv-3")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
  });

  it("releaseRate with a subject undoes only that subject's newest attempt", async () => {
    await sql`insert into "user" (id, name, email) values ('use-f', 'f', 'use-f@test.local') on conflict do nothing`;
    const run = (subject?: string) => database.transaction((tx) => usage.consumeRate(tx, "use-f", "checkout", 5, "slow", { subject }));
    await run("a");
    await run("b");
    await run("b");
    await database.transaction((tx) => usage.releaseRate(tx, "use-f", "checkout", { subject: "b" }));
    const rows = await sql`select subject, count(*)::int as n from rate_event where user_id = 'use-f' group by subject order by subject`;
    expect(rows.map((r) => [r.subject, r.n])).toEqual([["a", 1], ["b", 1]]);
  });

  it("releaseRate undoes the newest attempt", async () => {
    await sql`insert into "user" (id, name, email) values ('use-c', 'c', 'use-c@test.local') on conflict do nothing`;
    await database.transaction((tx) => usage.consumeRate(tx, "use-c", "checkout", 1, "slow"));
    expect(await usage.rateIsFull("use-c", "checkout", 1)).toBe(true);
    await database.transaction((tx) => usage.releaseRate(tx, "use-c", "checkout"));
    expect(await usage.rateIsFull("use-c", "checkout", 1)).toBe(false);
  });

  it("reserveDaily lets exactly `cap` of 20 parallel reservations through, and releaseDaily gives one back", async () => {
    await sql`delete from daily_usage where kind = 'demo_load'`;
    const results = await Promise.all(Array.from({ length: 20 }, () => database.transaction((tx) => usage.reserveDaily(tx, "demo_load", 4))));
    expect(results.filter(Boolean)).toHaveLength(4);
    expect(await usage.dailyCount("demo_load")).toBe(4);
    await database.transaction((tx) => usage.releaseDaily(tx, "demo_load"));
    expect(await usage.dailyCount("demo_load")).toBe(3);
    expect(await database.transaction((tx) => usage.reserveDaily(tx, "demo_load", 4))).toBe(true);
    expect(await database.transaction((tx) => usage.reserveDaily(tx, "demo_load", 4))).toBe(false);
  });

  it("reserveDaily with cap 0 (or less) never lets anything through, even on a fresh day", async () => {
    await sql`delete from daily_usage where kind = 'ai'`;
    expect(await database.transaction((tx) => usage.reserveDaily(tx, "ai", 0))).toBe(false);
    expect(await database.transaction((tx) => usage.reserveDaily(tx, "ai", -1))).toBe(false);
    expect(await usage.dailyCount("ai")).toBe(0);
  });

  it("concurrent releaseRate calls each refund one distinct attempt", async () => {
    await sql`insert into "user" (id, name, email) values ('use-d', 'd', 'use-d@test.local') on conflict do nothing`;
    for (let i = 0; i < 5; i++) await database.transaction((tx) => usage.consumeRate(tx, "use-d", "ai", 10, "slow"));
    await Promise.all(Array.from({ length: 3 }, () => database.transaction((tx) => usage.releaseRate(tx, "use-d", "ai"))));
    const [{ n }] = await sql`select count(*)::int as n from rate_event where user_id = 'use-d' and kind = 'ai'`;
    expect(n).toBe(2);
  });

  it("does not accept a pool handle (type-level)", () => {
    // @ts-expect-error a pool handle is not a transaction
    void (() => usage.consumeRate(database, "use-a", "api_write", 5, "x"));
  });
});
