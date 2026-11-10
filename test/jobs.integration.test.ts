/** Background job queue against Postgres: idempotent enqueue, exclusive claims, leases, backoff, retry, worker behaviour. */
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;

type Queue = typeof import("@/lib/jobs/queue");
type WorkerMod = typeof import("@/lib/jobs/worker");

describe.skipIf(!url)("background jobs (Postgres)", () => {
  let sql: postgres.Sql;
  let q: Queue;
  let w: WorkerMod;
  let db: ReturnType<typeof import("@/lib/db").db>;
  let n = 0;
  const kind = () => `test.k${++n}`;
  const LEASE = 60_000;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.LOG_LEVEL = "error";
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    await sql`insert into "user" (id, name, email) values ('job-a', 'a', 'job-a@test.local'), ('job-b', 'b', 'job-b@test.local') on conflict do nothing`;
    q = await import("@/lib/jobs/queue");
    w = await import("@/lib/jobs/worker");
    db = (await import("@/lib/db")).db();
  });
  afterEach(async () => {
    await w.stopWorker();
    delete process.env.JOBS_WORKER;
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await sql`delete from job where kind like 'test.%'`;
    await sql`delete from "user" where id like 'job-%'`;
    await sql.end();
  });

  const row = async (id: string) => (await sql`select *, extract(epoch from (run_after - now())) as in_secs from job where id = ${id}`)[0];
  const claimOne = async (k: string) => (await q.claim(db, { kinds: [k], limit: 1, leaseMs: LEASE }))[0];
  const due = (id: string) => sql`update job set run_after = now() - interval '1 second' where id = ${id}`;

  describe("enqueue", () => {
    it("is idempotent by (kind, key) while a job is queued or running", async () => {
      const k = kind();
      const first = await q.enqueue(db, { kind: k, key: "a" });
      const second = await q.enqueue(db, { kind: k, key: "a" });
      expect(first.created).toBe(true);
      expect(second).toEqual({ id: first.id, created: false });
      const claimed = await claimOne(k);
      expect((await q.enqueue(db, { kind: k, key: "a" })).id).toBe(first.id); // running counts too
      expect((await q.enqueue(db, { kind: k, key: "b" })).created).toBe(true); // other key
      expect((await q.enqueue(db, { kind: kind(), key: "a" })).created).toBe(true); // other kind
      await q.complete(db, claimed);
      expect((await q.enqueue(db, { kind: k, key: "a" })).created).toBe(true); // finished jobs don't block
    });

    it("lets 10 parallel enqueues of one key create exactly one job", async () => {
      const k = kind();
      const results = await Promise.all(Array.from({ length: 10 }, () => q.enqueue(db, { kind: k, key: "same" })));
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1);
    });

    it("allows duplicates without a key, and rejects bad input", async () => {
      const k = kind();
      const a = await q.enqueue(db, { kind: k });
      const b = await q.enqueue(db, { kind: k });
      expect(a.id).not.toBe(b.id);
      await expect(q.enqueue(db, { kind: "Bad Kind" })).rejects.toThrow();
      await expect(q.enqueue(db, { kind: k, payload: { big: "x".repeat(5000) } })).rejects.toThrow();
    });

    it("rolls back with the surrounding transaction", async () => {
      const k = kind();
      await expect(
        db.transaction(async (tx) => {
          await q.enqueue(tx, { kind: k, key: "r" });
          throw new Error("save failed");
        }),
      ).rejects.toThrow("save failed");
      expect(await q.jobStatus(db, { kind: k, key: "r" })).toBeNull();
    });

    it("honours delayMs", async () => {
      const k = kind();
      await q.enqueue(db, { kind: k, delayMs: 60_000 });
      expect(await q.claim(db, { kinds: [k], limit: 5, leaseMs: LEASE })).toHaveLength(0);
    });
  });

  describe("claim", () => {
    it("hands every job to exactly one of many concurrent claimers", async () => {
      const k = kind();
      const ids = await Promise.all(Array.from({ length: 30 }, (_, i) => q.enqueue(db, { kind: k, key: `j${i}` }).then((r) => r.id)));
      const batches = await Promise.all(Array.from({ length: 8 }, () => q.claim(db, { kinds: [k], limit: 7, leaseMs: LEASE })));
      const claimed = batches.flat().map((j) => j.id);
      expect(claimed).toHaveLength(30);
      expect(new Set(claimed).size).toBe(30);
      expect(new Set(claimed)).toEqual(new Set(ids));
    });

    it("gives one job to exactly one of 12 racing claimers", async () => {
      const k = kind();
      await q.enqueue(db, { kind: k, key: "solo" });
      const results = await Promise.all(Array.from({ length: 12 }, () => q.claim(db, { kinds: [k], limit: 1, leaseMs: LEASE })));
      expect(results.flat()).toHaveLength(1);
    });

    it("only claims registered kinds and due jobs", async () => {
      const [a, b] = [kind(), kind()];
      await q.enqueue(db, { kind: a });
      expect(await q.claim(db, { kinds: [b], limit: 5, leaseMs: LEASE })).toHaveLength(0);
      expect(await q.claim(db, { kinds: [], limit: 5, leaseMs: LEASE })).toHaveLength(0);
      expect(await q.claim(db, { kinds: [a], limit: 5, leaseMs: LEASE })).toHaveLength(1);
    });

    it("two workers never run one job twice", async () => {
      const k = kind();
      for (let i = 0; i < 40; i++) await q.enqueue(db, { kind: k, key: `w${i}` });
      const runs = new Map<string, number>();
      const handlers = {
        [k]: async (job: { id: string }) => {
          runs.set(job.id, (runs.get(job.id) ?? 0) + 1);
          await new Promise((r) => setTimeout(r, 5));
        },
      };
      const [w1, w2] = [w.createWorker({ handlers, concurrency: 3 }), w.createWorker({ handlers, concurrency: 3 })];
      await Promise.all([w1.kick(), w2.kick()]);
      expect(runs.size).toBe(40);
      expect([...runs.values()].every((c) => c === 1)).toBe(true);
      expect((await sql`select count(*)::int as n from job where kind = ${k} and status = 'done'`)[0].n).toBe(40);
    });
  });

  describe("leases", () => {
    it("reclaims a job whose lease expired, and fences the stale worker", async () => {
      const k = kind();
      const { id } = await q.enqueue(db, { kind: k, key: "x" });
      const first = await claimOne(k);
      expect(first.attempts).toBe(1);
      expect(await claimOne(k)).toBeUndefined(); // lease still held
      await sql`update job set locked_until = now() - interval '1 second' where id = ${id}`; // the worker died
      const second = await claimOne(k);
      expect(second).toMatchObject({ id, attempts: 2 });
      expect(second.lockToken).not.toBe(first.lockToken);
      // The first worker wakes up late: it can neither complete nor fail the job.
      expect(await q.complete(db, first)).toBe(false);
      expect(await q.fail(db, first, { code: "error" })).toBeNull();
      expect((await row(id)).status).toBe("running");
      expect(await q.complete(db, second)).toBe(true);
    });

    it("a lease that expires after the last attempt ends as failed, not stuck", async () => {
      const k = kind();
      const { id } = await q.enqueue(db, { kind: k, key: "poison", maxAttempts: 2 });
      await claimOne(k);
      await sql`update job set locked_until = now() - interval '1 second' where id = ${id}`;
      await claimOne(k);
      await sql`update job set locked_until = now() - interval '1 second' where id = ${id}`;
      expect(await claimOne(k)).toBeUndefined(); // attempts used up
      expect(await q.failExhausted(db, [k])).toBe(1);
      expect(await row(id)).toMatchObject({ status: "failed", last_error: "lease_expired" });
      expect((await q.enqueue(db, { kind: k, key: "poison" })).created).toBe(true); // key is free again
    });

    it("a job left running by a killed process finishes after a restart", async () => {
      const k = kind();
      const { id } = await q.enqueue(db, { kind: k, key: "crash" });
      await claimOne(k); // "process 1" claims and dies
      await sql`update job set locked_until = now() - interval '1 second' where id = ${id}`;
      const handled = vi.fn(async () => {});
      await w.createWorker({ handlers: { [k]: handled } }).kick(); // "process 2"
      expect(handled).toHaveBeenCalledOnce();
      expect((await row(id)).status).toBe("done");
    });
  });

  describe("failure handling", () => {
    it("backs off 15 s, 1 min, 4 min, then fails after the 4th attempt", async () => {
      const k = kind();
      const { id } = await q.enqueue(db, { kind: k, key: "flaky" });
      const expected = [15, 60, 240];
      for (const secs of expected) {
        const j = await claimOne(k);
        expect(await q.fail(db, j, { code: "network" })).toBe("queued");
        const r = await row(id);
        expect(r).toMatchObject({ status: "queued", last_error: "network" });
        expect(Number(r.in_secs)).toBeGreaterThan(secs - 3);
        expect(Number(r.in_secs)).toBeLessThanOrEqual(secs);
        expect(await claimOne(k)).toBeUndefined(); // not due yet
        await due(id);
      }
      const last = await claimOne(k);
      expect(last.attempts).toBe(4);
      expect(await q.fail(db, last, { code: "network" })).toBe("failed");
      expect(await row(id)).toMatchObject({ status: "failed", attempts: 4, last_error: "network" });
      expect(q.backoffMs(1)).toBe(15_000);
      expect(q.backoffMs(2)).toBe(60_000);
      expect(q.backoffMs(3)).toBe(240_000);
    });

    it("a permanent failure skips the retries; a deferral doesn't use an attempt", async () => {
      const k = kind();
      const { id } = await q.enqueue(db, { kind: k, key: "p" });
      const j = await claimOne(k);
      expect(await q.fail(db, j, { code: "blocked_address", permanent: true })).toBe("failed");
      expect((await row(id)).status).toBe("failed");

      const d = await q.enqueue(db, { kind: k, key: "d" });
      const dj = await claimOne(k);
      expect(await q.fail(db, dj, { code: "host_busy", deferMs: 5_000 })).toBe("queued");
      const r = await row(d.id);
      expect(r.attempts).toBe(0);
      expect(Number(r.in_secs)).toBeLessThanOrEqual(5);
    });

    it("rejects error codes that look like messages", async () => {
      const k = kind();
      const { id } = await q.enqueue(db, { kind: k });
      await q.fail(db, await claimOne(k), { code: "could not reach ada@example.com" });
      expect((await row(id)).last_error).toBe("error");
    });

    it("manual retry puts a failed job back, scoped to its owner", async () => {
      const k = kind();
      const { id } = await q.enqueue(db, { kind: k, key: "m", ownerId: "job-a", maxAttempts: 1 });
      expect(await q.retryJob(db, { id })).toBe("not_found"); // not failed yet
      await q.fail(db, await claimOne(k), { code: "error" });
      expect((await row(id)).status).toBe("failed");
      expect(await q.retryJob(db, { id }, { ownerId: "job-b" })).toBe("not_found"); // someone else's
      expect(await q.retryJob(db, { kind: k, key: "m" }, { ownerId: "job-a" })).toBe("retried");
      expect(await row(id)).toMatchObject({ status: "queued", attempts: 0, last_error: null });
      expect(await claimOne(k)).toMatchObject({ id, attempts: 1 }); // due at once
    });

    it("retry refuses when a newer job with the same key is active", async () => {
      const k = kind();
      const { id } = await q.enqueue(db, { kind: k, key: "dup", maxAttempts: 1 });
      await q.fail(db, await claimOne(k), { code: "error" });
      await q.enqueue(db, { kind: k, key: "dup" }); // the user saved again
      expect(await q.retryJob(db, { id })).toBe("already_active");
      expect((await row(id)).status).toBe("failed");
    });
  });

  describe("worker", () => {
    it("runs the handler, retries a failure after its backoff, and ends done", async () => {
      const k = kind();
      const { id } = await q.enqueue(db, { kind: k, key: "r" });
      let calls = 0;
      const worker = w.createWorker({
        handlers: {
          [k]: async (_j, ctx) => {
            calls++;
            expect(ctx.attempt).toBe(calls);
            if (calls === 1) throw new Error("boom");
          },
        },
      });
      await worker.kick();
      expect(await q.jobStatus(db, { kind: k, key: "r" })).toMatchObject({ state: "retrying", attempts: 1, lastError: "error" });
      await worker.kick();
      expect(calls).toBe(1); // backoff not over: a kick does not skip it
      await due(id);
      await worker.kick();
      expect(await q.jobStatus(db, { kind: k, key: "r" })).toMatchObject({ state: "done", attempts: 2 });
    });

    it("JobError permanent fails at once; unknown errors are retryable", async () => {
      const [a, b] = [kind(), kind()];
      await q.enqueue(db, { kind: a, key: "1" });
      await q.enqueue(db, { kind: b, key: "1" });
      await w
        .createWorker({
          handlers: {
            [a]: async () => {
              throw new w.JobError("too_large", { permanent: true });
            },
            [b]: async () => {
              throw new Error("anything");
            },
          },
        })
        .kick();
      expect(await q.jobStatus(db, { kind: a, key: "1" })).toMatchObject({ state: "failed", lastError: "too_large" });
      expect(await q.jobStatus(db, { kind: b, key: "1" })).toMatchObject({ state: "retrying" });
    });

    it("times out a handler that hangs, aborting its signal", async () => {
      const k = kind();
      await q.enqueue(db, { kind: k, key: "slow" });
      let aborted = false;
      const worker = w.createWorker({
        timeoutMs: 80,
        leaseMs: 1_000,
        handlers: {
          [k]: (_j, ctx) => {
            ctx.signal.addEventListener("abort", () => (aborted = true));
            return new Promise(() => {}); // never settles
          },
        },
      });
      const started = Date.now();
      await worker.kick();
      expect(Date.now() - started).toBeLessThan(900);
      expect(aborted).toBe(true);
      expect(await q.jobStatus(db, { kind: k, key: "slow" })).toMatchObject({ state: "retrying", lastError: "timeout" });
    });

    it("rejects a timeout that isn't shorter than the lease", () => {
      expect(() => w.createWorker({ handlers: {}, timeoutMs: 60_000, leaseMs: 60_000 })).toThrow(/shorter/);
    });

    it("never runs more than `concurrency` jobs at once, and still finishes them all", async () => {
      const k = kind();
      for (let i = 0; i < 7; i++) await q.enqueue(db, { kind: k, key: `c${i}` });
      let live = 0;
      let peak = 0;
      const worker = w.createWorker({
        concurrency: 2,
        handlers: {
          [k]: async () => {
            peak = Math.max(peak, ++live);
            await new Promise((r) => setTimeout(r, 20));
            live--;
          },
        },
      });
      await worker.kick();
      expect(peak).toBe(2);
      expect((await sql`select count(*)::int as n from job where kind = ${k} and status = 'done'`)[0].n).toBe(7);
    });

    it("overlapping kicks and nudges don't double-run anything", async () => {
      const k = kind();
      for (let i = 0; i < 5; i++) await q.enqueue(db, { kind: k, key: `o${i}` });
      const handled = vi.fn(async () => {});
      const worker = w.createWorker({ handlers: { [k]: handled }, nudgeMs: 0 });
      worker.nudge();
      await Promise.all([worker.kick(), worker.kick(), Promise.resolve(worker.nudge()), worker.kick()]);
      expect(handled).toHaveBeenCalledTimes(5);
    });

    it("nudge does something at most once per nudgeMs", async () => {
      const k = kind();
      await q.enqueue(db, { kind: k, key: "n" });
      let clock = 1_000_000;
      const worker = w.createWorker({ handlers: { [k]: async () => {} }, nudgeMs: 10_000, now: () => clock });
      expect(worker.nudge()).toBe(true);
      expect(worker.nudge()).toBe(false);
      clock += 9_999;
      expect(worker.nudge()).toBe(false);
      clock += 1;
      expect(worker.nudge()).toBe(true);
      await worker.kick();
    });

    it("stop() waits for running jobs and claims nothing afterwards", async () => {
      const k = kind();
      await q.enqueue(db, { kind: k, key: "s1" });
      let finished = false;
      const worker = w.createWorker({
        handlers: {
          [k]: async () => {
            await new Promise((r) => setTimeout(r, 50));
            finished = true;
          },
        },
      });
      worker.nudge();
      await vi.waitFor(() => expect(worker.inFlight()).toBe(1));
      await worker.stop();
      expect(finished).toBe(true);
      await q.enqueue(db, { kind: k, key: "s2" });
      await worker.kick();
      expect((await q.jobStatus(db, { kind: k, key: "s2" }))?.state).toBe("queued");
    });

    it("JOBS_WORKER=off starts nothing and makes kick and nudge no-ops", async () => {
      const k = kind();
      await q.enqueue(db, { kind: k, key: "off" });
      process.env.JOBS_WORKER = "off";
      const handled = vi.fn(async () => {});
      await w.startWorker({ handlers: { [k]: handled }, intervalMs: 20 }).stop();
      await w.kick();
      expect(w.nudge()).toBe(false);
      await new Promise((r) => setTimeout(r, 80));
      expect(handled).not.toHaveBeenCalled();
      expect((await q.jobStatus(db, { kind: k, key: "off" }))?.state).toBe("queued");
    });

    it("startWorker runs leftovers at once, kick() and nudge() use it, and a second start reuses it", async () => {
      const k = kind();
      await q.enqueue(db, { kind: k, key: "left" });
      const handled = vi.fn(async () => {});
      w.startWorker({ handlers: { [k]: handled }, intervalMs: 60_000 });
      w.startWorker({ handlers: { [k]: vi.fn() }, intervalMs: 60_000 });
      await vi.waitFor(() => expect(handled).toHaveBeenCalledOnce());
      await q.enqueue(db, { kind: k, key: "after" });
      await w.kick();
      expect(handled).toHaveBeenCalledTimes(2);
    });

    it("never logs the payload or a handler's error text", async () => {
      const k = kind();
      await q.enqueue(db, { kind: k, key: "log", payload: { email: "ada@example.com" } });
      process.env.LOG_LEVEL = "debug";
      const out: string[] = [];
      for (const m of ["log", "error"] as const) vi.spyOn(console, m).mockImplementation((line: string) => void out.push(String(line)));
      await w
        .createWorker({
          handlers: {
            [k]: async (job) => {
              throw new Error(`failed for ${job.payload.email}`);
            },
          },
        })
        .kick();
      process.env.LOG_LEVEL = "error";
      expect(out.some((l) => l.includes("jobs.attempt_failed"))).toBe(true);
      expect(out.join("\n")).not.toContain("ada@example.com");
    });
  });

  describe("inline mode (Lambda, Cloud Run)", () => {
    it("picks inline from JOBS_WORKER=inline or a Lambda environment, and honours off", () => {
      expect(w.workerMode({})).toBe("timer");
      expect(w.workerMode({ JOBS_WORKER: "inline" })).toBe("inline");
      expect(w.workerMode({ AWS_LAMBDA_FUNCTION_NAME: "fn" })).toBe("inline");
      expect(w.workerMode({ AWS_LAMBDA_FUNCTION_NAME: "fn", JOBS_WORKER: "off" })).toBe("off");
      expect(w.workerMode({ JOBS_WORKER: "garbage" })).toBe("timer");
    });

    it("runs nothing on its own: no timer start, nudge is a no-op", async () => {
      const k = kind();
      await q.enqueue(db, { kind: k, key: "idle" });
      const handled = vi.fn(async () => {});
      const worker = w.createWorker({ mode: "inline", handlers: { [k]: handled }, intervalMs: 10, nudgeMs: 0 });
      worker.start();
      expect(worker.nudge()).toBe(false);
      await new Promise((r) => setTimeout(r, 80));
      expect(handled).not.toHaveBeenCalled();
      await worker.kick();
      expect(handled).toHaveBeenCalledOnce();
    });

    it("startWorker in a Lambda environment runs only inside an awaited kick", async () => {
      const k = kind();
      process.env.AWS_LAMBDA_FUNCTION_NAME = "fn";
      try {
        const { id } = await q.enqueue(db, { kind: k, key: "lam" });
        const handled = vi.fn(async () => {});
        w.startWorker({ handlers: { [k]: handled }, intervalMs: 10 });
        expect(w.nudge()).toBe(false);
        await new Promise((r) => setTimeout(r, 60));
        expect(handled).not.toHaveBeenCalled();
        await w.kick({ ids: [id] });
        expect(handled).toHaveBeenCalledOnce();
      } finally {
        delete process.env.AWS_LAMBDA_FUNCTION_NAME;
      }
    });

    it("kick({ ids }) runs only those jobs", async () => {
      const k = kind();
      const a = await q.enqueue(db, { kind: k, key: "a" });
      await q.enqueue(db, { kind: k, key: "b" });
      const seen: string[] = [];
      await w.createWorker({ mode: "inline", handlers: { [k]: async (j) => void seen.push(j.id) } }).kick({ ids: [a.id, "not-a-uuid"] });
      expect(seen).toEqual([a.id]);
      expect((await q.jobStatus(db, { kind: k, key: "b" }))?.state).toBe("queued");
    });

    it("stops at the budget: later jobs stay queued, a running job's timeout is cut to what is left", async () => {
      const k = kind();
      for (let i = 0; i < 4; i++) await q.enqueue(db, { kind: k, key: `b${i}` });
      let aborted = 0;
      const worker = w.createWorker({
        mode: "inline",
        concurrency: 1,
        timeoutMs: 20_000,
        leaseMs: 60_000,
        handlers: {
          [k]: (_j, ctx) =>
            new Promise<void>((resolve) => {
              const t = setTimeout(resolve, 150);
              ctx.signal.addEventListener("abort", () => {
                aborted++;
                clearTimeout(t);
                resolve();
              });
            }),
        },
      });
      const started = Date.now();
      await worker.kick({ budgetMs: 500 });
      const took = Date.now() - started;
      expect(took).toBeLessThan(1_000);
      const states = await sql`select status, count(*)::int as n from job where kind = ${k} group by status`;
      const done = states.find((r) => r.status === "done")?.n ?? 0;
      expect(done).toBeGreaterThanOrEqual(2);
      expect(done).toBeLessThan(4); // budget ran out before the queue did
      expect(aborted).toBe(0);
      expect((await sql`select count(*)::int as n from job where kind = ${k} and status = 'queued' and attempts = 0`)[0].n).toBeGreaterThanOrEqual(1);
    });

    it("a hung job is aborted at the budget, not at the 20 s job timeout", async () => {
      const k = kind();
      await q.enqueue(db, { kind: k, key: "hang" });
      let aborted = false;
      const worker = w.createWorker({
        mode: "inline",
        timeoutMs: 20_000,
        leaseMs: 60_000,
        handlers: {
          [k]: (_j, ctx) => {
            ctx.signal.addEventListener("abort", () => (aborted = true));
            return new Promise(() => {});
          },
        },
      });
      const started = Date.now();
      await worker.kick({ budgetMs: 600 });
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(aborted).toBe(true);
      expect(await q.jobStatus(db, { kind: k, key: "hang" })).toMatchObject({ state: "retrying", lastError: "timeout" });
    });

    it("timer mode also honours a budget: kick returns while a slow job carries on", async () => {
      const k = kind();
      await q.enqueue(db, { kind: k, key: "slowtimer" });
      let finished = false;
      const worker = w.createWorker({
        handlers: { [k]: async () => { await new Promise((r) => setTimeout(r, 400)); finished = true; } },
      });
      const started = Date.now();
      await worker.kick({ budgetMs: 300 });
      expect(Date.now() - started).toBeLessThan(380);
      expect(finished).toBe(false);
      await worker.stop();
      expect(finished).toBe(true);
    });
  });

  describe("hardening", () => {
    it("JobError only carries safe codes", () => {
      expect(new w.JobError("host_busy").code).toBe("host_busy");
      for (const bad of ["Could not reach ada@example.com", "", "x".repeat(41), "has space", "UPPER", "a\nb"]) {
        const e = new w.JobError(bad);
        expect(e.code).toBe("error");
        expect(e.message).toBe("error");
      }
      expect(new w.JobError("ok", { deferMs: Number.NaN }).deferMs).toBeUndefined();
    });

    it("a handler's unsafe code never reaches the log or last_error", async () => {
      const k = kind();
      await q.enqueue(db, { kind: k, key: "code" });
      process.env.LOG_LEVEL = "debug";
      const out: string[] = [];
      for (const m of ["log", "error"] as const) vi.spyOn(console, m).mockImplementation((line: string) => void out.push(String(line)));
      await w.createWorker({ handlers: { [k]: async () => { throw new w.JobError("no mailbox for ada@example.com"); } } }).kick();
      process.env.LOG_LEVEL = "error";
      expect(out.join("\n")).not.toContain("ada@example.com");
      expect((await q.jobStatus(db, { kind: k, key: "code" }))?.lastError).toBe("error");
    });

    it("clamps deferMs to 1 s..1 h and ignores NaN", async () => {
      const delayed = async (opts: Parameters<Queue["fail"]>[2]) => {
        const k = kind();
        const { id } = await q.enqueue(db, { kind: k });
        await q.fail(db, await claimOne(k), opts);
        return row(id);
      };
      const tiny = await delayed({ code: "busy", deferMs: 0 });
      expect(Number(tiny.in_secs)).toBeGreaterThan(0.5);
      expect(tiny.attempts).toBe(0);
      const huge = await delayed({ code: "busy", deferMs: 10 * 86_400_000 });
      expect(Number(huge.in_secs)).toBeLessThanOrEqual(3_600);
      expect(Number(huge.in_secs)).toBeGreaterThan(3_500);
      const nan = await delayed({ code: "busy", deferMs: Number.NaN }); // an ordinary failed attempt: backoff, attempt used
      expect(nan.attempts).toBe(1);
      expect(Number(nan.in_secs)).toBeGreaterThan(10);
    });

    it("a deferral on the last attempt keeps the job queued; deferrals are capped and then count as failures", async () => {
      const k = kind();
      const { id } = await q.enqueue(db, { kind: k, key: "inf", maxAttempts: 1 });
      for (let i = 0; i < q.MAX_DEFERRALS; i++) {
        const j = await claimOne(k);
        expect(j.attempts).toBe(1);
        expect(await q.fail(db, j, { code: "host_busy", deferMs: 1_000 })).toBe("queued");
        await due(id);
      }
      expect((await row(id)).deferrals).toBe(q.MAX_DEFERRALS);
      const last = await claimOne(k);
      expect(await q.fail(db, last, { code: "host_busy", deferMs: 1_000 })).toBe("failed"); // the only attempt is used up
      expect(await row(id)).toMatchObject({ status: "failed", attempts: 1 });
      expect(await q.retryJob(db, { id })).toBe("retried");
      expect((await row(id)).deferrals).toBe(0);
    });

    it("retry by id ignores malformed ids and by key only retries the newest row", async () => {
      const k = kind();
      expect(await q.retryJob(db, { id: "nope" })).toBe("not_found");
      expect(await q.retryJob(db, { id: "00000000-0000-0000-0000-000000000000" })).toBe("not_found");
      const old = await q.enqueue(db, { kind: k, key: "n", maxAttempts: 1 });
      await q.fail(db, await claimOne(k), { code: "error" });
      const newer = await q.enqueue(db, { kind: k, key: "n", maxAttempts: 1 });
      await q.complete(db, await claimOne(k)); // the newer one finished fine
      expect(newer.id).not.toBe(old.id);
      expect(await q.retryJob(db, { kind: k, key: "n" })).toBe("not_found"); // newest row is done
      expect(await q.retryJob(db, { id: old.id })).toBe("not_found"); // stale failure
      expect((await row(old.id)).status).toBe("failed");
    });

    it("payloads that can't be serialized fail validation", async () => {
      const k = kind();
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      for (const payload of [circular, { n: BigInt(1) }, { toJSON() { throw new Error("no"); } }]) {
        await expect(q.enqueue(db, { kind: k, payload: payload as Record<string, unknown> })).rejects.toMatchObject({ name: "ZodError" });
      }
    });
  });

  describe("status and housekeeping", () => {
    it("reports a state for a status chip, scoped to the owner", async () => {
      const k = kind();
      expect(await q.jobStatus(db, { kind: k, key: "z" })).toBeNull();
      await q.enqueue(db, { kind: k, key: "z", ownerId: "job-a" });
      expect(await q.jobStatus(db, { kind: k, key: "z", ownerId: "job-a" })).toMatchObject({ state: "queued", attempts: 0, retryInSeconds: 0 });
      expect(await q.jobStatus(db, { kind: k, key: "z", ownerId: "job-b" })).toBeNull();
      const j = await claimOne(k);
      expect((await q.jobStatus(db, { kind: k, key: "z" }))?.state).toBe("running");
      await q.fail(db, j, { code: "network" });
      const s = await q.jobStatus(db, { kind: k, key: "z" });
      expect(s?.state).toBe("retrying");
      expect(s?.retryInSeconds).toBeGreaterThan(10);
      expect(s).not.toHaveProperty("payload");
    });

    it("counts the queue and prunes old finished jobs", async () => {
      const k = kind();
      const a = await q.enqueue(db, { kind: k, key: "old-done" });
      const b = await q.enqueue(db, { kind: k, key: "old-failed", maxAttempts: 1 });
      const c = await q.enqueue(db, { kind: k, key: "fresh" });
      const ja = await claimOne(k);
      await q.complete(db, ja);
      await q.fail(db, await claimOne(k), { code: "error" });
      await sql`update job set finished_at = now() - interval '8 days' where id = ${a.id}`;
      await sql`update job set finished_at = now() - interval '8 days' where id = ${b.id}`;
      expect((await q.queueStats(db)).queued).toBeGreaterThanOrEqual(1);
      expect(await q.pruneJobs(db)).toBeGreaterThanOrEqual(1); // the 8-day-old done row; the failed one is kept for 30 days
      expect(await row(a.id)).toBeUndefined();
      expect(await row(b.id)).toBeDefined();
      expect(await row(c.id)).toBeDefined();
    });
  });
});
