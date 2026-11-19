ALTER TABLE "clients" DROP CONSTRAINT "clients_import_id_client_imports_id_fkey";--> statement-breakpoint
ALTER TABLE "user_access" DROP CONSTRAINT "user_access_user_id_users_id_fkey";--> statement-breakpoint
CREATE UNIQUE INDEX "client_imports_tenant_id_id_key" ON "client_imports" ("tenant_id","id");--> statement-breakpoint
-- Safety nets before the same-company links (no such rows are expected; the
-- app never writes them): unlink clients from another company's import, and
-- drop grants that name a person from another company.
UPDATE "clients" c SET "import_id" = NULL
FROM "client_imports" ci
WHERE ci."id" = c."import_id" AND ci."tenant_id" <> c."tenant_id";--> statement-breakpoint
DELETE FROM "user_access" ua
USING "users" u
WHERE u."id" = ua."user_id" AND u."tenant_id" <> ua."tenant_id";--> statement-breakpoint
-- Hand-edited: SET NULL ("import_id") clears only the import, never tenant_id
-- (NOT NULL). Needs Postgres 15+. drizzle-kit writes plain SET NULL here.
ALTER TABLE "clients" ADD CONSTRAINT "clients_import_fk" FOREIGN KEY ("tenant_id","import_id") REFERENCES "client_imports"("tenant_id","id") ON DELETE SET NULL ("import_id");--> statement-breakpoint
ALTER TABLE "user_access" ADD CONSTRAINT "user_access_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "users"("tenant_id","id") ON DELETE CASCADE;