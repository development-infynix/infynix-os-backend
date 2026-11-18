# Clients module

The client directory is the source of truth for companies the workspace serves. CRM, sales, payments, invoices and other modules will point back to these records instead of keeping their own copies of contact data.

- **Status:** implemented on 17 Nov 2026
- **Backend:** NestJS 12 · Drizzle ORM · PostgreSQL (Neon)
- **Frontend:** React 19 · TanStack Router/Query · Tailwind 4
- **Migration:** `drizzle/20261117104335_wet_cannonball/migration.sql`
- **Related access doc:** [access-model.md](access-model.md)

---

## 1. The model in one paragraph

A client belongs to exactly one company (tenant). Every query runs through `TenantDb`, which sets `app.tenant_id` and switches to the restricted `infynix_tenant` role; row-level security on `clients` keeps one company's records away from another's. A client needs a name and at least one way to reach them — email or phone. Both are optional individually, but the API and the database reject a record with neither. Anything else the company wants to remember lives in `custom_details`, a JSON object of key/value pairs owned by the frontend.

```
tenants (company)
    │
    └── clients  (RLS: tenant_id = app.tenant_id)
          id, name, email, phone
          custom_details jsonb
          created_at, updated_at
```

Clients are **not** copied into a global catalogue: each company has its own rows, unlike the shared `access_items` menu list.

---

## 2. Data model

### `clients` — company-owned

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | primary key, `gen_random_uuid()` |
| `tenant_id` | `uuid` | FK `tenants.id`, `ON DELETE CASCADE` |
| `name` | `text` | required, trimmed, 1–120 chars |
| `email` | `text` | nullable, trimmed and lowercased, valid email, max 254 |
| `phone` | `text` | nullable, trimmed, max 50 |
| `import_id` | `uuid` | nullable FK `client_imports.id`, `ON DELETE SET NULL`; set on imported clients |
| `custom_details` | `jsonb` | not null, default `{}`, `Record<string, unknown>` in TypeScript |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | default `now()`, refreshed on update |

Checks and indexes:

- `clients_name_not_blank` — `length(btrim(name)) > 0`
- `clients_contact_required` — `email is not null or phone is not null`
- `clients_tenant_id_idx` on `tenant_id`
- RLS policy `tenant_isolation` for `infynix_tenant`, plus `GRANT SELECT, INSERT, UPDATE, DELETE`

The API normalises blank optional contact values to `null`, so an empty string never reaches the database check.

### `client_imports` — one batch per spreadsheet

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | primary key |
| `tenant_id` | `uuid` | FK `tenants.id`, `ON DELETE CASCADE` |
| `name` | `text` | user-supplied import name, 1–120 chars |
| `file_name` | `text` | original spreadsheet filename |
| `row_count` | `integer` | data rows in the file, capped at 500 |
| `created_count` | `integer` | clients created so far |
| `skipped_count` | `integer` | rows skipped so far |
| `rows` | `jsonb` | array of normalized rows as they were imported |
| `created_by` | `uuid` | FK `users.id`, `ON DELETE SET NULL` |
| `created_at` | `timestamptz` | default `now()` |

RLS and grants match `clients`. Counts are incremented atomically per chunk, and `import_id` on `clients` points back to the batch. Import records keep the raw rows even if a client is later edited or deleted.

---

## 3. Validation rules

- **Name** is required on create and optional on update, but a blank name is never accepted.
- **Contact:** at least one of `email` or `phone` must be present. The create DTO enforces this before the request reaches the service; on update the service merges the patch with the stored values and rejects the change if it would leave no contact method.
- **Email** is lowercased and validated as an email address when provided.
- **Custom details** must be a plain object. The UI collects string values; the database can hold strings, numbers, booleans or `null`.

---

## 4. API

Routes are under `/api/v1/clients` and `/api/v1/client-imports`, all guarded by `ClientPolicy.use`:

- Owners always pass.
- Managers and staff pass only when their session grants include the `clients` menu key.

Hiding the menu therefore also closes the endpoints; this is the first module where the menu grant is enforced server-side.

| Method | Path | Body / query | Response |
|---|---|---|---|
| `GET` | `/clients` | `page` (default 1), `pageSize` (default 100, max 100), `q` (optional search), `importId` (optional) | `{ items, total, page, pageSize, totalPages }` |
| `GET` | `/clients/:id` | — | one `Client`, 404 when missing |
| `POST` | `/clients/import` | `{ importId, clients: ClientInput[] }`, max 100 rows | `{ created, skipped }`, 201 |
| `POST` | `/clients` | `{ name, email?, phone?, customDetails? }` | created `Client`, 201 |
| `POST` | `/client-imports` | `{ name, fileName, rowCount }` | import summary with `id`, 201 |
| `GET` | `/client-imports` | — | newest import summaries |
| `GET` | `/client-imports/:id` | — | summary plus stored `rows` |
| `PATCH` | `/client-imports/:id` | `{ name }` | renamed import summary |
| `DELETE` | `/client-imports/:id` | — | 204; deletes linked clients in 100-row chunks, then the import |
| `PATCH` | `/clients/:id` | any subset of the create fields | updated `Client` |
| `DELETE` | `/clients/:id` | — | 204 |

Search `q` matches name, email or phone case-insensitively; `%` and `_` typed by the user are escaped so they match literally. Results are ordered by `updated_at` descending, then `created_at` descending, then `id` descending as a stable tie-breaker — the most recently touched client is first.

Backend files:

- `src/db/schema.ts` — table, checks, RLS
- `src/clients/dto/clients.dto.ts` — request validation
- `src/clients/client.policy.ts` — grant-based authorization
- `src/clients/clients.repository.ts` — SQL, search, ordering, pagination
- `src/clients/clients.service.ts` — tenant transactions, contact rules, errors
- `src/clients/clients.controller.ts` — HTTP routes
- `src/clients/clients.module.ts` — registration in `AppModule`
- `src/clients/clients.service.spec.ts` — contact validation and custom details
- `src/clients/client-imports.*` — import records, summaries, stored rows, chunk counters

---

## 5. Frontend

`src/lib/clients.ts` owns the API client and query keys:

- `clientsPageQuery(page, q)` — 100 rows per page, `keepPreviousData`
- `clientQuery(id)` — one client for the drawer
- `addClient`, `updateClient`, `removeClient`
- `detailsToRows` / `rowsToDetails` convert between the JSON object and the key/value editor

The page has **Clients** and **Imports** tabs styled as the recessed segmented control. The Add client button stays available on both tabs. Route: `src/routes/_authed/clients.tsx` keeps `?page=`, `?q=` and `?importId=` in the URL. Switching the funnel filter updates `importId`, and the route loader prefetches that filtered page from the server before the component renders. The existing `requireAccess(session, 'clients')` guard stays in place.

On the Imports tab, **View rows** switches to Clients with that import's `importId` selected in the funnel filter. The funnel dropdown offers **All clients** plus one option per import, and `GET /clients` accepts the same `importId` filter.

Screens:

- `src/clients/pages/ClientsPage.tsx` — desktop table, mobile cards, shared `Loader`, error/retry, pagination, icon-only delete next to View
- `src/clients/components/SearchClientsDialog.tsx` — debounced search by name, email or phone; arrow keys and Enter
- `src/clients/components/AddClientDialog.tsx` — form entry point from the **Add client** dropdown
- `src/clients/components/ClientImportModal.tsx` — four-step Excel/CSV import wizard
- `src/clients/components/ClientImportsPanel.tsx` — import cards on the Imports tab
- `src/clients/components/ClientImportCard.tsx` — one card with settings menu (rename, delete, disabled Move to CRM)
- `src/clients/components/ClientDetailsDrawer.tsx` — view, edit and delete
- `src/clients/components/CustomDetailsEditor.tsx` — key/value rows

The **Add client** dropdown offers **Form** (opens the add modal) and **Imports** (opens the four-step spreadsheet import modal).

### Custom details editor

Each row is `key`, `value`, then one action button. Only the last row shows `+`; earlier rows show `X`. Clicking `+` appends a blank row and scrolls it (and the next `+`) into view. Blank keys are discarded on save. The add modal caps its body height so a long list of details never pushes its footer off-screen.

### Import wizard

`ClientImportModal` has four steps:

1. **Upload file** — `.xlsx`, `.xls` or `.csv`; the first row is read as column headings.
2. **Match fields** — choose which columns hold name, email and phone. Name plus at least one contact column is required; common headings are pre-selected.
3. **Select fields** — pick remaining columns to keep as custom details.
4. **Preview** — name the import, then see the first five mapped rows before importing.

Submitting first creates a `client_imports` record with the chosen name and file details, then splits valid rows into chunks of 100 and posts each chunk to `POST /clients/import` with that `importId`. Each created client stores the same `import_id`. During the import the stepper becomes a progress bar; the submit button reads “Importing…”. The server counts rows with no name/contact or an invalid email as skipped and increments the import counters atomically. Both `CLIENTS_KEY` and `CLIENT_IMPORTS_KEY` are invalidated when all chunks finish.

### Mobile layout

Users and Clients share the same mobile pattern: the toolbar is a 52px sticky sub-header directly under the main header, holding search/filter/add icon buttons. Cards scroll in a bounded area with bottom padding so the last card clears the fixed pagination footer. The scrollbar is hidden.

---

## 6. What is not in this slice

- No links from CRM, sales, payments or invoices to clients yet — those modules are still empty states.
- Imports are chunked by the client at 100 rows per `POST /clients/import`; there is no single atomic bulk import for all 500 rows, and a failed chunk leaves earlier chunks committed.
- No `action`-kind permission for creating or deleting clients; the `clients` menu grant currently covers all client endpoints.
- No duplicate detection on email or phone; two clients may share a contact method.
