-- Calendar (docs/calendar-plan.md): announcements and meetings, company-scoped.
-- Hand-edited: person foreign keys SET NULL only the person column, never tenant_id.
CREATE TABLE "calendar_event_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"reason" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_event_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"location" text,
	"visibility" text,
	"cancel_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_events_type_valid" CHECK ("type" IN ('announcement', 'meeting')),
	CONSTRAINT "calendar_events_status_valid" CHECK ("status" IN ('scheduled', 'cancelled')),
	CONSTRAINT "calendar_events_title_not_blank" CHECK (length(btrim("title")) > 0),
	CONSTRAINT "calendar_events_time_order" CHECK ("ends_at" > "starts_at"),
	CONSTRAINT "calendar_events_type_shape" CHECK ((
        ("type" = 'announcement' AND "description" IS NOT NULL
          AND "location" IS NULL AND "visibility" IS NULL)
        OR ("type" = 'meeting' AND "location" IS NOT NULL
          AND "visibility" IN ('open', 'private'))
      ))
);
--> statement-breakpoint
ALTER TABLE "calendar_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "calendar_meeting_members" (
	"tenant_id" uuid,
	"event_id" uuid,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_meeting_members_pkey" PRIMARY KEY("tenant_id","event_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "calendar_meeting_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "calendar_event_log_event_idx" ON "calendar_event_log" ("tenant_id","event_id","created_at");--> statement-breakpoint
CREATE INDEX "calendar_events_tenant_starts_idx" ON "calendar_events" ("tenant_id","starts_at");--> statement-breakpoint
CREATE INDEX "calendar_events_tenant_ends_idx" ON "calendar_events" ("tenant_id","ends_at");--> statement-breakpoint
CREATE INDEX "calendar_events_created_by_idx" ON "calendar_events" ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_events_tenant_id_id_key" ON "calendar_events" ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "calendar_meeting_members_user_idx" ON "calendar_meeting_members" ("tenant_id","user_id");--> statement-breakpoint
ALTER TABLE "calendar_event_log" ADD CONSTRAINT "calendar_event_log_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "calendar_event_log" ADD CONSTRAINT "calendar_event_log_event_fk" FOREIGN KEY ("tenant_id","event_id") REFERENCES "calendar_events"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "calendar_event_log" ADD CONSTRAINT "calendar_event_log_actor_fk" FOREIGN KEY ("tenant_id","actor_id") REFERENCES "users"("tenant_id","id") ON DELETE SET NULL ("actor_id");--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "users"("tenant_id","id") ON DELETE SET NULL ("created_by");--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_deleted_by_fk" FOREIGN KEY ("tenant_id","deleted_by") REFERENCES "users"("tenant_id","id") ON DELETE SET NULL ("deleted_by");--> statement-breakpoint
ALTER TABLE "calendar_meeting_members" ADD CONSTRAINT "calendar_meeting_members_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "calendar_meeting_members" ADD CONSTRAINT "calendar_meeting_members_event_fk" FOREIGN KEY ("tenant_id","event_id") REFERENCES "calendar_events"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "calendar_meeting_members" ADD CONSTRAINT "calendar_meeting_members_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "users"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "calendar_event_log" AS PERMISSIVE FOR ALL TO "infynix_tenant" USING ("calendar_event_log"."tenant_id" = (nullif(current_setting('app.tenant_id', true), ''))::uuid) WITH CHECK ("calendar_event_log"."tenant_id" = (nullif(current_setting('app.tenant_id', true), ''))::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "calendar_events" AS PERMISSIVE FOR ALL TO "infynix_tenant" USING ("calendar_events"."tenant_id" = (nullif(current_setting('app.tenant_id', true), ''))::uuid) WITH CHECK ("calendar_events"."tenant_id" = (nullif(current_setting('app.tenant_id', true), ''))::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "calendar_meeting_members" AS PERMISSIVE FOR ALL TO "infynix_tenant" USING ("calendar_meeting_members"."tenant_id" = (nullif(current_setting('app.tenant_id', true), ''))::uuid) WITH CHECK ("calendar_meeting_members"."tenant_id" = (nullif(current_setting('app.tenant_id', true), ''))::uuid);--> statement-breakpoint
-- [hand-written] Company-scoped work runs through TenantDb (role infynix_tenant).
GRANT SELECT, INSERT, UPDATE, DELETE ON "calendar_events" TO "infynix_tenant";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "calendar_meeting_members" TO "infynix_tenant";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "calendar_event_log" TO "infynix_tenant";