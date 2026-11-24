-- [hand-written] T6 fix: hand a deleted assignee's open tasks back to their creator only
-- while the company and that creator still exist. Deleting a whole company removes its
-- people one by one in the same statement; without these checks the hand-back pointed
-- tasks at a creator already removed, and the company delete failed.
CREATE OR REPLACE FUNCTION "calendar_tasks_return_to_creator"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "tenants" t WHERE t."id" = OLD."tenant_id") THEN
    RETURN OLD;
  END IF;
  WITH moved AS (
    UPDATE "calendar_events" e
       SET "assignee_id" = e."created_by", "status" = 'assigned', "previous_status" = NULL,
           "hold_reason" = NULL, "hold_until" = NULL, "extension_until" = NULL, "extension_reason" = NULL,
           "cancel_reason" = NULL, "reject_count" = 0, "version" = e."version" + 1, "updated_at" = now()
     WHERE e."tenant_id" = OLD."tenant_id" AND e."assignee_id" = OLD."id" AND e."type" = 'task'
       AND e."deleted_at" IS NULL
       AND e."status" IN ('assigned', 'progress', 'on_review', 'on_hold', 'request_cancelation', 'failed')
       AND e."created_by" IS NOT NULL AND e."created_by" <> OLD."id"
       AND EXISTS (SELECT 1 FROM "users" c WHERE c."tenant_id" = e."tenant_id" AND c."id" = e."created_by")
    RETURNING e."id", e."tenant_id"
  )
  INSERT INTO "calendar_event_log" ("tenant_id", "event_id", "actor_id", "action", "to_status", "meta")
  SELECT "tenant_id", "id", NULL, 'reassigned', 'assigned', '{"reason": "assignee deleted"}'::jsonb FROM moved;
  RETURN OLD;
END
$$;
