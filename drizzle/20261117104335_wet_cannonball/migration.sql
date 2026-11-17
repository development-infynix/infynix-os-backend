CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"custom_details" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clients_name_not_blank" CHECK (length(btrim("name")) > 0),
	CONSTRAINT "clients_contact_required" CHECK ("email" is not null or "phone" is not null)
);
--> statement-breakpoint
ALTER TABLE "clients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "clients_tenant_id_idx" ON "clients" ("tenant_id");--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "clients" AS PERMISSIVE FOR ALL TO "infynix_tenant" USING ("clients"."tenant_id" = (nullif(current_setting('app.tenant_id', true), ''))::uuid) WITH CHECK ("clients"."tenant_id" = (nullif(current_setting('app.tenant_id', true), ''))::uuid);--> statement-breakpoint
-- [hand-written] Clients are read and written through TenantDb (role
-- infynix_tenant); without grants the restricted role cannot touch them.
GRANT SELECT, INSERT, UPDATE, DELETE ON "clients" TO "infynix_tenant";