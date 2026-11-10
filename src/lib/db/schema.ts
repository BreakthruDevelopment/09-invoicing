import { sql } from "drizzle-orm";
import { bigint, boolean, char, check, date, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Auth tables (shape required by Better Auth with the admin plugin).
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: text("role").notNull().default("user"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

// ---------------------------------------------------------------------------
// Invoicing domain. Every owner-private table carries `owner_id` (cascade from the user), and children reference
// their parent with a composite (id, owner_id) foreign key, so a row can never point at another owner's parent.
// Money is integer cents (see src/lib/money.ts); `bigint` columns use number mode (the largest invoice is far
// below 2^53).
// ---------------------------------------------------------------------------

export const INVOICE_STATUSES = ["draft", "sent", "paid", "void"] as const;
export const LINE_KINDS = ["hours", "fixed", "expense"] as const;
export const LINE_SOURCES = ["manual", "ai"] as const;
export const PAYMENT_METHODS = ["demo", "stripe", "manual"] as const;
export const PAYMENT_FLAGS = ["amount_mismatch", "invoice_void"] as const;

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });
const cents = (name: string) => bigint(name, { mode: "number" });

/** The owner's business details, created on first visit. `next_number` is the per-owner invoice counter. */
export const businessProfile = pgTable(
  "business_profile",
  {
    ownerId: text("owner_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull().default(""),
    address: text("address").notNull().default(""),
    contactEmail: text("contact_email").notNull().default(""),
    timeZone: text("time_zone").notNull().default("UTC"),
    defaultTermsDays: integer("default_terms_days").notNull().default(14),
    nextNumber: integer("next_number").notNull().default(1),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("business_profile_terms_chk", sql`${t.defaultTermsDays} between 0 and 90`),
    check("business_profile_next_number_chk", sql`${t.nextNumber} >= 1`),
  ],
);

export const client = pgTable(
  "client",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email"),
    address: text("address").notNull().default(""),
    hourlyRateCents: integer("hourly_rate_cents").notNull().default(0),
    archivedAt: timestamptz("archived_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("client_id_owner_uq").on(t.id, t.ownerId),
    index("client_owner_idx").on(t.ownerId, t.archivedAt),
    check("client_rate_chk", sql`${t.hourlyRateCents} between 0 and 100000`),
  ],
);

/** What the client sees on a sent invoice, frozen at send time. */
export type ClientSnapshot = { name: string; email: string | null; address: string };

export const invoice = pgTable(
  "invoice",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    clientId: uuid("client_id"),
    /** `INV-0001`; null while a draft, so deleted drafts leave no gap. */
    number: text("number"),
    status: text("status", { enum: INVOICE_STATUSES }).notNull().default("draft"),
    issueDate: date("issue_date", { mode: "string" }).notNull(),
    dueDate: date("due_date", { mode: "string" }).notNull(),
    taxBp: integer("tax_bp").notNull().default(0),
    memo: text("memo").notNull().default(""),
    subtotalCents: cents("subtotal_cents").notNull().default(0),
    taxCents: cents("tax_cents").notNull().default(0),
    totalCents: cents("total_cents").notNull().default(0),
    paidCents: cents("paid_cents").notNull().default(0),
    clientSnapshot: jsonb("client_snapshot").$type<ClientSnapshot>(),
    /** sha256 of the share token, hex. The token itself is never stored. */
    shareTokenHash: char("share_token_hash", { length: 64 }).unique(),
    voidReason: text("void_reason"),
    sentAt: timestamptz("sent_at"),
    paidAt: timestamptz("paid_at"),
    voidedAt: timestamptz("voided_at"),
    /** Optimistic lock: every change to content or state adds one. */
    version: integer("version").notNull().default(1),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("invoice_id_owner_uq").on(t.id, t.ownerId),
    unique("invoice_owner_number_uq").on(t.ownerId, t.number),
    foreignKey({ name: "invoice_client_fk", columns: [t.clientId, t.ownerId], foreignColumns: [client.id, client.ownerId] }),
    index("invoice_owner_status_due_idx").on(t.ownerId, t.status, t.dueDate),
    check("invoice_status_chk", sql`${t.status} in (${list(INVOICE_STATUSES)})`),
    check("invoice_tax_bp_chk", sql`${t.taxBp} between 0 and 3000`),
    check("invoice_money_chk", sql`${t.subtotalCents} >= 0 and ${t.taxCents} >= 0 and ${t.totalCents} = ${t.subtotalCents} + ${t.taxCents} and ${t.paidCents} between 0 and ${t.totalCents}`),
    check("invoice_dates_chk", sql`${t.dueDate} >= ${t.issueDate}`),
    // A sent or paid invoice always has a number, a client snapshot and a positive total.
    check(
      "invoice_sent_complete_chk",
      sql`${t.status} not in ('sent', 'paid') or (${t.number} is not null and ${t.clientId} is not null and ${t.clientSnapshot} is not null and ${t.sentAt} is not null and ${t.totalCents} > 0)`,
    ),
    check("invoice_paid_chk", sql`(${t.status} = 'paid') = (${t.paidAt} is not null) and (${t.status} <> 'paid' or ${t.paidCents} = ${t.totalCents})`),
    check("invoice_void_chk", sql`(${t.status} = 'void') = (${t.voidedAt} is not null)`),
    check("invoice_memo_chk", sql`char_length(${t.memo}) <= 1000`),
  ],
);

export const invoiceLine = pgTable(
  "invoice_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id").notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    kind: text("kind", { enum: LINE_KINDS }).notNull(),
    description: text("description").notNull(),
    /** Hundredths of a unit: 350 = 3.50 hours. */
    quantityX100: integer("quantity_x100").notNull(),
    unitPriceCents: integer("unit_price_cents").notNull(),
    amountCents: cents("amount_cents").notNull(),
    source: text("source", { enum: LINE_SOURCES }).notNull().default("manual"),
  },
  (t) => [
    foreignKey({ name: "invoice_line_invoice_fk", columns: [t.invoiceId, t.ownerId], foreignColumns: [invoice.id, invoice.ownerId] }).onDelete("cascade"),
    unique("invoice_line_position_uq").on(t.invoiceId, t.position),
    index("invoice_line_invoice_idx").on(t.invoiceId),
    check("invoice_line_kind_chk", sql`${t.kind} in (${list(LINE_KINDS)})`),
    check("invoice_line_source_chk", sql`${t.source} in (${list(LINE_SOURCES)})`),
    check("invoice_line_quantity_chk", sql`${t.quantityX100} between 1 and 9999999`),
    check("invoice_line_price_chk", sql`${t.unitPriceCents} between 0 and 10000000`),
    check("invoice_line_amount_chk", sql`${t.amountCents} >= 0`),
    check("invoice_line_description_chk", sql`char_length(${t.description}) between 1 and 300`),
  ],
);

export const payment = pgTable(
  "payment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id").notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    method: text("method", { enum: PAYMENT_METHODS }).notNull(),
    amountCents: cents("amount_cents").notNull(),
    stripeSessionId: text("stripe_session_id").unique(),
    /** Set when a payment didn't match the invoice (wrong amount, voided invoice); such a payment never marks it paid. */
    flag: text("flag", { enum: PAYMENT_FLAGS }),
    note: text("note").notNull().default(""),
    receivedAt: timestamptz("received_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "payment_invoice_fk", columns: [t.invoiceId, t.ownerId], foreignColumns: [invoice.id, invoice.ownerId] }).onDelete("cascade"),
    index("payment_invoice_idx").on(t.invoiceId),
    check("payment_method_chk", sql`${t.method} in (${list(PAYMENT_METHODS)})`),
    check("payment_flag_chk", sql`${t.flag} is null or ${t.flag} in (${list(PAYMENT_FLAGS)})`),
    check("payment_amount_chk", sql`${t.amountCents} >= 0`),
    check("payment_note_chk", sql`char_length(${t.note}) <= 200`),
  ],
);

/** Webhook idempotency only: the event id and type, never the payload. */
export const stripeEvent = pgTable("stripe_event", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  receivedAt: timestamptz("received_at").notNull().defaultNow(),
});

/** Notes the owner pasted for "Draft from notes" (issue 9.4 fills this in). The last 20 per owner are kept. */
export const notesDraft = pgTable(
  "notes_draft",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    clientId: uuid("client_id"),
    notes: text("notes").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    mode: text("mode").notNull().default("live"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "notes_draft_client_fk", columns: [t.clientId, t.ownerId], foreignColumns: [client.id, client.ownerId] }).onDelete("cascade"),
    index("notes_draft_owner_idx").on(t.ownerId, t.createdAt),
    check("notes_draft_notes_chk", sql`char_length(${t.notes}) <= 6000`),
  ],
);

// ---------------------------------------------------------------------------
// Usage limits (src/lib/usage.ts). Each app lists its own kinds here; changing a list
// needs a migration, because the CHECK constraints below are part of the schema.
// ---------------------------------------------------------------------------

export const RATE_KINDS = ["api_write", "checkout", "ai", "demo_load"] as const;
export const DAILY_USAGE_KINDS = ["ai", "demo_load"] as const;

/** App-wide daily counters (one row per UTC day and kind) for free-tier caps. */
export const dailyUsage = pgTable(
  "daily_usage",
  {
    day: date("day", { mode: "string" }).notNull(),
    kind: text("kind", { enum: DAILY_USAGE_KINDS }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.kind] }),
    check("daily_usage_kind_chk", sql`${t.kind} in (${list(DAILY_USAGE_KINDS)})`),
    check("daily_usage_count_chk", sql`${t.count} >= 0`),
  ],
);

/** Per-user rate-limit ledger: one row per attempt, counted over a sliding window. */
export const rateEvent = pgTable(
  "rate_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: RATE_KINDS }).notNull(),
    /** What the attempt was about when a limit is per thing rather than per user (checkout: the invoice id). */
    subject: text("subject"),
    at: timestamp("at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index("rate_event_user_kind_at_idx").on(t.userId, t.kind, t.at),
    index("rate_event_subject_idx").on(t.kind, t.subject, t.at),
    check("rate_event_kind_chk", sql`${t.kind} in (${list(RATE_KINDS)})`),
  ],
);

export const JOB_STATUSES = ["queued", "running", "done", "failed"] as const;

/**
 * Background job queue (see src/lib/jobs). `key` makes enqueue idempotent: only one queued or running job per
 * (kind, key). `payload` holds ids and small parameters, never personal data or secrets. `last_error` is a short
 * code, never a message.
 */
export const job = pgTable(
  "job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    key: text("key"),
    ownerId: text("owner_id").references(() => user.id, { onDelete: "cascade" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(4),
    /** Times a handler asked to try again later without using an attempt; capped so a job can't defer forever. */
    deferrals: integer("deferrals").notNull().default(0),
    /** A floor, not a deadline: the job runs at the first claim after this time. */
    runAfter: timestamp("run_after", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    /** While running: the lease. After it passes, any worker may reclaim the job. */
    lockedUntil: timestamp("locked_until", { withTimezone: true, precision: 3 }),
    /** Fencing token of the current claim: a worker whose lease was reclaimed can no longer complete or fail the job. */
    lockToken: uuid("lock_token"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true, precision: 3 }),
  },
  (t) => [
    uniqueIndex("job_active_key_uidx").on(t.kind, t.key).where(sql`${t.status} in ('queued', 'running') and ${t.key} is not null`),
    index("job_due_idx").on(t.runAfter).where(sql`${t.status} = 'queued'`),
    index("job_lease_idx").on(t.lockedUntil).where(sql`${t.status} = 'running'`),
    index("job_kind_key_idx").on(t.kind, t.key, t.createdAt),
    index("job_owner_idx").on(t.ownerId),
    check("job_status_chk", sql`${t.status} in (${list(JOB_STATUSES)})`),
    check("job_attempts_chk", sql`${t.attempts} >= 0 and ${t.maxAttempts} >= 1 and ${t.deferrals} >= 0`),
  ],
);

export type User = typeof user.$inferSelect;
export type BusinessProfile = typeof businessProfile.$inferSelect;
export type Client = typeof client.$inferSelect;
export type Invoice = typeof invoice.$inferSelect;
export type InvoiceLine = typeof invoiceLine.$inferSelect;
export type Payment = typeof payment.$inferSelect;
export type Job = typeof job.$inferSelect;
