CREATE TABLE "crm_pipeline_users" (
	"tenant_id" uuid NOT NULL,
	"pipeline_id" uuid,
	"user_id" uuid,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_pipeline_users_pkey" PRIMARY KEY("pipeline_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "crm_pipeline_users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "crm_pipeline_users_user_idx" ON "crm_pipeline_users" ("user_id");--> statement-breakpoint
ALTER TABLE "crm_pipeline_users" ADD CONSTRAINT "crm_pipeline_users_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "crm_pipeline_users" ADD CONSTRAINT "crm_pipeline_users_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "crm_pipeline_users" ADD CONSTRAINT "crm_pipeline_users_granted_by_users_id_fkey" FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "crm_pipeline_users" ADD CONSTRAINT "crm_pipeline_users_pipeline_fk" FOREIGN KEY ("tenant_id","pipeline_id") REFERENCES "crm_pipelines"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_pipeline_users" AS PERMISSIVE FOR ALL TO "infynix_tenant" USING ("crm_pipeline_users"."tenant_id" = (nullif(current_setting('app.tenant_id', true), ''))::uuid) WITH CHECK ("crm_pipeline_users"."tenant_id" = (nullif(current_setting('app.tenant_id', true), ''))::uuid);--> statement-breakpoint
-- The restricted tenant role needs an explicit grant on every company-owned table.
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_pipeline_users" TO "infynix_tenant";--> statement-breakpoint
-- Backfill: existing pipelines keep everyone who can use the CRM today, so
-- nobody loses a pipeline they could see. Owners get no rows (they see all).
INSERT INTO "crm_pipeline_users" ("tenant_id", "pipeline_id", "user_id")
SELECT p."tenant_id", p."id", u."id"
FROM "crm_pipelines" p
JOIN "users" u
  ON u."tenant_id" = p."tenant_id" AND u."is_active" AND u."role" <> 'owner'
JOIN "user_access" ua
  ON ua."user_id" = u."id" AND ua."tenant_id" = p."tenant_id"
JOIN "access_items" ai
  ON ai."id" = ua."access_item_id" AND ai."key" = 'crm' AND ai."is_active"
ON CONFLICT DO NOTHING;
