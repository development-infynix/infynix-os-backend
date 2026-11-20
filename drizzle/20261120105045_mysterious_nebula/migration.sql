-- No duplicate people within a company: one client per email (ignoring case and
-- spaces) and per phone (digits only). The same person may still be a client of
-- two companies. Existing duplicates must be removed first (for example by
-- deleting a spreadsheet that was imported twice); this stops with a clear
-- message instead of a bare "could not create unique index".
DO $$
DECLARE
  dup_emails integer;
  dup_phones integer;
BEGIN
  SELECT count(*) INTO dup_emails FROM (
    SELECT 1 FROM "clients" WHERE "email" IS NOT NULL
    GROUP BY "tenant_id", lower(btrim("email")) HAVING count(*) > 1
  ) d;
  SELECT count(*) INTO dup_phones FROM (
    SELECT 1 FROM "clients" WHERE regexp_replace("phone", '\D', '', 'g') <> ''
    GROUP BY "tenant_id", regexp_replace("phone", '\D', '', 'g') HAVING count(*) > 1
  ) d;
  IF dup_emails > 0 OR dup_phones > 0 THEN
    RAISE EXCEPTION 'Cannot add the no-duplicate-clients rule: % email(s) and % phone number(s) are shared by more than one client in the same company. Remove the duplicates (e.g. delete the import that brought them in) and run the migration again.', dup_emails, dup_phones;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "clients_tenant_email_key" ON "clients" ("tenant_id",lower(btrim("email"))) WHERE "email" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "clients_tenant_phone_key" ON "clients" ("tenant_id",regexp_replace("phone", '\D', '', 'g')) WHERE regexp_replace("phone", '\D', '', 'g') <> '';