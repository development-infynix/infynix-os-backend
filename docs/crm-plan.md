# CRM module plan

Port of the CRM from our earlier single-tenant ERP to Infynix OS (multi-tenant).

- **Status (23 Nov 2026):** Phases 1–3 built (Core, Assignment, Transfer). Left: manual run-throughs, the activity log and permissions. Details in **Phases** below.
- **Reference backend:** https://github.com/explorewings/erp-backend/tree/main/src/crm (schema: `src/schema/crm.ts`)
- **Reference frontend:** https://github.com/explorewings/erp-frontend/tree/main/src/crm
- **Related docs:**
  - [user-deals-assignment.md](user-deals-assignment.md): deal owners, rules, bulk tools and the access list
  - [clients-module.md](clients-module.md): clients, imports and the no-duplicates rule
  - [performance.md](performance.md): round-trip rules that every CRM query follows

The data model and behaviour carry over. Tenancy, access checks, the user and client models, and the frontend stack change, so this is a port, not a copy.

---

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

- **Kanban board:** drag deals between stages, cards loaded in pages per column, search by client name, email or phone.
- **Pipelines:** a wizard (name, stages, the users allowed in); deleting one after a confirmation showing what will be removed. Clients are never touched.
- **Stages:** add, rename, reorder, delete.
- **Deals:** add one by creating a new client (client and deal saved together), or bulk-add existing clients, skipping clients already in the pipeline.
- **Assignment:** rules per pipeline (round robin locks the pipeline row so concurrent deals don't get the same owner); bulk distribute and unassign with a history panel.
- **Transfer:** move or copy deals to another pipeline. Owners are cleared, then reassigned only if the target pipeline uses `round_robin` or `single_user`. Clients that already have a deal in the target are skipped and reported.

---

## Role mapping

| Reference | Infynix OS | In Infynix OS today |
|---|---|---|
| superadmin / superuser | **owner** | Sees every pipeline; never on an access list; never owns deals. Manages everything. |
| admin | **manager** | Manages pipelines, stages, access lists and deal assignment in pipelines they're on (the CRM `manage` check, until System settings gives per-role rights). Is put on the access list of any pipeline they create. |
| staff | **staff** | Works inside pipelines they're on; sees the Assign deals drawer read-only. |

Everyone with access to a pipeline sees all of its deals. Ownership affects who a deal is assigned to, not who can see it. Pipelines a person can't see return "not found", so their existence isn't revealed.

---

## Adapting to multi-tenancy (done)

1. **Tenant scoping:** every CRM table has `tenant_id`, row-level security with the `tenant_isolation` policy, and is reached through `TenantDb.run`. Cross-table links use per-company composite foreign keys, so a deal can't point at another company's stage, client or owner.
2. **IDs:** `uuid` everywhere.
3. **Access:** the reference's `menu:crm` and `MenuAccessGuard` became our access key `crm` with `@Can(CrmPolicy, 'use' | 'manage')`.
4. **Users:** `username` became `fullName`; `status = 'inactive'` became `isActive = false`.
5. **Clients:**
   - Validation uses our `normalizeContact` and `assertContact`.
   - One person, one client per company (same email or phone): the CRM's Add deal form reuses an existing client instead of copying it. See [clients-module.md](clients-module.md).
6. **Deletes:** deals go with their client (`ON DELETE CASCADE`); deleting an import deletes its clients and therefore their deals.
7. **Module wiring:** our auth and tenancy guards, with no separate `JwtModule`.

---

## Frontend

| Reference | Infynix OS |
|---|---|
| JavaScript (`.jsx`) | TypeScript |
| react-router | TanStack Router (`/_authed/crm` with `requireAccess('crm')`) |
| Hand-written fetch hooks | TanStack Query |
| Tailwind v3 | Tailwind v4 with `tokens.css` and the cream theme in `frontend/DESIGN.md` (handled cards use the `card-3d` raised surface) |
| react-icons | lucide (plus `@animateicons/react` for the animated unassign icon) |
| `@dnd-kit` | `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` |

The structure follows the reference: pipeline selector, board, deal details drawer, create-pipeline wizard, manage pipelines and manage stages drawers, Assign deals drawer (Access users and Deal assign tabs), search modal. Still to come: the history panel and the transfer drawer.

---

## Phases

### Phase 1: Core (built)

Built:
- [x] Schema and migrations for pipelines, stages, access list and deals, with RLS.
- [x] Pipelines: list, create with the wizard (the creator goes on the access list unless they're the Owner), rename, delete with the impact count. A default "Sales" pipeline is created the first time a company opens the CRM.
- [x] Stages: add, rename, reorder, delete (only empty stages can be deleted).
- [x] Access list: set in the wizard, edited in Assign deals › Access users.
- [x] **Board:**
  - 100 cards per column, then 100 more as you scroll (infinite scroll), with the stage's true total in the header
  - drag to move or reorder with an optimistic save; moves in one pipeline queue under a row lock so two quick moves can't undo each other
  - search in its own modal (server-side, debounced, this pipeline only)
  - **Select mode:** tick cards, then the Select button's menu offers **Move to pipeline**, **Add to pipeline** (Owner and managers) and **Delete** (with a confirmation; `POST /crm/deals/delete`, 500 per request, only deals in pipelines you can see)
  - **Card options** (the settings icon on each card): a floating menu with **Add to pipeline**, **Move to pipeline** (Owner and managers) and **Delete** (`DELETE /crm/deals/:id`, with a confirmation)
- [x] **Deals:**
  - created from the Add deal menu:
    - **Form:** one new client, or the existing client with that email or phone
    - **Existing import:** tick whole imports, choose the stage
    - **Import data:** the Excel import, then its clients go into a chosen stage
  - bulk-added from the Clients page with **Move to CRM**, either from a selection or from an import card's menu
  - all of these use one bulk-add statement: 500 clients per request, retry from a failed chunk, clients already in the pipeline skipped
  - the two import options need the `clients` grant as well as `crm`
- [x] **Deal details drawer:** the header holds only the **Details / History** tabs and close (the client's name is in the panel below). Panels in order: **Client** (name, email, phone), **Deal** (stage, pipeline, owner, added date) and **Custom details**. The Owner and managers change the owner with the app's standard dropdown (button and list, not the browser select); Escape closes the list, not the drawer. The History tab is a placeholder until Phase 2's log exists.
- [x] **Performance:** the board, the pipeline list and every bulk action follow [performance.md](performance.md). Opening the CRM went from about 4 s to about 1 s from a developer machine.

Still to do:
- [x] **Delete confirmations mention deals:** deleting a client (one or a selection) or an import says their deals in every CRM pipeline go too.
- [x] **Fixes from the 23 Nov review:**
  - stage delete takes the pipeline lock before checking the stage is empty, and maps a late foreign-key clash to the friendly 409, never a 500
  - the board drops selected cards that vanished after a refresh, so Move / Add / Delete never send deals someone else moved

### Phase 2: Assignment (built 20–21 Nov 2026)

See [user-deals-assignment.md](user-deals-assignment.md).

- [x] The four rules for new deals (Creator by default, Manual, Round robin, Single user), applied inside the bulk-add statement with the round-robin cursor under the pipeline lock.
- [x] **Eligible owners:** active people with the `crm` grant on the pipeline's access list, never the Owner. Deactivated people keep their deals but get no new ones.
- [x] **Bulk tools, 500 deals per one-statement request with progress:**
  - **Share** (round robin) and **Give** (single user)
  - per-person **Unassign**: this card's deals, or all of theirs
  - **Revert round robin**
- [x] **Access users:** removing someone who owns deals asks **Unassign** or **Transfer to…** someone staying; removing the Single user target switches the rule to Manual.
- [x] **Owner on deals:** shown on each card (in place of the added date), and picked by hand in the deal drawer (source `manual`).
- [x] **Tests:** 9 e2e tests against the real database cover the rules, tools, handover, eligibility and the owner foreign key.
- [ ] Manual run-through of the checklist in section 8 of user-deals-assignment.md.
- [ ] `crm_pipeline_activity` table and the history panel (deal assignment history, and the deal drawer's History tab).

### Phase 3: Transfer (built 21 Nov 2026)

See [deal-transfer.md](deal-transfer.md).

- [x] **Move** and **Add** (copy) deals to another pipeline through one endpoint, 500 per request, with skipped clients named. Owners follow the reference: cleared, then reassigned only if the target uses Round robin or Single user.
- [x] **Three ways in**, all the same drawer:
  - the **Deal transfer** card in Actions (a menu card: Add / Move), by whole stages: **Stages · Destination**
  - the board's **Select** menu, for the ticked cards
  - a card's **options** menu, for that one deal
  The last two open straight at Destination.
- [x] A strip above the footer says what the target's assignment rule will do to owners.
- [x] **Tests:** 8 e2e tests (Move, Add, owners by rule, errors, a 500-deal chunk, and bulk delete).
- [ ] Manual run-through of section 8 of deal-transfer.md.

### Not yet planned

- The **Payment actions** and **Qualification actions** cards in Actions are placeholders.

---

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Manager powers | Managers manage pipelines, stages, access lists and assignment in pipelines they're on (the CRM `manage` check). Per-role rights come later from System settings. |
| 2 | Staff visibility | Staff see every deal in their pipelines, as in the reference. "Only my deals" may come later. |
| 3 | Client activity log | Not built. To revisit with Phase 2's activity table. |
| 4 | IDs | `uuid`, done. |
| 5 | Duplicate clients | One client per email or phone per company (database-enforced); the same person may be a client of other companies. |
| 6 | Bulk chunk size | 500 per request for every CRM and clients bulk action; Excel import chunks are also capped at 512 KB. |
