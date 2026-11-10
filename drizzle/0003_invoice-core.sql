CREATE TABLE "business_profile" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"contact_email" text DEFAULT '' NOT NULL,
	"time_zone" text DEFAULT 'UTC' NOT NULL,
	"default_terms_days" integer DEFAULT 14 NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_profile_terms_chk" CHECK ("business_profile"."default_terms_days" between 0 and 90),
	CONSTRAINT "business_profile_next_number_chk" CHECK ("business_profile"."next_number" >= 1)
);
--> statement-breakpoint
CREATE TABLE "client" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"address" text DEFAULT '' NOT NULL,
	"hourly_rate_cents" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_id_owner_uq" UNIQUE("id","owner_id"),
	CONSTRAINT "client_rate_chk" CHECK ("client"."hourly_rate_cents" between 0 and 100000)
);
--> statement-breakpoint
CREATE TABLE "invoice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"client_id" uuid,
	"number" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"issue_date" date NOT NULL,
	"due_date" date NOT NULL,
	"tax_bp" integer DEFAULT 0 NOT NULL,
	"memo" text DEFAULT '' NOT NULL,
	"subtotal_cents" bigint DEFAULT 0 NOT NULL,
	"tax_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"paid_cents" bigint DEFAULT 0 NOT NULL,
	"client_snapshot" jsonb,
	"share_token_hash" char(64),
	"void_reason" text,
	"sent_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_share_token_hash_unique" UNIQUE("share_token_hash"),
	CONSTRAINT "invoice_id_owner_uq" UNIQUE("id","owner_id"),
	CONSTRAINT "invoice_owner_number_uq" UNIQUE("owner_id","number"),
	CONSTRAINT "invoice_status_chk" CHECK ("invoice"."status" in ('draft', 'sent', 'paid', 'void')),
	CONSTRAINT "invoice_tax_bp_chk" CHECK ("invoice"."tax_bp" between 0 and 3000),
	CONSTRAINT "invoice_money_chk" CHECK ("invoice"."subtotal_cents" >= 0 and "invoice"."tax_cents" >= 0 and "invoice"."total_cents" = "invoice"."subtotal_cents" + "invoice"."tax_cents" and "invoice"."paid_cents" between 0 and "invoice"."total_cents"),
	CONSTRAINT "invoice_dates_chk" CHECK ("invoice"."due_date" >= "invoice"."issue_date"),
	CONSTRAINT "invoice_sent_complete_chk" CHECK ("invoice"."status" not in ('sent', 'paid') or ("invoice"."number" is not null and "invoice"."client_id" is not null and "invoice"."client_snapshot" is not null and "invoice"."sent_at" is not null and "invoice"."total_cents" > 0)),
	CONSTRAINT "invoice_paid_chk" CHECK (("invoice"."status" = 'paid') = ("invoice"."paid_at" is not null) and ("invoice"."status" <> 'paid' or "invoice"."paid_cents" = "invoice"."total_cents")),
	CONSTRAINT "invoice_void_chk" CHECK (("invoice"."status" = 'void') = ("invoice"."voided_at" is not null)),
	CONSTRAINT "invoice_memo_chk" CHECK (char_length("invoice"."memo") <= 1000)
);
--> statement-breakpoint
CREATE TABLE "invoice_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"quantity_x100" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"amount_cents" bigint NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	CONSTRAINT "invoice_line_position_uq" UNIQUE("invoice_id","position"),
	CONSTRAINT "invoice_line_kind_chk" CHECK ("invoice_line"."kind" in ('hours', 'fixed', 'expense')),
	CONSTRAINT "invoice_line_source_chk" CHECK ("invoice_line"."source" in ('manual', 'ai')),
	CONSTRAINT "invoice_line_quantity_chk" CHECK ("invoice_line"."quantity_x100" between 1 and 9999999),
	CONSTRAINT "invoice_line_price_chk" CHECK ("invoice_line"."unit_price_cents" between 0 and 10000000),
	CONSTRAINT "invoice_line_amount_chk" CHECK ("invoice_line"."amount_cents" >= 0),
	CONSTRAINT "invoice_line_description_chk" CHECK (char_length("invoice_line"."description") between 1 and 300)
);
--> statement-breakpoint
CREATE TABLE "notes_draft" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"client_id" uuid,
	"notes" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"mode" text DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notes_draft_notes_chk" CHECK (char_length("notes_draft"."notes") <= 6000)
);
--> statement-breakpoint
CREATE TABLE "payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"method" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"stripe_session_id" text,
	"flag" text,
	"note" text DEFAULT '' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_stripe_session_id_unique" UNIQUE("stripe_session_id"),
	CONSTRAINT "payment_method_chk" CHECK ("payment"."method" in ('demo', 'stripe', 'manual')),
	CONSTRAINT "payment_flag_chk" CHECK ("payment"."flag" is null or "payment"."flag" in ('amount_mismatch', 'invoice_void')),
	CONSTRAINT "payment_amount_chk" CHECK ("payment"."amount_cents" >= 0),
	CONSTRAINT "payment_note_chk" CHECK (char_length("payment"."note") <= 200)
);
--> statement-breakpoint
CREATE TABLE "stripe_event" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "item" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "item" CASCADE;--> statement-breakpoint
-- The template's unused "upload" kind is gone; nothing in this app writes it.
DELETE FROM "rate_event" WHERE "kind" NOT IN ('api_write', 'checkout', 'ai', 'demo_load');--> statement-breakpoint
ALTER TABLE "rate_event" DROP CONSTRAINT "rate_event_kind_chk";--> statement-breakpoint
ALTER TABLE "business_profile" ADD CONSTRAINT "business_profile_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client" ADD CONSTRAINT "client_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_client_fk" FOREIGN KEY ("client_id","owner_id") REFERENCES "public"."client"("id","owner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_invoice_fk" FOREIGN KEY ("invoice_id","owner_id") REFERENCES "public"."invoice"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes_draft" ADD CONSTRAINT "notes_draft_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes_draft" ADD CONSTRAINT "notes_draft_client_fk" FOREIGN KEY ("client_id","owner_id") REFERENCES "public"."client"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_invoice_fk" FOREIGN KEY ("invoice_id","owner_id") REFERENCES "public"."invoice"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_owner_idx" ON "client" USING btree ("owner_id","archived_at");--> statement-breakpoint
CREATE INDEX "invoice_owner_status_due_idx" ON "invoice" USING btree ("owner_id","status","due_date");--> statement-breakpoint
CREATE INDEX "invoice_line_invoice_idx" ON "invoice_line" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "notes_draft_owner_idx" ON "notes_draft" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "payment_invoice_idx" ON "payment" USING btree ("invoice_id");--> statement-breakpoint
ALTER TABLE "rate_event" ADD CONSTRAINT "rate_event_kind_chk" CHECK ("rate_event"."kind" in ('api_write', 'checkout', 'ai', 'demo_load'));