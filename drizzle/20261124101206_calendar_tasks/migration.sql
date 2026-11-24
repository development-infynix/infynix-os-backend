-- Calendar tasks (docs/calendar-plan.md, decisions T1–T8).
-- Hand-edited: the assignee foreign key sets only assignee_id to null, never tenant_id.
ALTER TABLE "calendar_events" ADD COLUMN "assignee_id" uuid;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "priority" text;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "previous_status" text;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "hold_reason" text;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "hold_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "completion_remarks" text;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "reject_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "extension_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "extension_reason" text;--> statement-breakpoint
CREATE INDEX "calendar_events_assignee_idx" ON "calendar_events" ("tenant_id","assignee_id");--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_assignee_fk" FOREIGN KEY ("tenant_id","assignee_id") REFERENCES "users"("tenant_id","id") ON DELETE SET NULL ("assignee_id");--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_hold_shape" CHECK (("status" <> 'on_hold' OR "hold_until" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_reject_count" CHECK ("reject_count" >= 0);--> statement-breakpoint
ALTER TABLE "calendar_events" DROP CONSTRAINT "calendar_events_type_valid", ADD CONSTRAINT "calendar_events_type_valid" CHECK ("type" IN ('announcement', 'meeting', 'task'));--> statement-breakpoint
ALTER TABLE "calendar_events" DROP CONSTRAINT "calendar_events_status_valid", ADD CONSTRAINT "calendar_events_status_valid" CHECK ((
        ("type" IN ('announcement', 'meeting') AND "status" IN ('scheduled', 'cancelled'))
        OR ("type" = 'task' AND "status" IN (
          'assigned', 'progress', 'on_review', 'on_hold', 'request_cancelation', 'cancelled', 'failed', 'completed'
        ))
      ));--> statement-breakpoint
ALTER TABLE "calendar_events" DROP CONSTRAINT "calendar_events_type_shape", ADD CONSTRAINT "calendar_events_type_shape" CHECK ((
        ("type" = 'announcement' AND "description" IS NOT NULL
          AND "location" IS NULL AND "visibility" IS NULL AND "priority" IS NULL)
        OR ("type" = 'meeting' AND "location" IS NOT NULL
          AND "visibility" IN ('open', 'private') AND "priority" IS NULL)
        OR ("type" = 'task' AND "location" IS NULL AND "visibility" IS NULL
          AND "priority" IN ('low', 'medium', 'high', 'urgent'))
      ));--> statement-breakpoint
-- [hand-written] T6: when a person is deleted, the open tasks assigned to them go back
-- to their creator as "assigned" (logged); finished ones keep a null assignee. Runs
-- before the delete, so the assignee foreign key's SET NULL only touches what's left.
CREATE OR REPLACE FUNCTION "calendar_tasks_return_to_creator"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  WITH moved AS (
    UPDATE "calendar_events" e
       SET "assignee_id" = e."created_by", "status" = 'assigned', "previous_status" = NULL,
           "hold_reason" = NULL, "hold_until" = NULL, "extension_until" = NULL, "extension_reason" = NULL,
           "cancel_reason" = NULL, "reject_count" = 0, "version" = e."version" + 1, "updated_at" = now()
     WHERE e."tenant_id" = OLD."tenant_id" AND e."assignee_id" = OLD."id" AND e."type" = 'task'
       AND e."deleted_at" IS NULL
       AND e."status" IN ('assigned', 'progress', 'on_review', 'on_hold', 'request_cancelation', 'failed')
       AND e."created_by" IS NOT NULL AND e."created_by" <> OLD."id"
    RETURNING e."id", e."tenant_id"
  )
  INSERT INTO "calendar_event_log" ("tenant_id", "event_id", "actor_id", "action", "to_status", "meta")
  SELECT "tenant_id", "id", NULL, 'reassigned', 'assigned', '{"reason": "assignee deleted"}'::jsonb FROM moved;
  RETURN OLD;
END
$$;--> statement-breakpoint
CREATE TRIGGER "users_return_calendar_tasks" BEFORE DELETE ON "users"
  FOR EACH ROW EXECUTE FUNCTION "calendar_tasks_return_to_creator"();