ALTER TABLE "rate_event" ADD COLUMN "subject" text;--> statement-breakpoint
CREATE INDEX "rate_event_subject_idx" ON "rate_event" USING btree ("kind","subject","at");