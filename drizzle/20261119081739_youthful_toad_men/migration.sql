ALTER TABLE "crm_pipeline_users" DROP CONSTRAINT "crm_pipeline_users_user_id_users_id_fkey";--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_id_id_key" ON "users" ("tenant_id","id");--> statement-breakpoint
-- Safety net before the same-company link: drop any access row whose person
-- belongs to another company (none are expected; the app never writes them).
DELETE FROM "crm_pipeline_users" pu
USING "users" u
WHERE u."id" = pu."user_id" AND u."tenant_id" <> pu."tenant_id";--> statement-breakpoint
ALTER TABLE "crm_pipeline_users" ADD CONSTRAINT "crm_pipeline_users_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "users"("tenant_id","id") ON DELETE CASCADE;