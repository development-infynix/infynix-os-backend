-- Reports (docs/reports-module.md). The first copies of these two tables were
-- created outside migrations during development, with no reports in them;
-- drop any such copy so every database ends up with exactly this shape.
DROP TABLE IF EXISTS "reports";--> statement-breakpoint
DROP TABLE IF EXISTS "report_settings";--> statement-breakpoint
CREATE TABLE "report_settings" (
	"tenant_id" uuid PRIMARY KEY,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"due_time" time,
	"skip_days" smallint[] DEFAULT '{}'::smallint[] NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "report_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"report_date" date NOT NULL,
	"report_items" jsonb DEFAULT '[]' NOT NULL,
	"created_by" uuid,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"attachment_type" text,
	"attachment_url" text,
	"remarks" text,
	CONSTRAINT "reports_items_array" CHECK (jsonb_typeof("report_items") = 'array'),
	CONSTRAINT "reports_attachment_type_valid" CHECK ("attachment_type" IS NULL OR "attachment_type" = 'url'),
	CONSTRAINT "reports_attachment_shape" CHECK ((
        ("attachment_type" IS NULL AND "attachment_url" IS NULL)
        OR ("attachment_type" = 'url' AND "attachment_url" IS NOT NULL)
      ))
);
--> statement-breakpoint
ALTER TABLE "reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "reports_tenant_id_idx" ON "reports" ("tenant_id");--> statement-breakpoint
CREATE INDEX "reports_report_date_idx" ON "reports" ("report_date");--> statement-breakpoint
CREATE INDEX "reports_created_by_idx" ON "reports" ("created_by");--> statement-breakpoint
CREATE INDEX "reports_submitted_at_idx" ON "reports" ("submitted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_tenant_created_by_date_key" ON "reports" ("tenant_id","created_by","report_date");--> statement-breakpoint
ALTER TABLE "report_settings" ADD CONSTRAINT "report_settings_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
-- Hand-edited: SET NULL (column) clears only the person, never tenant_id.
ALTER TABLE "report_settings" ADD CONSTRAINT "report_settings_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "users"("tenant_id","id") ON DELETE SET NULL ("updated_by");--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "users"("tenant_id","id") ON DELETE SET NULL ("created_by");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "report_settings" AS PERMISSIVE FOR ALL TO "infynix_tenant" USING ("report_settings"."tenant_id" = (nullif(current_setting('app.tenant_id', true), ''))::uuid) WITH CHECK ("report_settings"."tenant_id" = (nullif(current_setting('app.tenant_id', true), ''))::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "reports" AS PERMISSIVE FOR ALL TO "infynix_tenant" USING ("reports"."tenant_id" = (nullif(current_setting('app.tenant_id', true), ''))::uuid) WITH CHECK ("reports"."tenant_id" = (nullif(current_setting('app.tenant_id', true), ''))::uuid);--> statement-breakpoint
-- [hand-written] Company-scoped work runs through TenantDb (role infynix_tenant).
GRANT SELECT, INSERT, UPDATE, DELETE ON "reports" TO "infynix_tenant";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "report_settings" TO "infynix_tenant";--> statement-breakpoint
-- [hand-written] The Reports menu, so owners can grant it to managers and staff.
INSERT INTO "access_items" ("key", "label", "kind", "sort_order") VALUES
  ('reports', 'Reports', 'menu', 25)
ON CONFLICT ("key") DO UPDATE SET
  "label" = excluded."label",
  "kind" = excluded."kind",
  "sort_order" = excluded."sort_order",
  "is_active" = true,
  "updated_at" = now();
