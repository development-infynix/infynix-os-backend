# CRM module plan

Port of the CRM from our earlier single-tenant ERP to Infynix OS (multi-tenant).

- Reference backend: https://github.com/explorewings/erp-backend/tree/main/src/crm (schema: `src/schema/crm.ts`)
- Reference frontend: https://github.com/explorewings/erp-frontend/tree/main/src/crm

The data model and behaviour carry over. Tenancy, access checks, the user and client models, and the frontend stack change, so this is a port, not a copy (about 2,600 backend and 7,300 frontend lines to rewrite).

## What the reference does

### Data

| Table | Purpose |
|---|---|
| `crm_pipelines` | Name, sort position, creator, deal assignment rule (`creator`, `manual`, `single_user`, `round_robin`), round-robin cursor, single-user target. |
| `crm_pipeline_stages` | Ordered stages per pipeline; names unique per pipeline (case-insensitive). |
| `crm_pipeline_users` | Access list: which users can work in which pipeline. |
| `crm_deals` | One deal per client per pipeline, in one stage, with an optional owner. The owner must be on the pipeline's access list (composite foreign key). Records how the owner was assigned. |
| `crm_pipeline_activity` | History of rule changes, assignments, unassignments and access changes; the actor's name is copied in so it survives renames and deletes. |

### Features

- Kanban board: drag deals between stages, 25 cards per column loaded in pages, search by client name, email or phone.
- Pipeline wizard: name, stages, and the users allowed in.
- Manage stages: add, rename, reorder, delete.
- Delete a pipeline after a confirmation showing what will be removed. Clients are never touched.
- Add a deal by creating a new client (client and deal saved together), or bulk-add existing clients to the first stage, skipping clients already in the pipeline.
- Assignment rules per pipeline; round robin locks the pipeline row so concurrent deals don't get the same owner.
- Bulk distribute or unassign deals in chunks of 100, with a history panel.
- Transfer deals to another pipeline (move or copy). Owners are cleared, then reassigned only if the target pipeline uses `round_robin` or `single_user`. Clients that already have a deal in the target are skipped and reported.

### Endpoints

- `crm/pipelines`: list, create, rename, delete-impact, delete; access list (list, preview, save); stages (create, reorder, rename, delete).
- `crm`: eligible users, deals list, board, next page of a stage, deal ids for whole stages, eligible assignees, create deal, bulk-add existing clients, transfer, move deal, delete deal, assign deal.
- `crm/pipelines/:id`: assignment overview, activity feed, update rule, distribute, unassign.

## Role mapping

| Reference | Infynix OS | Reference behaviour |
|---|---|---|
| superadmin / superuser | **owner** | Sees every pipeline; never on an access list. Only this role manages pipeline access, assignment rules, distribute, unassign and transfer. |
| admin | **manager** | Can rename or delete a pipeline they are on the access list for. |
| staff | **staff** | Works inside pipelines they are on; can never rename or delete them. |

Everyone with access to a pipeline sees all of its deals. Ownership affects assignment counts, not visibility. Pipelines a user cannot see return "not found", so their existence isn't revealed.

## Adapting to multi-tenancy

1. **Tenant scoping:** all five tables get `tenant_id`, row-level security with the `tenant_isolation` policy, and run through `TenantDb.run`, like `clients`. Per-company scoping of queries such as `MAX(position)` then comes from RLS.
2. **IDs:** `uuid` in place of sequential numbers, matching our other tables and not revealing record counts.
3. **Access:** the reference's `menu:crm` and `MenuAccessGuard` become our access key `crm` with `@Can`. Eligible users are active people in the company with `crm` access, excluding the owner.
4. **Users:** `username` becomes `fullName`; `status = 'inactive'` becomes `isActive = false`.
5. **Clients:**
   - The reference logs client activity and stores `source` and `createdBy` on clients; we have none of these (see open decision 3).
   - Client validation uses our `normalizeContact` and `assertContact`.
6. **Deletes:** deals are deleted with their client (`ON DELETE CASCADE`). Deleting an import deletes its clients and therefore their deals, so the import delete confirmation should mention deals.
7. **Move to CRM:** the unwired button on the Clients page maps to the bulk "add existing clients" endpoint.
8. **Module wiring:** drop the reference's own `JwtModule` registration; use our auth and tenancy guards.

## Frontend

| Reference | Infynix OS |
|---|---|
| JavaScript (`.jsx`) | TypeScript |
| react-router | TanStack Router (`/_authed/crm` already exists with `requireAccess('crm')`) |
| Hand-written fetch hooks | TanStack Query, Form and Table |
| Tailwind v3 | Tailwind v4 with `tokens.css` and the cream theme in `DESIGN.md` |
| react-icons | lucide |
| `@dnd-kit` | add `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` |

Replace the current `CrmEmpty` page. Keep the reference's structure: pipeline selector, board, deal details drawer, create-pipeline wizard, manage-stage drawer, assign-users drawer, deal-assign panel, history panel, transfer drawer, search modal. Follow our table plus mobile-card pattern for the list views.

## Phases

### Phase 1: Core

- Schema and migration for pipelines, stages, access list and deals, with RLS.
- Pipelines: list, create with wizard, rename, delete with impact count.
- Stages: add, rename, reorder, delete.
- Access list per pipeline.
- Board: paged per stage, search, drag to move.
- Deals: create with a new client, bulk-add existing clients, delete.
- Add deal menu on the board (built 20 Nov 2026): **Form** (one new client as a deal), **Existing import** (tick whole imports; their clients become deals in a chosen stage) and **Import data** (the Clients page's Excel import, then its new clients become deals in a chosen stage). The two import options need the `clients` grant as well as `crm`; without it the button opens the form directly. All three reuse the bulk add (500 per request, retry from the failed chunk, already-in-pipeline skipped).
- Wire "Move to CRM" on the Clients page.
- Import delete confirmation mentions deals.

### Phase 2: Assignment

- The four assignment rules, with the round-robin cursor locked during creation.
- Assign one deal; bulk distribute and unassign in chunks of 500, each chunk one statement (see [performance.md](performance.md)).
- `crm_pipeline_activity` table and history panel.

### Phase 3: Transfer

- Move or copy deals between pipelines, chunked, with skipped deals reported.

## Open decisions

1. **Manager powers:** can a manager manage pipeline access, assignment rules and transfers in their own pipelines, or is that owner-only as in the reference?
2. **Staff visibility:** do staff see every deal in their pipelines (reference), or only deals assigned to them?
3. **Client activity log:** skip it for now, or build it as part of CRM?
4. **IDs:** confirm `uuid` in place of the reference's sequential numbers.
