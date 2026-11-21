# CRM: user deal assignment

Who owns each deal in a pipeline: the pipeline's **rule for new deals**, the **bulk tools** for existing deals, the **Access users** list that decides who can own deals, and the owner shown on every deal.

- **Status:** built 20–21 Nov 2026 (migration `20261120114702_wet_randall`, applied); the UI was simplified on 21 Nov to follow the reference; the manual checks in section 8 are pending
- **Code:** `src/crm/crm-assignment.{repository,service,controller}.ts`, the rule inside `CrmRepository.addExistingClients`; frontend `src/crm/components/assign/` and the owner on `KanbanCard` / `DealDetailsDrawer`
- **Tests:** `test/crm-assignment.e2e-spec.ts` (9 tests against the real database); see section 7 for what they cover
- **Reference:** the earlier ERP's `explorewings/docs/crm-deal-assignments.md` (WI-1). The behaviour carries over; the changes are listed in section 2.
- **Related:** [crm-plan.md](crm-plan.md) (Phase 2: Assignment), [access-model.md](access-model.md), [performance.md](performance.md)
- **Backend:** NestJS · Drizzle · PostgreSQL (Neon) with row-level security through `TenantDb.run()`
- **Frontend:** React · TanStack Query · the `card-3d` surface for cards (see `frontend/DESIGN.md`)

**Where it lives:** CRM › **Actions** › **Assign deals** card › the **Assign deals** drawer, with tabs **Access users** and **Deal assign**.

---

## 1. The model in one paragraph

Each pipeline has an **access list** (`crm_pipeline_users`) of the people who can work in it. A deal can have one **owner**, who must be on that same pipeline's access list; the database enforces this with a foreign key. The pipeline's **rule** (Creator, Manual, Round robin or Single user) picks the owner of deals added from now on. The **bulk tools** (Share, Give, per-person Unassign, Revert round robin) change the owners of existing deals whenever they're used, whatever the rule. **Transfer** moves a person's deals to someone else when they're removed from the access list. Every assignment records how it happened (`assignment_source`). The company **Owner** sees and acts on every deal, so is never an owner of one; only managers and staff can be.

```
crm_pipelines ──< crm_deals >── owner_id
      │                            │
      └──< crm_pipeline_users >────┘   (tenant_id, pipeline_id, owner_id)
           (who can work here)          must be a row here
```

---

## 2. Decisions

| # | Decision |
|---|---|
| D1 | **Rule ≠ tools.** The rule only decides who owns deals added from now on (Add deal form, Existing import, Import data, Move to CRM). Changing it never touches existing owners. The tools act on existing deals at any time. |
| D2 | **Four rules:** `creator` (default for every pipeline), `manual`, `round_robin`, `single_user`. |
| D3 | **Creator:** whoever adds the deal owns it, if eligible; otherwise it stays unassigned. A deal the Owner adds stays unassigned. **Manual:** new deals stay unassigned. |
| D4 | **Round robin:** the next eligible person in a stable order (user id), from a cursor stored on the pipeline (`round_robin_cursor`), shared by the rule and the Share tool, and reset to 0 when the rule switches to round robin. |
| D5 | **Single user:** every new deal goes to the pipeline's chosen person (`single_user_id`), who must be eligible when saved (400 otherwise). If they're later not eligible, new deals stay unassigned. If they're removed from the access list, the rule switches to `manual`. Choosing another rule clears the target. |
| D6 | **Eligible owner** = in the same company (RLS and per-company keys), **active**, holds the **`crm` grant**, is on **this pipeline's access list**, and is **not the Owner**. Every rule, tool and manual pick chooses only from eligible people; the access list is the one source. |
| D6a | **The pipeline's creator is put on its access list** when they create it, unless they're the Owner, so the manager who makes a pipeline can always see it and own its deals. The pipeline records who created it (`created_by`). |
| D7 | **Deactivated users, or users who lose the `crm` grant, keep their deals.** They can't sign in (or open the CRM), so there's no "No access" badge. They stop receiving new deals because they're no longer eligible. |
| D8 | **Assignment source** (`crm_deals.assignment_source`): `round_robin`, `single_user` or `creator` when the rule or a tool assigned it, `manual` when a person picked the owner in the deal drawer. It means something only while `owner_id` is set. |
| D9 | **Unassign per person, transfer on removal.** Each person's row in the Round robin and Single user lists has an **unassign icon** (an animated rotate-back icon). It opens a small menu, as in the reference: **Unassign ‹this card's method› deals** or **Unassign all deals**, each with its count, where an option is disabled when it would remove nothing or the same deals as the other. A confirmation follows. **Removing someone from Access users** who owns deals asks **Unassign them** or **Transfer to…** (another eligible person staying on the pipeline). **Transfer only changes the owner**: it has nothing to do with the assignment rules, never changes the pipeline's rule, and each deal keeps its source. The backend also has a per-person transfer endpoint with no UI for now. |
| D10 | **Bulk tools run 500 deals per request**, each request one SQL statement under the pipeline lock, looping until nothing remains, with progress (see [performance.md](performance.md)). |
| D11 | **Who can change things:** for now, the existing CRM `manage` check (Owner and managers, in pipelines they can see). Everyone with pipeline access can read the drawer. Fine-grained rights come later from System settings. |
| D12 | **Owner on deals:** each deal card and the deal drawer show the owner; the drawer lets a manager or Owner pick or clear it by hand (source `manual`). |
| D13 | **Not in this version:** an assignment history log (the reference's WI-1b); staff seeing only their own deals; a "don't assign to managers" filter. |

---

## 3. Data model

**`crm_pipelines`** gains:

| Column | Type | Notes |
|---|---|---|
| `assignment_rule` | `text not null default 'creator'` | check: one of the four rules |
| `single_user_id` | `uuid null` | the Single user target; foreign key below |
| `round_robin_cursor` | `integer not null default 0` | check `>= 0` |
| `created_by` | `uuid null` | who created it (users, `ON DELETE SET NULL`); null for pipelines made before this, and for the seeded default |

**`crm_deals`** gains:

| Column | Type | Notes |
|---|---|---|
| `owner_id` | `uuid null` | the deal's owner; null = unassigned |
| `assignment_source` | `text null` | check: null or one of the four; meaningful only while `owner_id` is set |

**`crm_pipeline_users`** gains a unique index on `(tenant_id, pipeline_id, user_id)`, the target for the foreign keys below.

**Foreign keys**
- `crm_deals (tenant_id, pipeline_id, owner_id) → crm_pipeline_users (tenant_id, pipeline_id, user_id) ON DELETE SET NULL (owner_id)`. An owner must be on that pipeline's access list. If the access row goes (removal, or the user being deleted, which cascades to it), the deal becomes unassigned instead of the delete failing. The app always offers Unassign or Transfer first (D9); this is the safety net. `SET NULL (column)` needs Postgres 15+ and is hand-written in the migration, like `clients.import_id`.
- `crm_pipelines (tenant_id, id, single_user_id) → crm_pipeline_users (tenant_id, pipeline_id, user_id) ON DELETE SET NULL (single_user_id)`. If the target loses access, the same statement that removes them also sets the rule to `manual` (D5).

**Indexes:** `crm_deals (pipeline_id, owner_id)` for per-user counts and tools; a partial index on `crm_deals (pipeline_id, created_at, id) WHERE owner_id IS NULL` for "oldest unassigned first".

**Migration:** generated with `pnpm db:generate`, with the two `SET NULL (column)` foreign keys hand-edited. Existing deals start unassigned, existing pipelines start on `creator`, and their `created_by` stays null (the creator was never recorded). Nothing to backfill.

---

## 4. Engine (`crm-assignment` service and repository)

Every write runs inside `TenantDb.run()`. Where order matters it takes the **pipeline row lock** (`FOR NO KEY UPDATE`, the same lock deal moves use), and wherever it can it does its work in **one statement**.

- **Eligible people** (`eligibleOwners`, one SQL fragment used everywhere, ordered by user id): pipeline access rows joined to users (`is_active`, `role <> 'owner'`) with the `crm` grant (`user_access` joined to `access_items.key = 'crm'`, active).
- **Picking owners for new deals:**
  - `creator`: the adder if eligible, else none
  - `manual`: none
  - `single_user`: the target if eligible, else none
  - `round_robin`: eligible[(cursor + i) mod count], then the cursor advances by the number of deals added

  No eligible people means the deals stay unassigned.
- **One place for new deals:** `CrmRepository.addExistingClients` computes each new deal's owner and source inside its insert statement, with the pipeline lock and the cursor update in the same statement. The Add deal form (`createDeal`), Existing import, Import data and Move to CRM all go through it.
- **Share** (round robin) / **Give** (single user): up to 500 of the oldest unassigned deals get owners in one statement under the pipeline lock. Round robin continues from the shared cursor and advances it. It returns `{ assigned, remaining, eligibleCount }`; a Give target who can't own deals gets 400.
- **Unassign:** up to 500 deals of one person (optionally only one source), or all deals of one source (Revert round robin is `source = round_robin` across everyone), locked with `FOR UPDATE`. Sets `owner_id` and `assignment_source` to null and returns `{ unassigned, remaining }`.
- **Transfer:** up to 500 deals of one person (optionally one source) move to another eligible person. Only `owner_id` changes; each deal keeps its `assignment_source`, and the rule is untouched. Returns `{ transferred, remaining }`. A target who isn't eligible gets 400.
- **Access list save:** people added must be able to use the CRM (active, with the `crm` grant, not the Owner). If anyone removed owns deals without a `handover`, it answers 409 with the counts. Otherwise it runs in three steps, in this order for the foreign keys:
  1. add the new people
  2. hand over the leavers' deals (unassign, or transfer to someone staying), and switch the rule to `manual` if the Single user target is leaving
  3. remove the leavers
- **Creating a pipeline:** records `created_by`, and adds the creator to the access list in the same transaction unless they're the Owner (alongside the people picked in the wizard).
- **Deleting a member:** any pipeline whose Single user target they were switches to `manual`. Their deals are unassigned by the owner foreign key when their access rows go.
- **Manual pick** (deal drawer): sets or clears one deal's owner. The new owner must be eligible. Source `manual`.

---

## 5. API (all under `/api/v1/crm`, behind `CrmPolicy`)

| Method | Path | Who | Body → response |
|---|---|---|---|
| `GET` | `/pipelines/:id/assignment` | pipeline viewers | → `{ rule, singleUserId, total, assigned, bySource, people: [{ userId, fullName, email, role, eligible, dealCount, bySource }], chunkSize: 500 }` (unassigned = total − assigned) |
| `PUT` | `/pipelines/:id/assignment-rule` | manage | `{ rule, singleUserId? }` → the overview. Rule only. |
| `POST` | `/pipelines/:id/assignments/share` | manage | `{ method: 'round_robin' \| 'single_user', userId? }` → `{ assigned, remaining, eligibleCount }`. Never reads or changes the rule. |
| `POST` | `/pipelines/:id/assignments/unassign` | manage | `{ userId?, source? }` (at least one) → `{ unassigned, remaining }` |
| `POST` | `/pipelines/:id/assignments/transfer` | manage | `{ fromUserId, toUserId, source? }` → `{ transferred, remaining }` (no UI yet) |
| `GET` | `/pipelines/:id/users` | manage | → `[{ userId, fullName, email, role, onList, eligible, dealCount }]` for everyone who could be on the list, plus anyone already on it |
| `PUT` | `/pipelines/:id/users` | manage | `{ userIds, handover?: { mode: 'unassign' \| 'transfer', toUserId? } }` → the new list. `handover` is required if a removed person owns deals: otherwise 409 with `owners: [{ userId, n }]`. |
| `PATCH` | `/deals/:id/owner` | manage | `{ ownerId: string \| null }` → the deal card |

The board, stage pages, search and deal endpoints add `ownerId`, `ownerName` and `assignmentSource` to every deal card.

---

## 6. Frontend

Code: `frontend/src/crm/components/assign/` (`AssignDealsDrawer`, `AccessUsersTab`, `DealAssignTab`, `rules.ts`), the shared runner `runInChunks` in `lib/crm.ts`, and the owner on `KanbanCard` and `DealDetailsDrawer`.

- **Entry point:** the **Assign deals** card in CRM › Actions opens the **Assign deals** drawer, a right-side sheet like the others. Its header holds the tabs **Access users** and **Deal assign**, the pipeline's name and close. The drawer can't be closed while a tool runs.
- **Access users tab:**
  - everyone who could be on the list (active, with CRM access, not the Owner), as raised `card-3d` rows: a tick, name, email, role and their deal count here
  - **Reset** and **Save access** in a footer pinned to the bottom of the drawer
  - saving when someone being removed owns deals opens "Their deals need a new home", naming them with their counts, with **Unassign them** and **Transfer to…** (a picker of eligible people staying)
- **Deal assign tab:**
  - tiles: **Total**, **Assigned**, **Unassigned**
  - four `card-3d` cards: **Round robin**, **Single user**, **Creator**, **Manual**. Each card's radio means "Use for new deals" and asks for confirmation ("Existing deals keep their owners."). The active rule's card is outlined in green and badged **New deals** (with the person's name for Single user).
  - **Round robin** and **Single user** fold open as cards, one at a time; a card stays open while one of its tools runs. **Creator** and **Manual** have no tools, so clicking their header picks the rule. Single user's radio, with nobody picked, opens that card to pick someone first.
  - **Round robin** card:
    - a folding list, "**Round robin rule for N users**", showing each person's round-robin deals as a green bar with the count and the unassign icon
    - **Share N unassigned** and **Revert round robin** (with a confirmation) under it
  - **Single user** card:
    - a folding list headed by the current target (initial, name, "Gets new deals") or "Choose a person", with "N people"
    - each person is a radio row with a green bar of their deals, the count, a small **New** tag on the target, and the unassign icon; clicking the picked person again unchecks them
    - picking someone shows a line about them, then **Assign N deals now** (Give) and **Use for new deals**
  - person lists open at least 10rem tall and scroll past 24rem. The unassign menu is drawn outside the list (positioned against the drawer), so scrolling lists never clip it.
- **Progress:** tools loop 500 per request with a progress bar in the card they were started from. An error shows in that card, and "Nobody here can receive deals right now" when nothing could be assigned.
- **Deal cards and the deal drawer:**
  - each card's bottom-left shows the owner's name (or "Unassigned") **in place of the "Added" date**, next to the View button; the added date stays in the deal drawer
  - in the drawer, an **Owner** row with a picker of eligible people and "Unassigned" (for people who can manage)
- **Read-only** for staff: the tabs show but every control is disabled, with a note that only the Owner and managers can change who owns deals.

---

## 7. Tests

**e2e against the real database** (`test/crm-assignment.e2e-spec.ts`). It builds a throwaway company: an Owner, a manager, staff a, b and c, staff n without the CRM grant, and a deactivated staff member i, all but the Owner on one pipeline.

| Test | What it proves |
|---|---|
| Eligibility | Only active people with CRM access on the list can own deals; never the Owner, n or i |
| Creator | The adder owns new deals; deals the Owner adds stay unassigned |
| Round robin on new deals | Two adds share 8 deals 2 each in user-id order, and the cursor wraps back to 0 |
| Single user | Every new deal goes to the target; an ineligible target is refused |
| Share and Give | Only unassigned deals are touched (9 shared as 3/2/2/2); Give refuses an ineligible person; the rule never changes |
| Unassign, Transfer, Revert | Transfer keeps each deal's source and the rule; Revert clears only round-robin deals; per-person unassign |
| Access list | Additions need CRM access; removing an owner of deals needs a handover; transfer moves them; removing the Single user target switches the rule to Manual |
| Manual pick and the foreign key | A hand-picked owner is `manual`; an ineligible pick is refused; the database refuses an owner who isn't on the list |
| Pipeline creator | A manager creating a pipeline is on its list with `created_by` set; the Owner isn't added |

**Unit tests:** the CRM service tests check that the Add deal form goes through the shared bulk-add statement, including reusing an existing client.

**Not covered yet:** deleting a member unassigning their deals (covered by the foreign key, but untested); a test that another company's people can't be added (RLS hides them, as the tenant-isolation suite shows for other tables); the frontend, which is typechecked but has no automated tests.

---

## 8. Acceptance criteria

- [ ] Choosing each rule asks for confirmation, persists after a reload, and changes only who gets **new** deals.
- [ ] Share 500 unassigned deals between 4 people: 125 each, with progress in the Round robin card; the rule doesn't change.
- [ ] Round robin the 500, then set Single user to one person: the 500 stay shared, and the next new deal goes to that person.
- [ ] A person's unassign icon offers this card's deals or all their deals; the counts in the menu and the confirmation match what's removed.
- [ ] Single user: pick someone, **Assign N deals now** gives them every unassigned deal without changing the rule; **Use for new deals** makes them the target; clicking the picked person again unchecks them.
- [ ] A manager who creates a pipeline is on its access list and can own its deals; the Owner creating one isn't added.
- [ ] Revert round robin clears only round-robin deals.
- [ ] Creator: a deal a manager or staff member adds is theirs; one the Owner adds stays unassigned. Manual: new deals stay unassigned.
- [ ] The Owner never appears as an owner option anywhere.
- [ ] Removing someone with deals from Access users offers Unassign and Transfer; Transfer keeps each deal's source and doesn't change the rule. Removing the Single user target switches the rule to Manual.
- [ ] A deactivated user keeps their deals and gets no new ones.
- [ ] The deal card and drawer show the owner; picking one in the drawer sets the source to manual.
- [ ] The drawer can't be closed while a tool runs, and confirming a rule inside it doesn't close it.
- [ ] Staff see the drawer read-only and get 403 from every write.
