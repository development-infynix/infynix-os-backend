-- Deal assignment (docs/user-deals-assignment.md): who owns each deal, and
-- each pipeline's rule for new deals. A deal's owner and a pipeline's
-- single-user target must be on that pipeline's access list; the two foreign
-- keys use ON DELETE SET NULL (column) so losing access clears only the owner
-- or target column (Postgres 15+), never the tenant or pipeline. Existing
-- deals start unassigned and existing pipelines on 'creator'.
ALTER TABLE "crm_deals" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "crm_deals" ADD COLUMN "assignment_source" text;--> statement-breakpoint
ALTER TABLE "crm_pipelines" ADD COLUMN "assignment_rule" text DEFAULT 'creator' NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_pipelines" ADD COLUMN "single_user_id" uuid;--> statement-breakpoint
ALTER TABLE "crm_pipelines" ADD COLUMN "round_robin_cursor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_pipelines" ADD COLUMN "created_by" uuid;--> statement-breakpoint
CREATE INDEX "crm_deals_pipeline_owner_idx" ON "crm_deals" ("pipeline_id","owner_id");--> statement-breakpoint
CREATE INDEX "crm_deals_pipeline_unassigned_idx" ON "crm_deals" ("pipeline_id","created_at","id") WHERE "owner_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "crm_pipeline_users_tenant_pipeline_user_key" ON "crm_pipeline_users" ("tenant_id","pipeline_id","user_id");--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_owner_fk" FOREIGN KEY ("tenant_id","pipeline_id","owner_id") REFERENCES "crm_pipeline_users"("tenant_id","pipeline_id","user_id") ON DELETE SET NULL ("owner_id");--> statement-breakpoint
ALTER TABLE "crm_pipelines" ADD CONSTRAINT "crm_pipelines_created_by_users_id_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "crm_pipelines" ADD CONSTRAINT "crm_pipelines_single_user_fk" FOREIGN KEY ("tenant_id","id","single_user_id") REFERENCES "crm_pipeline_users"("tenant_id","pipeline_id","user_id") ON DELETE SET NULL ("single_user_id");--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_assignment_source" CHECK ("assignment_source" is null or "assignment_source" in ('creator', 'manual', 'round_robin', 'single_user'));--> statement-breakpoint
ALTER TABLE "crm_pipelines" ADD CONSTRAINT "crm_pipelines_assignment_rule" CHECK ("assignment_rule" in ('creator', 'manual', 'round_robin', 'single_user'));--> statement-breakpoint
ALTER TABLE "crm_pipelines" ADD CONSTRAINT "crm_pipelines_round_robin_cursor_nonnegative" CHECK ("round_robin_cursor" >= 0);