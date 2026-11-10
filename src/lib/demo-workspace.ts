import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { and, count, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { DEMO_SAMPLE_NOTES } from "@/lib/ai/invoice-from-notes";
import { auth } from "@/lib/auth";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { updateProfile } from "@/lib/business-profile";
import { createClient } from "@/lib/clients";
import { db, schema } from "@/lib/db";
import { DEMO_EMAIL_DOMAIN, MARKER } from "@/lib/demo-identity";
import { demoSeedConfig } from "@/lib/demo-seed-config";
import { ConflictError, TooManyRequestsError } from "@/lib/errors";
import { addDays, todayIn } from "@/lib/invoice-common";
import { createInvoice, markPaidInTx, recordManualPayment, transitionInvoice } from "@/lib/invoices";
import { log } from "@/lib/log";
import { reserveDaily } from "@/lib/usage";

export const DEMO_LOADS_PER_DAY = 20;

type Owner = "Maya" | "Theo";
const OWNERS: { key: Owner; name: string; business: string; address: string; timeZone: string; terms: number }[] = [
  { key: "Maya", name: "Maya Chen", business: "Maya Chen Design", address: "12 Example Street, Portland OR (demo)", timeZone: "America/Los_Angeles", terms: 14 },
  { key: "Theo", name: "Theo Okafor", business: "Okafor Web Works", address: "4 Sample Road, Leeds (demo)", timeZone: "Europe/London", terms: 30 },
];
const emailFor = (key: Owner) => `${key.toLowerCase()}@${DEMO_EMAIL_DOMAIN}`;

const CLIENTS: { owner: Owner; key: string; name: string; email: string; rate: number }[] = [
  { owner: "Maya", key: "northwind", name: "Northwind Bakery", email: "orders@northwind.example", rate: 9_500 },
  { owner: "Maya", key: "harbor", name: "Harbor Legal LLP", email: "accounts@harbor.example", rate: 12_000 },
  { owner: "Theo", key: "pine", name: "Pine Street Clinic", email: "office@pine.example", rate: 11_000 },
  { owner: "Theo", key: "lumen", name: "Lumen Books", email: "hello@lumen.example", rate: 10_000 },
];

type DemoLine = { kind: "hours" | "fixed" | "expense"; description: string; quantityX100: number; unitPriceCents: number };
type DemoInvoice = {
  owner: Owner;
  client: string;
  /** Days ago the invoice was issued, and days until it is due (negative: already due). */
  issuedDaysAgo: number;
  dueInDays: number;
  taxBp?: number;
  memo?: string;
  lines: DemoLine[];
  /** Where the invoice ends up; omitted means sent. */
  end?: "draft" | "sent" | "paid-demo" | "paid-manual" | "void";
};

// Eight invoices in every state (Maya's second one is sent and overdue), sent in this order, so each owner's
// numbers run INV-0001, INV-0002, ...
const INVOICES: DemoInvoice[] = [
  { owner: "Maya", client: "northwind", issuedDaysAgo: 45, dueInDays: -31, memo: "Thank you!", end: "paid-demo",
    lines: [{ kind: "hours", description: "Menu redesign", quantityX100: 1_200, unitPriceCents: 9_500 }, { kind: "expense", description: "Stock photography", quantityX100: 100, unitPriceCents: 4_900 }] },
  { owner: "Maya", client: "northwind", issuedDaysAgo: 30, dueInDays: -16, taxBp: 825,
    lines: [{ kind: "hours", description: "Online ordering page", quantityX100: 850, unitPriceCents: 9_500 }, { kind: "fixed", description: "Logo refresh (fixed fee)", quantityX100: 100, unitPriceCents: 45_000 }] },
  { owner: "Maya", client: "harbor", issuedDaysAgo: 3, dueInDays: 11,
    lines: [{ kind: "hours", description: "Brand guidelines", quantityX100: 1_450, unitPriceCents: 12_000 }] },
  { owner: "Maya", client: "harbor", issuedDaysAgo: 0, dueInDays: 14, memo: "Draft: add this week's work with Draft from notes.",
    lines: [{ kind: "hours", description: "Intake form wireframes", quantityX100: 300, unitPriceCents: 12_000 }], end: "draft" },
  { owner: "Maya", client: "northwind", issuedDaysAgo: 20, dueInDays: -6,
    lines: [{ kind: "hours", description: "Billed to the wrong client", quantityX100: 200, unitPriceCents: 9_500 }], end: "void" },
  { owner: "Theo", client: "pine", issuedDaysAgo: 40, dueInDays: -10, taxBp: 2_000,
    lines: [{ kind: "hours", description: "Booking widget", quantityX100: 1_650, unitPriceCents: 11_000 }, { kind: "hours", description: "Accessibility fixes", quantityX100: 325, unitPriceCents: 11_000 }], end: "paid-manual" },
  { owner: "Theo", client: "lumen", issuedDaysAgo: 5, dueInDays: 25, taxBp: 2_000,
    lines: [{ kind: "fixed", description: "Shop theme set-up", quantityX100: 100, unitPriceCents: 180_000 }], end: "sent" },
  { owner: "Theo", client: "lumen", issuedDaysAgo: 0, dueInDays: 30, lines: [], end: "draft" },
];

const optionsSchema = z.discriminatedUnion("mode", [z.object({ mode: z.literal("admin") }).strict(), z.object({ mode: z.literal("cli") }).strict()]);

/** One constant key serializes every demo load and reservation across processes. */
const LOCK_KEY = "demo-load";
type Tx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];

const tryLock = (tx: Pick<Tx, "execute">) =>
  tx.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${LOCK_KEY}, 0)) as ok`);

/** One load per minute and DEMO_LOADS_PER_DAY per UTC day for the whole app; a failed load rolls this back too. */
async function reserveLocked(tx: Tx, actor: Actor): Promise<void> {
  const { rateEvent } = schema;
  const any = eq(rateEvent.kind, "demo_load");
  await tx.delete(rateEvent).where(and(any, sql`${rateEvent.at} <= now() - interval '1 minute'`));
  const [{ n }] = await tx.select({ n: count() }).from(rateEvent).where(and(any, gt(rateEvent.at, sql`now() - interval '1 minute'`)));
  if (n) throw new TooManyRequestsError("Demo workspace can be loaded once per minute. Try again shortly.");
  if (!(await reserveDaily(tx, "demo_load", DEMO_LOADS_PER_DAY))) {
    throw new TooManyRequestsError("The demo workspace was loaded the maximum number of times today. Try again tomorrow.");
  }
  await tx.insert(rateEvent).values({ userId: actor.id, kind: "demo_load" });
}

export type DemoLoadResult = { users: number; clients: number; invoices: number; notes: number };

/**
 * Replace the demo owners' data with the sample workspace. Default is the safe admin-route mode (random passwords,
 * nobody can sign in as a demo owner); CLI mode (scripts/seed-demo.mts) re-checks the refusal rules and uses
 * DEMO_PASSWORD. Admin only.
 */
export async function loadDemoWorkspace(
  actor: Actor,
  options: unknown = { mode: "admin" },
  { reserve = false }: { reserve?: boolean } = {},
): Promise<DemoLoadResult> {
  assertCan(actor, "delete"); // no resource: admin only
  const parsed = optionsSchema.parse(options);
  // The lock is held on its own transaction for the whole load; the work itself uses the normal pool.
  return db().transaction(async (tx) => {
    const [{ ok }] = await tryLock(tx);
    if (!ok) throw new TooManyRequestsError("A demo load is already running. Try again shortly.");
    if (reserve) {
      await reserveLocked(tx, actor);
      log.info("admin.demo_load", { by: actor.id });
    }
    const result = await loadLocked(actor, parsed.mode);
    log.info("demo.loaded", { mode: parsed.mode, ...result });
    return result;
  });
}

/** A unique violation (SQLSTATE 23505), however the driver or drizzle wraps it. */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

async function loadLocked(actor: Actor, mode: "admin" | "cli"): Promise<DemoLoadResult> {
  const password = mode === "cli" ? demoSeedConfig().password : undefined;
  const ctx = await auth().$context;
  const people = new Map<Owner, Actor>();

  // Preflight every identity before changing anything: an unrelated account that holds a demo email is never
  // adopted or overwritten.
  for (const o of OWNERS) {
    const [existing] = await db().select().from(schema.user).where(eq(schema.user.email, emailFor(o.key)));
    if (existing && existing.image !== MARKER) throw new ConflictError("A demo email belongs to an unrelated account; no demo data was replaced.");
    if (existing?.id === actor.id) throw new ConflictError("Load the demo from a separate administrator account.");
  }

  // Users are written directly with Drizzle (no Better Auth hooks, which refuse demo identities). A concurrent
  // sign-up on a demo email would hit the unique index: that is a 409, not a crash.
  for (const o of OWNERS) {
    const email = emailFor(o.key);
    const hash = await ctx.password.hash(password ?? randomBytes(32).toString("base64url"));
    try {
      const id = await db().transaction(async (tx) => {
        const [existing] = await tx.select().from(schema.user).where(eq(schema.user.email, email));
        if (existing) {
          if (existing.image !== MARKER) throw new ConflictError("A demo email belongs to an unrelated account; no demo data was replaced.");
          // Rotate even on reload, so a previous CLI password can't sign in on a later admin load.
          await tx.update(schema.account).set({ password: hash, updatedAt: new Date() }).where(and(eq(schema.account.userId, existing.id), eq(schema.account.providerId, "credential")));
          await tx.update(schema.user).set({ role: "user", name: o.name, updatedAt: new Date() }).where(eq(schema.user.id, existing.id));
          await tx.delete(schema.session).where(eq(schema.session.userId, existing.id));
          return existing.id;
        }
        const userId = randomUUID();
        await tx.insert(schema.user).values({ id: userId, name: o.name, email, emailVerified: true, image: MARKER, role: "user" });
        await tx.insert(schema.account).values({ id: randomUUID(), accountId: userId, providerId: "credential", userId, password: hash });
        return userId;
      });
      people.set(o.key, { id, role: "user" });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError("A demo email is already taken by another account; no demo data was replaced.");
      throw err;
    }
  }

  // Replace only these two owners' data. The ids come from the marker-checked accounts above, never from a name
  // or an email suffix.
  const ids = [...people.values()].map((p) => p.id);
  await db().transaction(async (tx) => {
    await tx.delete(schema.rateEvent).where(and(inArray(schema.rateEvent.userId, ids), sql`${schema.rateEvent.kind} <> 'demo_load'`));
    await tx.delete(schema.notesDraft).where(inArray(schema.notesDraft.ownerId, ids));
    await tx.delete(schema.invoice).where(inArray(schema.invoice.ownerId, ids)); // lines and payments cascade
    await tx.delete(schema.client).where(inArray(schema.client.ownerId, ids));
    await tx.delete(schema.businessProfile).where(inArray(schema.businessProfile.ownerId, ids));
  });

  // Everything below goes through the same data functions as real requests, so the sample data obeys the real
  // rules (numbering, totals, snapshots, hashed share tokens).
  const clientIds = new Map<string, string>();
  for (const o of OWNERS) {
    const owner = people.get(o.key)!;
    await updateProfile(owner, { name: o.business, address: o.address, contactEmail: emailFor(o.key), timeZone: o.timeZone, defaultTermsDays: o.terms });
  }
  for (const c of CLIENTS) {
    const created = await createClient(people.get(c.owner)!, { name: c.name, email: c.email, address: "1 Sample Way (demo)", hourlyRateCents: c.rate });
    clientIds.set(`${c.owner}:${c.key}`, created.id);
  }

  const now = new Date();
  for (const inv of INVOICES) {
    const owner = people.get(inv.owner)!;
    const tz = OWNERS.find((o) => o.key === inv.owner)!.timeZone;
    const issueDate = addDays(todayIn(tz, now), -inv.issuedDaysAgo);
    const dueDate = addDays(todayIn(tz, now), inv.dueInDays);
    const created = await createInvoice(owner, {
      clientId: clientIds.get(`${inv.owner}:${inv.client}`),
      issueDate,
      dueDate,
      taxBp: inv.taxBp ?? 0,
      memo: inv.memo ?? "",
      lines: inv.lines,
    });
    const end = inv.end ?? "sent";
    if (end === "draft") continue;
    const sent = await transitionInvoice(owner, created.invoice.id, { to: "sent", version: created.invoice.version });
    const v = sent.detail.invoice.version;
    if (end === "void") await transitionInvoice(owner, created.invoice.id, { to: "void", version: v, reason: "Billed to the wrong client" });
    else if (end === "paid-manual") await recordManualPayment(owner, created.invoice.id, { version: v, note: "Bank transfer (demo)" });
    else if (end === "paid-demo") {
      await db().transaction(async (tx) => {
        const [row] = await tx.select().from(schema.invoice).where(eq(schema.invoice.id, created.invoice.id)).for("update");
        await markPaidInTx(tx, row, { method: "demo", note: "Demo payment" });
      });
    }
  }

  // The notes the "Draft from notes" demo is written for: "6h" on L1 and "$450" on L2.
  let notes = 0;
  for (const o of OWNERS) {
    const owner = people.get(o.key)!;
    const clientId = clientIds.get(`${o.key}:${o.key === "Maya" ? "harbor" : "lumen"}`)!;
    await db().insert(schema.notesDraft).values({ ownerId: owner.id, clientId, notes: DEMO_SAMPLE_NOTES, mode: "demo" });
    notes += 1;
  }

  return { users: people.size, clients: CLIENTS.length, invoices: INVOICES.length, notes };
}
