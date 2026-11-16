-- [hand-ordered] One company per person: users carry tenant_id + role, and
-- memberships goes away. Columns are added nullable, filled from each
-- person's earliest membership, then made NOT NULL.
ALTER TABLE "users" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" "member_role" DEFAULT 'staff'::"member_role" NOT NULL;--> statement-breakpoint
UPDATE "users" u SET "tenant_id" = m."tenant_id", "role" = m."role"
FROM (
  SELECT DISTINCT ON ("user_id") "user_id", "tenant_id", "role"
  FROM "memberships" ORDER BY "user_id", "created_at"
) m
WHERE m."user_id" = u."id";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
DROP POLICY "tenant_isolation" ON "memberships";--> statement-breakpoint
DROP TABLE "memberships";--> statement-breakpoint
DROP INDEX "tenants_slug_key";--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN "slug";--> statement-breakpoint
CREATE INDEX "users_tenant_id_idx" ON "users" ("tenant_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "users" AS PERMISSIVE FOR ALL TO "infynix_tenant" USING ("users"."tenant_id" = (nullif(current_setting('app.tenant_id', true), ''))::uuid) WITH CHECK ("users"."tenant_id" = (nullif(current_setting('app.tenant_id', true), ''))::uuid);--> statement-breakpoint
-- [hand-written] Owners and managers add, edit and remove their employees
-- through TenantDb (role infynix_tenant), so it needs writes on users.
GRANT SELECT, INSERT, UPDATE, DELETE ON "users" TO "infynix_tenant";
