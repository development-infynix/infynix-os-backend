CREATE TYPE "member_role" AS ENUM('owner', 'manager', 'staff');--> statement-breakpoint
CREATE TYPE "tenant_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE ROLE "infynix_tenant";--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" DEFAULT 'staff'::"member_role" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" "tenant_status" DEFAULT 'active'::"tenant_status" NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_created_by_users_id_fkey";--> statement-breakpoint
DROP INDEX "users_role_idx";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_platform_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- [hand-written] Data: the single-company accounts move into an "Infynix"
-- company before the global role column is dropped. superadmin -> owner (and
-- platform admin), manager -> manager, staff -> staff.
UPDATE "users" SET "is_platform_admin" = true WHERE "role" = 'superadmin';--> statement-breakpoint
INSERT INTO "tenants" ("slug", "name", "created_by")
SELECT 'infynix', 'Infynix', (SELECT "id" FROM "users" WHERE "role" = 'superadmin' ORDER BY "created_at" LIMIT 1)
WHERE EXISTS (SELECT 1 FROM "users");--> statement-breakpoint
INSERT INTO "memberships" ("tenant_id", "user_id", "role", "is_active")
SELECT t."id", u."id",
  (CASE u."role" WHEN 'superadmin' THEN 'owner' WHEN 'manager' THEN 'manager' ELSE 'staff' END)::"member_role",
  u."is_active"
FROM "users" u CROSS JOIN "tenants" t WHERE t."slug" = 'infynix';--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "role";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "created_by";--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_tenant_user_key" ON "memberships" ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "memberships_user_id_idx" ON "memberships" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants" ("slug");--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_invited_by_users_id_fkey" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_created_by_users_id_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "memberships" AS PERMISSIVE FOR ALL TO "infynix_tenant" USING ("memberships"."tenant_id" = (nullif(current_setting('app.tenant_id', true), ''))::uuid) WITH CHECK ("memberships"."tenant_id" = (nullif(current_setting('app.tenant_id', true), ''))::uuid);--> statement-breakpoint
DROP TYPE "user_role";--> statement-breakpoint
-- [hand-written] The connection's owner role bypasses RLS; company-scoped
-- queries switch to infynix_tenant (SET LOCAL ROLE) so the policies apply.
-- The owner needs SET on the role, and the role needs explicit grants: add a
-- GRANT here for every new company-owned table (never ALTER DEFAULT
-- PRIVILEGES, which would also open global tables).
GRANT "infynix_tenant" TO CURRENT_USER WITH SET TRUE;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO "infynix_tenant";--> statement-breakpoint
GRANT SELECT ON "users", "tenants" TO "infynix_tenant";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "memberships" TO "infynix_tenant";