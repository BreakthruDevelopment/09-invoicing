CREATE TABLE "daily_usage" (
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "daily_usage_day_kind_pk" PRIMARY KEY("day","kind"),
	CONSTRAINT "daily_usage_kind_chk" CHECK ("daily_usage"."kind" in ('ai', 'demo_load')),
	CONSTRAINT "daily_usage_count_chk" CHECK ("daily_usage"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "rate_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_event_kind_chk" CHECK ("rate_event"."kind" in ('api_write', 'ai', 'upload'))
);
--> statement-breakpoint
ALTER TABLE "rate_event" ADD CONSTRAINT "rate_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rate_event_user_kind_at_idx" ON "rate_event" USING btree ("user_id","kind","at");