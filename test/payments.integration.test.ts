/**
 * Payments (issue 9.2) against a real Postgres and a stubbed Stripe: the demo provider and its gate, provider
 * selection and the test-key guard, Checkout creation, the signed webhook (signature, replay, amount, currency,
 * livemode, flags), concurrency with manual payments, and what reaches the logs.
 */
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signStripePayload } from "@/lib/payments/signature";

const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:3000";
const SECRET_KEY = "sk_test_unit_secret_key_1234567890";
const WEBHOOK_SECRET = "whsec_unit_test_secret_abcdef";

describe.skipIf(!url)("payments (Postgres)", () => {
  let sql: postgres.Sql;
  const alice = { id: "pay-alice", role: "user" as const };
  const bob = { id: "pay-bob", role: "user" as const };
  const ids = [alice.id, bob.id];

  let clients: typeof import("@/lib/clients");
  let invoices: typeof import("@/lib/invoices");
  let envMod: typeof import("@/lib/env");
  let cfg: typeof import("@/lib/payments/config");
  let limiter: typeof import("@/lib/ip-limit");
  let ref: typeof import("@/lib/payments/invoice-ref");
  let routes: {
    checkout: typeof import("@/app/i/[token]/checkout/route");
    demoPay: typeof import("@/app/api/public/invoices/[token]/demo-pay/route");
    webhook: typeof import("@/app/api/stripe/webhook/route");
    health: typeof import("@/app/api/health/route");
  };

  let logs: string[] = [];
  const logSpies: ReturnType<typeof vi.spyOn>[] = [];

  function setStripe(on: boolean, key: string = SECRET_KEY, secret: string | null = WEBHOOK_SECRET) {
    if (on) {
      process.env.STRIPE_SECRET_KEY = key;
      if (secret) process.env.STRIPE_WEBHOOK_SECRET = secret;
      else delete process.env.STRIPE_WEBHOOK_SECRET;
    } else {
      delete process.env.STRIPE_SECRET_KEY;
      delete process.env.STRIPE_WEBHOOK_SECRET;
    }
    envMod.resetEnvCache();
    cfg.resetPaymentsFallbackLog();
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.APP_URL = ORIGIN;
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    await sql`delete from "user" where id like 'pay-%'`;
    for (const u of [alice, bob]) await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.id + "@test.local"}, ${u.role})`;
    clients = await import("@/lib/clients");
    invoices = await import("@/lib/invoices");
    envMod = await import("@/lib/env");
    cfg = await import("@/lib/payments/config");
    limiter = await import("@/lib/ip-limit");
    ref = await import("@/lib/payments/invoice-ref");
    routes = {
      checkout: await import("@/app/i/[token]/checkout/route"),
      demoPay: await import("@/app/api/public/invoices/[token]/demo-pay/route"),
      webhook: await import("@/app/api/stripe/webhook/route"),
      health: await import("@/app/api/health/route"),
    };
  });
  afterAll(async () => {
    await sql`delete from stripe_event where id like 'evt_pt_%'`;
    await sql`delete from "user" where id like 'pay-%'`;
    await sql.end();
  });
  beforeEach(async () => {
    await sql`delete from invoice where owner_id = any(${ids})`;
    await sql`delete from client where owner_id = any(${ids})`;
    await sql`delete from business_profile where owner_id = any(${ids})`;
    await sql`delete from rate_event where user_id = any(${ids})`;
    limiter.resetPublicLimiter();
    setStripe(false);
    logs = [];
    for (const name of ["log", "error"] as const) {
      logSpies.push(vi.spyOn(console, name).mockImplementation((line: unknown) => void logs.push(String(line))));
    }
  });
  afterEach(() => {
    for (const s of logSpies.splice(0)) s.mockRestore();
    vi.unstubAllGlobals();
  });

  /** A sent invoice (total 35,000 cents) and its share token. */
  async function sentInvoice(over: { unitPriceCents?: number } = {}) {
    const c = await clients.createClient(alice, { name: "Northwind", hourlyRateCents: 10_000 });
    const d = await invoices.createInvoice(alice, {
      clientId: c.id,
      lines: [{ kind: "hours", description: "Design", quantityX100: 350, unitPriceCents: over.unitPriceCents ?? 10_000 }],
    });
    const s = await invoices.transitionInvoice(alice, d.invoice.id, { to: "sent", version: d.invoice.version });
    return { id: d.invoice.id, token: s.shareToken!, total: s.detail.invoice.totalCents, number: s.detail.invoice.number!, version: s.detail.invoice.version };
  }

  const state = async (id: string) => (await sql`select status, paid_cents, version from invoice where id = ${id}`)[0];
  const payments = (id: string) => sql`select method, amount_cents, flag, stripe_session_id from payment where invoice_id = ${id} order by received_at`;

  const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
  const post = (body?: unknown, headers: Record<string, string> = { origin: ORIGIN }) =>
    new Request("http://localhost:3000/x", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

  let seq = 0;
  async function inv(id: string) {
    const [row] = await sql`select id, number, total_cents from invoice where id = ${id}`;
    return { id: row.id as string, number: row.number as string, totalCents: Number(row.total_cents) };
  }
  async function eventBody(id: string, over: { amount?: number; currency?: string; livemode?: boolean; type?: string; status?: string; hash?: string | null; invoiceId?: string; eventId?: string; sessionId?: string } = {}) {
    const row = await inv(id);
    seq += 1;
    return JSON.stringify({
      id: over.eventId ?? `evt_pt_${Date.now()}_${seq}`,
      type: over.type ?? "checkout.session.completed",
      livemode: over.livemode ?? false,
      data: {
        object: {
          id: over.sessionId ?? `cs_test_${Date.now()}_${seq}`,
          payment_status: over.status ?? "paid",
          currency: over.currency ?? "usd",
          amount_total: over.amount ?? row.totalCents,
          metadata: { invoice_id: over.invoiceId ?? id, ...(over.hash === null ? {} : { invoice_hash: over.hash ?? ref.invoiceRef(row) }) },
        },
      },
    });
  }
  const signed = (body: string, opts: { secret?: string; t?: number } = {}) =>
    signStripePayload(body, opts.secret ?? WEBHOOK_SECRET, opts.t ?? Math.floor(Date.now() / 1000));
  const hook = (body: string, signature: string | null) =>
    routes.webhook.POST(new Request("http://localhost:3000/api/stripe/webhook", { method: "POST", headers: signature ? { "stripe-signature": signature } : {}, body }));

  describe("demo provider (the default)", () => {
    it("health reports demo, and no secrets", async () => {
      const body = await (await routes.health.GET()).json();
      expect(body.payments).toBe("demo");
      expect(JSON.stringify(body)).not.toMatch(/sk_|whsec_/);
    });

    it("checkout points at the demo page and pay marks the invoice paid with one demo payment", async () => {
      const i = await sentInvoice();
      const res = await routes.checkout.POST(post({}), ctx(i.token));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ provider: "demo", url: `${ORIGIN}/i/${i.token}/demo-pay` });
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      // Starting checkout never pays.
      expect((await state(i.id)).status).toBe("sent");

      const paid = await routes.demoPay.POST(post(), ctx(i.token));
      expect(paid.status).toBe(200);
      expect((await state(i.id)).status).toBe("paid");
      expect(Number((await state(i.id)).paid_cents)).toBe(i.total);
      const rows = await payments(i.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ method: "demo", flag: null });
      expect(Number(rows[0].amount_cents)).toBe(i.total);
      const [{ note }] = await sql`select note from payment where invoice_id = ${i.id}`;
      expect(note).toMatch(/demo payment/i);
    });

    it("a second demo payment is refused and records nothing more; 10 racing clicks record one", async () => {
      const i = await sentInvoice();
      const results = await Promise.all(Array.from({ length: 10 }, () => routes.demoPay.POST(post(), ctx(i.token))));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(9);
      expect(await payments(i.id)).toHaveLength(1);
    });

    it("demo pay is a 404 when Stripe is configured (the demo can't fake a payment)", async () => {
      const i = await sentInvoice();
      setStripe(true);
      expect((await routes.demoPay.POST(post(), ctx(i.token))).status).toBe(404);
      expect((await state(i.id)).status).toBe("sent");
    });

    it("refuses draft, void and paid invoices; rotated and malformed tokens are 404", async () => {
      const i = await sentInvoice();
      const old = i.token;
      const { token } = await (await import("@/lib/share")).rotateShareToken(alice, i.id);
      expect((await routes.checkout.POST(post({}), ctx(old))).status).toBe(404);
      expect((await routes.demoPay.POST(post(), ctx(old))).status).toBe(404);
      expect((await routes.checkout.POST(post({}), ctx("nope"))).status).toBe(404);

      // draft: a duplicate has no token at all, and a voided invoice's link says 409
      const v = await sentInvoice();
      await invoices.transitionInvoice(alice, v.id, { to: "void", version: v.version, reason: "mistake" });
      expect((await routes.checkout.POST(post({}), ctx(v.token))).status).toBe(409);
      expect((await routes.demoPay.POST(post(), ctx(v.token))).status).toBe(409);
      expect(await payments(v.id)).toHaveLength(0);

      await routes.demoPay.POST(post(), ctx(token));
      expect((await routes.checkout.POST(post({}), ctx(token))).status).toBe(409);
    });

    it("needs our Origin, takes no amount, and is limited to 5 checkouts per invoice per hour", async () => {
      const i = await sentInvoice();
      expect((await routes.checkout.POST(post({}, {}), ctx(i.token))).status).toBe(403);
      expect((await routes.checkout.POST(post({}, { origin: "https://evil.example" }), ctx(i.token))).status).toBe(403);
      expect((await routes.demoPay.POST(post(undefined, { origin: "https://evil.example" }), ctx(i.token))).status).toBe(403);
      expect((await routes.checkout.POST(post({ amountCents: 1 }), ctx(i.token))).status).toBe(400);
      expect((await routes.checkout.POST(new Request("http://localhost:3000/x", { method: "POST", headers: { origin: ORIGIN }, body: "{nope" }), ctx(i.token))).status).toBe(400);
      expect((await state(i.id)).status).toBe("sent");

      for (let n = 0; n < 5; n++) expect((await routes.checkout.POST(post({}), ctx(i.token))).status).toBe(200);
      expect((await routes.checkout.POST(post({}), ctx(i.token))).status).toBe(429);
      // Another invoice (same owner) has its own allowance.
      const other = await sentInvoice();
      expect((await routes.checkout.POST(post({}), ctx(other.token))).status).toBe(200);
    });
  });

  describe("provider selection", () => {
    const fallbackLines = () => logs.filter((l) => l.includes("payments.provider.fallback"));

    it("uses Stripe only for both secrets plus a test key", () => {
      expect(cfg.paymentsConfig().mode).toBe("demo");
      expect(fallbackLines()).toHaveLength(0); // nothing configured: quiet default
      setStripe(true);
      expect(cfg.paymentsConfig().mode).toBe("stripe");
      setStripe(true, "rk_test_restricted_key_123");
      expect(cfg.paymentsConfig().mode).toBe("stripe");
    });

    it("an sk_live_ key falls back to demo, logging once, with names and never values", async () => {
      setStripe(true, "sk_live_do_not_use_1234567890");
      expect(cfg.paymentsConfig().mode).toBe("demo");
      expect(cfg.paymentsConfig().mode).toBe("demo");
      expect(fallbackLines()).toHaveLength(1);
      expect(fallbackLines()[0]).toContain("STRIPE_SECRET_KEY is not a test-mode key");
      expect(logs.join("\n")).not.toContain("sk_live_do_not_use");
      expect(logs.join("\n")).not.toContain(WEBHOOK_SECRET);
      expect((await (await routes.health.GET()).json()).payments).toBe("demo");
    });

    it("a missing webhook secret or a missing key also falls back", () => {
      setStripe(true, SECRET_KEY, null);
      expect(cfg.paymentsConfig().mode).toBe("demo");
      expect(fallbackLines()[0]).toContain("STRIPE_WEBHOOK_SECRET missing");
      setStripe(false);
      process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
      expect(cfg.paymentsConfig().mode).toBe("demo");
    });

    it("health says stripe when configured, without the key", async () => {
      setStripe(true);
      const body = await (await routes.health.GET()).json();
      expect(body.payments).toBe("stripe");
      expect(JSON.stringify(body)).not.toContain(SECRET_KEY);
      expect(JSON.stringify(body)).not.toContain(WEBHOOK_SECRET);
    });
  });

  describe("Stripe Checkout (stubbed fetch)", () => {
    const stub = (impl: (url: string, init: RequestInit) => Response | Promise<Response>) => {
      const fn = vi.fn(async (u: string | URL | Request, init?: RequestInit) => impl(String(u), init ?? {}));
      vi.stubGlobal("fetch", fn);
      return fn;
    };
    const okSession = () => Response.json({ id: "cs_test_abc123", url: "https://checkout.stripe.com/c/pay/cs_test_abc123" });

    it("creates a session for the server-computed balance, with idempotency key and metadata", async () => {
      setStripe(true);
      const i = await sentInvoice();
      const fetchFn = stub(() => okSession());
      const res = await routes.checkout.POST(post({}), ctx(i.token));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ provider: "stripe", url: "https://checkout.stripe.com/c/pay/cs_test_abc123" });

      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
      expect(calledUrl).toBe("https://api.stripe.com/v1/checkout/sessions");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${SECRET_KEY}`);
      expect(headers["Idempotency-Key"]).toMatch(new RegExp(`^invoice-${i.id}-v${i.version}-[0-9a-f]{8}$`));
      expect(init.signal).toBeDefined();
      const form = new URLSearchParams(String(init.body));
      expect(form.get("mode")).toBe("payment");
      expect(form.get("payment_method_types[0]")).toBe("card");
      expect(form.get("line_items[0][price_data][unit_amount]")).toBe(String(i.total));
      expect(form.get("line_items[0][price_data][currency]")).toBe("usd");
      expect(form.get("line_items[0][price_data][product_data][name]")).toBe(`Invoice ${i.number}`);
      expect(form.get("metadata[invoice_id]")).toBe(i.id);
      expect(form.get("metadata[invoice_hash]")).toBe(ref.invoiceRef({ id: i.id, number: i.number, totalCents: i.total }));
      expect(form.get("success_url")).toBe(`${ORIGIN}/i/${i.token}?payment=processing`);
      expect(form.get("cancel_url")).toBe(`${ORIGIN}/i/${i.token}?payment=cancelled`);

      // The return from Stripe changes nothing: only the webhook marks paid.
      expect((await state(i.id)).status).toBe("sent");
      expect(await payments(i.id)).toHaveLength(0);
      expect(logs.join("\n")).not.toContain(SECRET_KEY);
    });

    it("a Stripe error, a timeout and an off-host URL all become a safe 502, with no secrets logged", async () => {
      setStripe(true);
      const i = await sentInvoice();
      stub(() => Response.json({ error: { type: "invalid_request_error", code: "amount_too_small", message: `bad ${SECRET_KEY}` } }, { status: 400 }));
      let res = await routes.checkout.POST(post({}), ctx(i.token));
      expect(res.status).toBe(502);
      expect(JSON.stringify(await res.json())).not.toContain("amount_too_small");

      stub(() => {
        throw new DOMException("timed out", "TimeoutError");
      });
      expect((await routes.checkout.POST(post({}), ctx(i.token))).status).toBe(502);

      stub(() => Response.json({ id: "cs_test_x", url: "https://evil.example/pay" }));
      res = await routes.checkout.POST(post({}), ctx(i.token));
      expect(res.status).toBe(502);
      expect(logs.join("\n")).not.toContain(SECRET_KEY);
      expect(logs.join("\n")).not.toContain("bad sk_");
      expect(logs.filter((l) => l.includes("stripe.checkout_failed")).length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("webhook", () => {
    beforeEach(() => setStripe(true));

    it("a valid event marks the invoice paid once; a replay of the same event is a no-op", async () => {
      const i = await sentInvoice();
      const body = await eventBody(i.id);
      const res = await hook(body, signed(body));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true, outcome: "paid" });
      expect(await state(i.id)).toMatchObject({ status: "paid" });
      let rows = await payments(i.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ method: "stripe", flag: null });
      expect(Number(rows[0].amount_cents)).toBe(i.total);
      expect(rows[0].stripe_session_id).toMatch(/^cs_test_/);

      const before = await state(i.id);
      const replay = await hook(body, signed(body));
      expect(replay.status).toBe(200);
      expect((await replay.json()).outcome).toBe("duplicate");
      expect(await state(i.id)).toEqual(before);
      rows = await payments(i.id);
      expect(rows).toHaveLength(1);
      const [{ n }] = await sql`select count(*)::int as n from stripe_event where id = ${JSON.parse(body).id}`;
      expect(n).toBe(1);
    });

    it("the same event delivered 8 times at once records one payment", async () => {
      const i = await sentInvoice();
      const body = await eventBody(i.id);
      const results = await Promise.all(Array.from({ length: 8 }, () => hook(body, signed(body))));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(await payments(i.id)).toHaveLength(1);
      expect((await state(i.id)).status).toBe("paid");
    });

    it("a bad signature is a 400 that changes nothing and logs no body", async () => {
      const i = await sentInvoice();
      const body = await eventBody(i.id);
      const bad = signed(body, { secret: "whsec_wrong" });
      for (const sig of [bad, null, "t=1,v1=nothex", signed(body + " ")]) {
        const res = await hook(body, sig);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Invalid signature" });
      }
      expect((await state(i.id)).status).toBe("sent");
      expect(await payments(i.id)).toHaveLength(0);
      const [{ n }] = await sql`select count(*)::int as n from stripe_event where id = ${JSON.parse(body).id}`;
      expect(n).toBe(0);
      const invalid = logs.filter((l) => l.includes("stripe.signature_invalid"));
      expect(invalid.length).toBe(4);
      expect(logs.join("\n")).not.toContain(JSON.parse(body).id);
      expect(logs.join("\n")).not.toContain(bad);
    });

    it("a correctly signed but stale (or far-future) timestamp is a 400", async () => {
      const i = await sentInvoice();
      const body = await eventBody(i.id);
      const now = Math.floor(Date.now() / 1000);
      expect((await hook(body, signed(body, { t: now - 301 }))).status).toBe(400);
      expect((await hook(body, signed(body, { t: now + 301 }))).status).toBe(400);
      expect((await state(i.id)).status).toBe("sent");
      expect((await hook(body, signed(body, { t: now - 200 }))).status).toBe(200);
      expect((await state(i.id)).status).toBe("paid");
    });

    it("a live-mode event is refused even when correctly signed", async () => {
      const i = await sentInvoice();
      const body = await eventBody(i.id, { livemode: true });
      expect((await hook(body, signed(body))).status).toBe(400);
      expect((await state(i.id)).status).toBe("sent");
      expect(await payments(i.id)).toHaveLength(0);
    });

    it("the wrong amount or currency is stored flagged and never marks paid", async () => {
      const i = await sentInvoice();
      const wrongAmount = await eventBody(i.id, { amount: i.total - 1 });
      expect(await (await hook(wrongAmount, signed(wrongAmount))).json()).toEqual({ received: true, outcome: "flagged" });
      const wrongCurrency = await eventBody(i.id, { currency: "eur" });
      expect((await (await hook(wrongCurrency, signed(wrongCurrency))).json()).outcome).toBe("flagged");
      const wrongHash = await eventBody(i.id, { hash: "0".repeat(64) });
      expect((await (await hook(wrongHash, signed(wrongHash))).json()).outcome).toBe("flagged");
      const noHash = await eventBody(i.id, { hash: null });
      expect((await (await hook(noHash, signed(noHash))).json()).outcome).toBe("flagged");

      expect((await state(i.id)).status).toBe("sent");
      expect(Number((await state(i.id)).paid_cents)).toBe(0);
      const rows = await payments(i.id);
      expect(rows).toHaveLength(4);
      expect(rows.every((r) => r.flag === "amount_mismatch" && r.method === "stripe")).toBe(true);
      expect(Number(rows[0].amount_cents)).toBe(i.total - 1);

      // The right payment still goes through afterwards.
      const good = await eventBody(i.id);
      expect((await (await hook(good, signed(good))).json()).outcome).toBe("paid");
      expect((await state(i.id)).status).toBe("paid");
    });

    it("a payment on a voided invoice is flagged invoice_void and the invoice stays void", async () => {
      const i = await sentInvoice();
      await invoices.transitionInvoice(alice, i.id, { to: "void", version: i.version, reason: "mistake" });
      const body = await eventBody(i.id);
      expect((await (await hook(body, signed(body))).json()).outcome).toBe("flagged");
      expect((await state(i.id)).status).toBe("void");
      const rows = await payments(i.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].flag).toBe("invoice_void");
    });

    it("only checkout.session.completed with payment_status paid is handled; unknown invoices and bad ids are acknowledged", async () => {
      const i = await sentInvoice();
      for (const over of [{ type: "payment_intent.succeeded" }, { status: "unpaid" }, { invoiceId: "00000000-0000-4000-8000-000000000000" }, { invoiceId: "not-a-uuid" }]) {
        const body = await eventBody(i.id, over);
        const res = await hook(body, signed(body));
        expect(res.status).toBe(200);
        expect((await res.json()).outcome).toBe("ignored");
      }
      expect((await state(i.id)).status).toBe("sent");
      expect(await payments(i.id)).toHaveLength(0);
    });

    it("a malformed signed payload is a 400 and leaves no event row behind", async () => {
      const i = await sentInvoice();
      const notJson = "not json";
      expect((await hook(notJson, signed(notJson))).status).toBe(400);
      const shape = JSON.stringify({ id: "evt_pt_shape", type: "checkout.session.completed", livemode: false, data: { object: { id: "nope" } } });
      expect((await hook(shape, signed(shape))).status).toBe(400);
      const [{ n }] = await sql`select count(*)::int as n from stripe_event where id = 'evt_pt_shape'`;
      expect(n).toBe(0);
      expect((await state(i.id)).status).toBe("sent");
    });

    it("refuses a body over 64 KB", async () => {
      const big = "x".repeat(70 * 1024);
      expect((await hook(big, signed(big))).status).toBe(413);
    });

    it("is inert (400) when Stripe isn't configured, even with a well-formed signature", async () => {
      const i = await sentInvoice();
      const body = await eventBody(i.id);
      const sig = signed(body);
      setStripe(false);
      expect((await hook(body, sig)).status).toBe(400);
      expect((await state(i.id)).status).toBe("sent");
    });

    it("needs no Origin header and no session (Stripe sends neither)", async () => {
      const i = await sentInvoice();
      const body = await eventBody(i.id);
      const res = await routes.webhook.POST(new Request("http://localhost:3000/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": signed(body) }, body }));
      expect(res.status).toBe(200);
    });

    it("an event for a session already recorded is a no-op", async () => {
      const i = await sentInvoice();
      const first = await eventBody(i.id, { sessionId: "cs_test_same_session" });
      await hook(first, signed(first));
      const second = await eventBody(i.id, { sessionId: "cs_test_same_session" });
      expect((await (await hook(second, signed(second))).json()).outcome).toBe("duplicate");
      expect(await payments(i.id)).toHaveLength(1);
    });

    it("no log line holds the secret key, the webhook secret or a signature", async () => {
      const i = await sentInvoice();
      const bodies = [await eventBody(i.id, { amount: 1 }), await eventBody(i.id, { livemode: true }), await eventBody(i.id)];
      const sigs = bodies.map((b) => signed(b));
      await hook(bodies[0], sigs[0]);
      await hook(bodies[1], sigs[1]);
      await hook(bodies[2], sigs[2]);
      await hook(bodies[2], "t=1,v1=" + "a".repeat(64));
      const all = logs.join("\n");
      expect(all).not.toContain(SECRET_KEY);
      expect(all).not.toContain(WEBHOOK_SECRET);
      for (const sig of sigs) expect(all).not.toContain(sig.split("v1=")[1]);
      expect(all).toContain("invoice.paid");
    });

    it("a webhook racing the owner's manual payment records exactly one payment, whoever wins", async () => {
      for (let n = 0; n < 6; n++) {
        const i = await sentInvoice();
        const body = await eventBody(i.id);
        const manual = invoices.recordManualPayment(alice, i.id, { version: i.version, note: "cheque" });
        const webhook = hook(body, signed(body));
        const [m, w] = await Promise.allSettled([manual, webhook]);
        expect(w.status).toBe("fulfilled");
        expect((w as PromiseFulfilledResult<Response>).value.status).toBe(200);
        if (m.status === "rejected") expect(m.reason).toMatchObject({ status: 409 });
        const rows = await payments(i.id);
        expect(rows).toHaveLength(1);
        expect(rows[0].flag).toBeNull();
        expect(await state(i.id)).toMatchObject({ status: "paid" });
        expect(Number((await state(i.id)).paid_cents)).toBe(i.total);
      }
    });

    it("a webhook racing the demo provider can't be shown as two payments either", async () => {
      // With Stripe configured the demo is off; with it off the webhook is inert: both gates hold at once.
      const i = await sentInvoice();
      const body = await eventBody(i.id);
      setStripe(false);
      const [demo, web] = await Promise.all([routes.demoPay.POST(post(), ctx(i.token)), hook(body, signed(body))]);
      expect(demo.status).toBe(200);
      expect(web.status).toBe(400);
      expect(await payments(i.id)).toHaveLength(1);
    });
  });
});
