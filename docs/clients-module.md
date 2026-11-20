# Clients module

The client directory is the source of truth for companies the workspace serves. CRM, sales, payments, invoices and other modules will point back to these records instead of keeping their own copies of contact data.

- **Status:** implemented on 17 Nov 2026
- **Backend:** NestJS 12 · Drizzle ORM · PostgreSQL (Neon)
- **Frontend:** React 19 · TanStack Router/Query · Tailwind 4
- **Migrations:** `drizzle/20261117104335_wet_cannonball/migration.sql` (clients), `drizzle/20261117185938_thankful_the_stranger/migration.sql` (imports)
- **Related access doc:** [access-model.md](access-model.md)

---

## 1. The model in one paragraph

A client belongs to exactly one company (tenant). Every query runs through `TenantDb`, which sets `app.tenant_id` and switches to the restricted `infynix_tenant` role; row-level security on both `clients` and `client_imports` keeps one company's records away from another's. A client needs a name and at least one way to reach them — email or phone. Both are optional individually, but the API and the database reject a record with neither. Anything else the company wants to remember lives in `custom_details`, a JSON object of key/value pairs owned by the frontend.

Spreadsheet imports are recorded in their own table. Each import keeps the original filename, the chosen import name, row counts, and the normalized rows as a snapshot. Clients created by a chunk carry the import's `import_id`, so the directory can be filtered back to a single batch. Manual deletes lower the import's `created_count`; `row_count` stays the number of data rows originally in the file.

```
tenants (company)
    │
    ├── client_imports (RLS) ─────┐
    │     name, file_name         │
    │     row_count, created_count, skipped_count
    │     rows jsonb (snapshot)   │
    │                             │ import_id (nullable)
    └── clients (RLS) ◄───────────┘
          name, email, phone
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
- `clients_import_id_idx` on `import_id`
- RLS policy `tenant_isolation` for `infynix_tenant`, plus `GRANT SELECT, INSERT, UPDATE, DELETE`

The API normalises blank optional contact values to `null`, so an empty string never reaches the database check.

### `client_imports` — one batch per spreadsheet

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | primary key |
| `tenant_id` | `uuid` | FK `tenants.id`, `ON DELETE CASCADE` |
| `name` | `text` | user-supplied import name, 1–120 chars; typed manually, never prefilled |
| `file_name` | `text` | original spreadsheet filename, shown on the import card |
| `row_count` | `integer` | data rows in the file, capped at 500; never decremented |
| `created_count` | `integer` | clients created so far; decremented on manual/bulk client delete |
| `skipped_count` | `integer` | rows skipped so far |
| `rows` | `jsonb` | array of normalized rows as they were imported; kept as a snapshot |
| `created_by` | `uuid` | FK `users.id`, `ON DELETE SET NULL` |
| `created_at` | `timestamptz` | default `now()` |

Checks: row count ≤ 500, non-blank name and file name. RLS and grants match `clients`. Counts are incremented atomically per import chunk and decremented with `greatest(0, created_count - n)` when clients are deleted.

---

## 3. Validation rules

- **Name** is required on create and optional on update, but a blank name is never accepted.
- **Contact:** at least one of `email` or `phone` must be present. The create DTO enforces this before the request reaches the service; on update the service merges the patch with the stored values and rejects the change if it would leave no contact method.
- **Email** is lowercased and validated as an email address when provided.
- **Custom details** must be a plain object. The UI collects string values; the database can hold strings, numbers, booleans or `null`.
- **Imports** cap at 500 data rows (headers excluded). A chunk can carry up to 500 rows, but the frontend sizes chunks to stay under the 1 MB request limit (see the import flow below), so a whole file usually goes in one request. A row with no name/contact or an invalid email is counted as skipped, not failed.

---

## 4. API

Routes are under `/api/v1/clients` and `/api/v1/client-imports`, all guarded by `ClientPolicy.use`:

- Owners always pass.
- Managers and staff pass only when their session grants include the `clients` menu key.

Hiding the menu therefore also closes the endpoints; this is the first module where the menu grant is enforced server-side.

| Method | Path | Body / query | Response |
|---|---|---|---|
| `GET` | `/clients` | `page` (default 1), `pageSize` (default 100, max 100), `q` (optional search), `importId` (optional) | `{ items, total, page, pageSize, totalPages }`; the page and its total come from one query (`count(*) over ()`) |
| `GET` | `/clients/:id` | — | one `Client`, 404 when missing |
| `POST` | `/clients` | `{ name, email?, phone?, customDetails? }` | created `Client`, 201 |
| `PATCH` | `/clients/:id` | any subset of the create fields | updated `Client` |
| `DELETE` | `/clients/:id` | — | 204; decrements the import's created count if linked |
| `DELETE` | `/clients` | `{ ids: string[] }`, max 500 | `{ deleted }`; one statement deletes the clients and lowers each affected import's count; unknown or other-company ids are skipped |
| `POST` | `/clients/import` | `{ importId, clients: ClientInput[] }`, max 500 rows (and under 1 MB) | `{ created, skipped }`, 201 |
| `POST` | `/client-imports` | `{ name, fileName, rowCount }` | import summary with `id`, 201 |
| `GET` | `/client-imports` | — | newest import summaries |
| `GET` | `/client-imports/:id` | — | summary plus stored `rows` |
| `PATCH` | `/client-imports/:id` | `{ name }` | renamed import summary |
| `DELETE` | `/client-imports/:id/clients` | `limit` (default 100, max 500; the frontend sends 500) | `{ deleted, remaining }` for one batch, in one statement that also lowers the import's count; 404 if the import doesn't exist |
| `DELETE` | `/client-imports/:id` | — | 204; one statement deletes any remaining linked clients and the import; 404 if it doesn't exist |

Search `q` matches name, email or phone case-insensitively; `%` and `_` typed by the user are escaped so they match literally. Results are ordered by `updated_at` descending, then `created_at` descending, then `id` descending as a stable tie-breaker — the most recently touched client is first.

Backend files:

- `src/db/schema.ts` — both tables, checks, RLS, grants
- `src/clients/dto/clients.dto.ts` — client/create/update/list/bulk-delete/import-chunk validation
- `src/clients/dto/client-imports.dto.ts` — import create/rename/chunk-query validation
- `src/clients/client.policy.ts` — grant-based authorization
- `src/clients/clients.repository.ts` — SQL, search, ordering, pagination, bulk deletes
- `src/clients/clients.service.ts` — tenant transactions, contact rules, bulk deletes, import counters
- `src/clients/clients.controller.ts` — client HTTP routes
- `src/clients/client-imports.repository.ts` — import records, counters, one-statement chunk and import deletes
- `src/clients/client-imports.service.ts` — import lifecycle inside tenant transactions
- `src/clients/client-imports.controller.ts` — import HTTP routes
- `src/clients/clients.module.ts` — registration in `AppModule`
- `src/clients/*.spec.ts` — contact rules, custom details, chunk and counter behavior
- `test/clients-bulk.e2e-spec.ts` — the one-statement list, bulk delete, import deletes and a full 500-row import chunk, against the real database

---

## 5. Frontend

`src/lib/clients.ts` owns the API client and query keys:

- `clientsPageQuery(page, q, importId)` — 100 rows per page, `keepPreviousData`
- `clientQuery(id)` — one client for the drawer
- `clientImportsQuery()` / `clientImportQuery(id)` — import summaries and detail rows
- `addClient`, `updateClient`, `removeClient`, `removeClients`
- `createClientImport`, `importClientsChunk`, `chunkImportRows` (size-aware chunks: up to 500 rows or 512 KB)
- `renameClientImport`, `deleteImportClientChunk`, `deleteClientImport`
- `detailsToRows` / `rowsToDetails` convert between the JSON object and the key/value editor

`src/routes/_authed/clients.tsx` keeps `?page=`, `?q=` and `?importId=` in the URL and keeps `requireAccess(session, 'clients')`. It no longer prefetches clients: clients and imports fetch separately. The clients query is enabled only on the Clients tab, the imports query mounts only on the Imports tab, and the funnel dropdown fetches options lazily when opened.

### Tabs and toolbar

The page has **Clients** and **Imports** tabs styled as the recessed segmented control; the active tab is remembered in local storage across refreshes. The Add client button stays available on both tabs. On the Clients tab:

- Search and funnel filter are shown normally.
- Selecting one or more clients replaces them with a red **Delete N** button. Bulk delete sends the selection to `DELETE /clients` 500 ids per request and invalidates both clients and imports.
- When clients are selected, Add client is replaced by an unwired **CRM** button (`MdKeyboardDoubleArrowRight`, arrow hidden on mobile).
- The funnel filter offers **All clients** plus one option per import; selecting one updates `?importId=`, so the server returns only that import's clients.

On the Imports tab, **View rows** switches to Clients with that import's `importId` selected in the funnel. Import cards show name, original filename, row/created/skipped counts, and date.

### Client rows and selection

Desktop is a table with a narrow select circle column, Name, Email, Phone, Added and Action. Mobile is one card per client with the select circle pinned top-right. Each row also has an icon-only trash action next to View; single deletes also lower the import's created count. Both desktop and mobile use the shared `Loader`, error/retry and 100-per-page pagination.

### Import cards

`ClientImportCard` owns one card and its settings menu (`VscSettingsCompact`):

- **Rename** — inline edit in the card header: green tick saves, X cancels. The settings icon is hidden while editing.
- **Delete** — for more than 500 clients, the confirm dialog replaces Cancel/Delete with a red progress bar while `DELETE /client-imports/:id/clients` runs in 500-client batches (`IMPORT_DELETE_CHUNK`); then the import record is deleted. For 500 or fewer the server handles it in one request.
- **Move to CRM** — disabled placeholder.

### Add client

The **Add client** dropdown offers **Form** (opens `AddClientDialog`) and **Imports** (opens `ClientImportModal`).

### Custom details editor

Each row is `key`, `value`, then one action button. Only the last row shows `+`; earlier rows show `X`. Clicking `+` appends a blank row and scrolls it (and the next `+`) into view. Blank keys are discarded on save. The add modal caps its body height so a long list of details never pushes its footer off-screen. The label reads **Custom details (Optional)**.

### Import wizard

`ClientImportModal` has four steps:

1. **Upload file** — `.xlsx`, `.xls` or `.csv`; the first row is read as column headings. Files with more than 500 data rows are rejected with “Cannot import more than 500 rows.”
2. **Match fields** — custom listbox dropdowns choose which columns hold name, email and phone. Name plus at least one contact column is required; common headings are pre-selected. Only Back and Next are shown on this step.
3. **Select fields** — pick remaining columns to keep as custom details. Only Back and Next are shown.
4. **Preview** — type an import name (required, not prefilled), then see the first five mapped rows before importing. Only Back and Import are shown.

Submitting first creates a `client_imports` record with the chosen name and file details, then splits valid rows into chunks by size with `chunkImportRows` and posts each chunk to `POST /clients/import` with that `importId`. A chunk holds up to 500 rows but closes early once its JSON reaches 512 KB, half of Fastify's 1 MB default body limit, because custom details have no size cap. A typical file goes in one request; a very wide one in a few (for example 30 columns of 50 characters: two). The progress bar advances per chunk. Each created client stores the same `import_id`. During the import the stepper becomes a progress bar; the submit button reads “Importing…”. The server counts rows with no name/contact or an invalid email as skipped and increments the import counters atomically. Both `CLIENTS_KEY` and `CLIENT_IMPORTS_KEY` are invalidated when all chunks finish.

### Mobile layout

Users and Clients share the same mobile pattern: the toolbar is a 52px sticky sub-header directly under the main header, holding the tab control and the active actions. Cards scroll in a bounded area with bottom padding so the last card clears the fixed pagination footer. The scrollbar is hidden.

---

## 6. What is not in this slice

- No wiring for the **CRM** button; it is a visual placeholder only.
- The **Imports** list is not paginated yet; it currently returns all summaries. The next slice should paginate it (e.g. 50/page) and add a lightweight options endpoint for the funnel filter if the list grows large.
- No links from CRM, sales, payments or invoices to clients yet — those modules are still empty states.
- No `action`-kind permission for creating or deleting clients; the `clients` menu grant currently covers all client endpoints.
- No duplicate detection on email or phone; two clients may share a contact method.
