CREATE TABLE "crm_deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_deals_position_nonnegative" CHECK ("position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "crm_deals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "crm_pipeline_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_pipeline_stages_name_not_blank" CHECK (length(btrim("name")) > 0),
	CONSTRAINT "crm_pipeline_stages_position_nonnegative" CHECK ("position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "crm_pipeline_stages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "crm_pipelines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_pipelines_name_not_blank" CHECK (length(btrim("name")) > 0),
	CONSTRAINT "crm_pipelines_position_nonnegative" CHECK ("position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "crm_pipelines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "clients_tenant_id_id_key" ON "clients" ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "crm_deals_stage_position_idx" ON "crm_deals" ("stage_id","position");--> statement-breakpoint
CREATE INDEX "crm_deals_pipeline_idx" ON "crm_deals" ("pipeline_id");--> statement-breakpoint
CREATE INDEX "crm_deals_client_id_idx" ON "crm_deals" ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_deals_tenant_pipeline_client_key" ON "crm_deals" ("tenant_id","pipeline_id","client_id");--> statement-breakpoint
CREATE INDEX "crm_pipeline_stages_pipeline_position_idx" ON "crm_pipeline_stages" ("pipeline_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_pipeline_stages_pipeline_name_key" ON "crm_pipeline_stages" ("pipeline_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "crm_pipeline_stages_tenant_pipeline_id_key" ON "crm_pipeline_stages" ("tenant_id","pipeline_id","id");--> statement-breakpoint
CREATE INDEX "crm_pipelines_tenant_id_idx" ON "crm_pipelines" ("tenant_id");--> statement-breakpoint
CREATE INDEX "crm_pipelines_position_idx" ON "crm_pipelines" ("position");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_pipelines_tenant_id_id_key" ON "crm_pipelines" ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_pipelines_tenant_name_key" ON "crm_pipelines" ("tenant_id",lower("name"));--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_created_by_users_id_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_pipeline_fk" FOREIGN KEY ("tenant_id","pipeline_id") REFERENCES "crm_pipelines"("tenant_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_pipeline_stage_fk" FOREIGN KEY ("tenant_id","pipeline_id","stage_id") REFERENCES "crm_pipeline_stages"("tenant_id","pipeline_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "clients"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "crm_pipeline_stages" ADD CONSTRAINT "crm_pipeline_stages_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "crm_pipeline_stages" ADD CONSTRAINT "crm_pipeline_stages_pipeline_fk" FOREIGN KEY ("tenant_id","pipeline_id") REFERENCES "crm_pipelines"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "crm_pipelines" ADD CONSTRAINT "crm_pipelines_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_deals" AS PERMISSIVE FOR ALL TO "infynix_tenant" USING ("crm_deals"."tenant_id" = (nullif(current_setting('app.tenant_id', true), ''))::uuid) WITH CHECK ("crm_deals"."tenant_id" = (nullif(current_setting('app.tenant_id', true), ''))::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_pipeline_stages" AS PERMISSIVE FOR ALL TO "infynix_tenant" USING ("crm_pipeline_stages"."tenant_id" = (nullif(current_setting('app.tenant_id', true), ''))::uuid) WITH CHECK ("crm_pipeline_stages"."tenant_id" = (nullif(current_setting('app.tenant_id', true), ''))::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_pipelines" AS PERMISSIVE FOR ALL TO "infynix_tenant" USING ("crm_pipelines"."tenant_id" = (nullif(current_setting('app.tenant_id', true), ''))::uuid) WITH CHECK ("crm_pipelines"."tenant_id" = (nullif(current_setting('app.tenant_id', true), ''))::uuid);--> statement-breakpoint
-- [hand-written] CRM tables are read and written through TenantDb (role
-- infynix_tenant); without grants the restricted role cannot touch them.
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_pipelines" TO "infynix_tenant";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_pipeline_stages" TO "infynix_tenant";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_deals" TO "infynix_tenant";
