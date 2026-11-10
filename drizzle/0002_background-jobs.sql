CREATE TABLE "job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"key" text,
	"owner_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 4 NOT NULL,
	"deferrals" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp (3) with time zone,
	"lock_token" uuid,
	"last_error" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp (3) with time zone,
	CONSTRAINT "job_status_chk" CHECK ("job"."status" in ('queued', 'running', 'done', 'failed')),
	CONSTRAINT "job_attempts_chk" CHECK ("job"."attempts" >= 0 and "job"."max_attempts" >= 1 and "job"."deferrals" >= 0)
);
--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_active_key_uidx" ON "job" USING btree ("kind","key") WHERE "job"."status" in ('queued', 'running') and "job"."key" is not null;--> statement-breakpoint
CREATE INDEX "job_due_idx" ON "job" USING btree ("run_after") WHERE "job"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "job_lease_idx" ON "job" USING btree ("locked_until") WHERE "job"."status" = 'running';--> statement-breakpoint
CREATE INDEX "job_kind_key_idx" ON "job" USING btree ("kind","key","created_at");--> statement-breakpoint
CREATE INDEX "job_owner_idx" ON "job" USING btree ("owner_id");