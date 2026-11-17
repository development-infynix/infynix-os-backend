CREATE TABLE "client_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"file_name" text NOT NULL,
	"row_count" integer NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"rows" jsonb DEFAULT '[]' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_imports_row_count_max" CHECK ("row_count" <= 500),
	CONSTRAINT "client_imports_name_not_blank" CHECK (length(btrim("name")) > 0),
	CONSTRAINT "client_imports_file_name_not_blank" CHECK (length(btrim("file_name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "client_imports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "import_id" uuid;--> statement-breakpoint
CREATE INDEX "client_imports_tenant_id_idx" ON "client_imports" ("tenant_id");--> statement-breakpoint
CREATE INDEX "clients_import_id_idx" ON "clients" ("import_id");--> statement-breakpoint
ALTER TABLE "client_imports" ADD CONSTRAINT "client_imports_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "client_imports" ADD CONSTRAINT "client_imports_created_by_users_id_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_import_id_client_imports_id_fkey" FOREIGN KEY ("import_id") REFERENCES "client_imports"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "client_imports" AS PERMISSIVE FOR ALL TO "infynix_tenant" USING ("client_imports"."tenant_id" = (nullif(current_setting('app.tenant_id', true), ''))::uuid) WITH CHECK ("client_imports"."tenant_id" = (nullif(current_setting('app.tenant_id', true), ''))::uuid);--> statement-breakpoint
-- [hand-written] Imports are read and written through TenantDb (role
-- infynix_tenant); without grants the restricted role cannot touch them.
-- RLS on clients was already enabled in the earlier migration; table-level
-- grants also cover its new import_id column.
GRANT SELECT, INSERT, UPDATE, DELETE ON "client_imports" TO "infynix_tenant";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "clients" TO "infynix_tenant";