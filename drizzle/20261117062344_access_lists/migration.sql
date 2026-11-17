CREATE TYPE "access_kind" AS ENUM('menu', 'action');--> statement-breakpoint
CREATE TABLE "access_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"key" text NOT NULL,
	"label" text NOT NULL,
	"kind" "access_kind" DEFAULT 'menu'::"access_kind" NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"access_item_id" uuid NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_access" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "access_items_key_key" ON "access_items" ("key");--> statement-breakpoint
CREATE INDEX "access_items_kind_sort_idx" ON "access_items" ("kind","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "user_access_user_item_key" ON "user_access" ("user_id","access_item_id");--> statement-breakpoint
CREATE INDEX "user_access_tenant_idx" ON "user_access" ("tenant_id");--> statement-breakpoint
CREATE INDEX "user_access_user_idx" ON "user_access" ("user_id");--> statement-breakpoint
ALTER TABLE "user_access" ADD CONSTRAINT "user_access_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_access" ADD CONSTRAINT "user_access_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_access" ADD CONSTRAINT "user_access_access_item_id_access_items_id_fkey" FOREIGN KEY ("access_item_id") REFERENCES "access_items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_access" ADD CONSTRAINT "user_access_granted_by_users_id_fkey" FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "user_access" AS PERMISSIVE FOR ALL TO "infynix_tenant" USING ("user_access"."tenant_id" = (nullif(current_setting('app.tenant_id', true), ''))::uuid) WITH CHECK ("user_access"."tenant_id" = (nullif(current_setting('app.tenant_id', true), ''))::uuid);--> statement-breakpoint
-- [hand-written] The seven sidebar menus. Global on purpose: every company
-- gets the same list, only the grants differ.
INSERT INTO "access_items" ("key", "label", "kind", "sort_order") VALUES
  ('clients', 'Clients', 'menu', 10),
  ('crm', 'CRM', 'menu', 20),
  ('calendar', 'Calendar', 'menu', 30),
  ('payments-budget', 'Payments & Budget', 'menu', 40),
  ('project-management', 'Project Management', 'menu', 50),
  ('invoices', 'Invoices', 'menu', 60),
  ('media', 'Media', 'menu', 70)
ON CONFLICT ("key") DO UPDATE SET
  "label" = excluded."label",
  "kind" = excluded."kind",
  "sort_order" = excluded."sort_order",
  "is_active" = true,
  "updated_at" = now();--> statement-breakpoint
-- [hand-written] Company-scoped access work runs through TenantDb (role
-- infynix_tenant): it may read the global menu list and write its own grants.
-- RLS on user_access keeps other companies' grants invisible.
GRANT SELECT ON "access_items" TO "infynix_tenant";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "user_access" TO "infynix_tenant";