# CRM: user deal assignment

Who owns each deal in a pipeline: the pipeline's **rule for new deals**, the **bulk tools** for existing deals, the **Access users** list that decides who can own deals, and the owner shown on every deal.

- **Status:** built 20 Nov 2026 (migration `20261120114702_wet_randall`, applied); manual checks in section 8 pending
- **Code:** `src/crm/crm-assignment.{repository,service,controller}.ts`, the rule inside `CrmRepository.addExistingClients`; frontend `src/crm/components/assign/` and the owner on `KanbanCard` / `DealDetailsDrawer`
- **Tests:** `test/crm-assignment.e2e-spec.ts` (9 tests against the real database)
- **Reference:** the earlier ERP's `explorewings/docs/crm-deal-assignments.md` (WI-1). The behaviour carries over; the changes are listed in section 2.
- **Related:** [crm-plan.md](crm-plan.md) (Phase 2: Assignment), [access-model.md](access-model.md), [performance.md](performance.md)
- **Backend:** NestJS · Drizzle · PostgreSQL (Neon) with row-level security through `TenantDb.run()`
- **Frontend:** React · TanStack Query · the `card-3d` surface for cards (see `frontend/DESIGN.md`)

**Where it lives:** CRM › **Actions** › **Assign deals** card › the **Assign deals** drawer, with tabs **Access users** and **Deal assign**.

---

## 1. The model in one paragraph

Each pipeline has an **access list** (`crm_pipeline_users`) of the people who can work in it. A deal can have one **owner**, who must be on that same pipeline's access list; the database enforces this with a foreign key. The pipeline's **rule** (Creator, Manual, Round robin or Single user) picks the owner of deals added from now on. The **bulk tools** (Share, Give, Unassign, Transfer, Revert round robin) change the owners of existing deals whenever they're used, whatever the rule. Every assignment records how it happened (`assignment_source`). The company **Owner** sees and acts on every deal, so is never an owner of one; only managers and staff can be.

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
| D9 | **Unassign or transfer.** Wherever deals would lose their owner (the per-user **Unassign** tool, or removing someone from the access list), the confirmation has two buttons: **Unassign** (the deals become unassigned) and **Transfer** (they move to another eligible person on the same pipeline). **Transfer only changes the owner**: it has nothing to do with the assignment rules, never changes the pipeline's rule, and each deal keeps its source. |
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

Every write runs inside `TenantDb.run()`, takes the **pipeline row lock** (`lockPipeline`, the same lock deal moves use), then does its work in **one statement**.

- **Eligible people** (one query, ordered by user id): pipeline access rows joined to users (`is_active`, `role <> 'owner'`) and the `crm` grant (`user_access` joined to `access_items.key = 'crm'`, active).
- **Picking owners for n new deals:**
  - `creator`: the adder if eligible, else none
  - `manual`: none
  - `single_user`: the target if eligible, else none
  - `round_robin`: eligible[(cursor + i) mod count], then the cursor advances by n

  No eligible people means the deals stay unassigned.
- **Hooked into existing writes:**
  - `createDeal` (the Add deal form)
  - `addExistingClients` (Existing import, Import data, Move to CRM): the owner and source are computed inside the same insert statement, with the cursor updated in it
- **Share** (round robin) / **Give** (single user): up to 500 of the oldest unassigned deals get owners in one `UPDATE … FROM (numbered deals × eligible list)`, which returns `{ assigned, remaining }`.
- **Unassign:** up to 500 deals of one person (optionally only one source), or all deals of one source (Revert round robin, which is `source = round_robin` across everyone). Sets `owner_id` and `assignment_source` to null and returns `{ unassigned, remaining }`.
- **Transfer:** up to 500 deals of one person (optionally one source) move to another eligible person. Only `owner_id` changes; each deal keeps its `assignment_source`, and the rule is untouched. Returns `{ transferred, remaining }`. A target who isn't eligible gets 400.
- **Creating a pipeline:** records `created_by`, and adds the creator to the access list in the same transaction unless they're the Owner (alongside the people picked in the wizard).
- **Access list save:** one statement replaces the list. Before removing anyone who owns deals, it unassigns or transfers their deals according to the request's `handover`, and switches the rule to `manual` if the Single user target is removed. People added must be eligible apart from the list itself (active, with the `crm` grant, not the Owner).
- **Manual pick** (deal drawer): sets or clears one deal's owner. The new owner must be eligible. Source `manual`.

---

## 5. API (all under `/api/v1/crm`, behind `CrmPolicy`)

| Method | Path | Who | Body → response |
|---|---|---|---|
| `GET` | `/pipelines/:id/assignment` | pipeline viewers | → `{ rule, singleUserId, total, assigned, unassigned, bySource: { round_robin, single_user, creator, manual }, people: [{ userId, fullName, role, eligible, dealCount, bySource }], chunkSize: 500 }` |
| `PUT` | `/pipelines/:id/assignment-rule` | manage | `{ rule, singleUserId? }` → the overview. Rule only. |
| `POST` | `/pipelines/:id/assignments/share` | manage | `{ method: 'round_robin' \| 'single_user', userId? }` → `{ assigned, remaining }`. Never reads or changes the rule. |
| `POST` | `/pipelines/:id/assignments/unassign` | manage | `{ userId?, source? }` (at least one) → `{ unassigned, remaining }` |
| `POST` | `/pipelines/:id/assignments/transfer` | manage | `{ fromUserId, toUserId, source? }` → `{ transferred, remaining }` |
| `GET` | `/pipelines/:id/users` | manage | → `[{ userId, fullName, email, role, onList, eligible, dealCount }]` for everyone who could be on the list |
| `PUT` | `/pipelines/:id/users` | manage | `{ userIds, handover?: { mode: 'unassign' \| 'transfer', toUserId? } }` → the new list. `handover` is required if a removed person owns deals (409 with the counts otherwise, so the UI can ask). |
| `PATCH` | `/deals/:id/owner` | manage | `{ ownerId: string \| null }` → the deal card |

The board and the deal endpoints add `ownerId`, `ownerName` and `assignmentSource` to every deal card.

---

## 6. Frontend

- **Entry point:** the **Assign deals** card in CRM › Actions opens the **Assign deals** drawer, a right-side sheet like the others. Its header has the tabs **Access users** and **Deal assign**, plus close. Closing is blocked while a tool is running.
- **Access users tab:**
  - the people who can be on the list (active, with CRM access, not the Owner), with a tick for whether they're on this pipeline and their deal count here
  - **Save**: if anyone being removed owns deals, a confirmation names them and the total, with **Unassign** and **Transfer to…** (a picker of the people staying)
- **Deal assign tab:**
  - tiles: **Total**, **Assigned**, **Unassigned**
  - then four `card-3d` cards: **Round robin**, **Single user**, **Creator**, **Manual**
  - each card's radio means "Use for new deals", with a confirmation ("Existing deals keep their owners."). The active rule's card is outlined and badged **New deals**.
  - **Round robin** card: each person's round-robin count with a bar and **Unassign / Transfer**, then **Share N unassigned deals**, then **Revert round robin**
  - **Single user** card: pick a person, then **Give N unassigned deals to X** and **Use for new deals**; each person's deal count with **Unassign / Transfer**
  - **Creator** and **Manual** cards: a description only
- **Progress:** tools loop 500 per request with a progress bar where they were started, then a short result line.
- **Deal cards and the deal drawer:**
  - each card's bottom-left shows the owner's name (or "Unassigned") **in place of the "Added" date**, next to the View button; the added date stays in the deal drawer
  - in the drawer, an **Owner** row with a picker of eligible people and "Unassigned" (for people who can manage)
- **Read-only** for staff: the tabs show but every control is disabled.

---

## 7. Tests

- **Unit:** rule picking for each rule; the eligibility filter (inactive, no `crm` grant, the Owner, not on the list); the round-robin cursor wrapping; and the handover choice when the list is saved.
- **e2e against the database** (throwaway company, like `test/crm-move.e2e-spec.ts`):
  - Share 1,200 unassigned between 4 people: 3 requests, 300 each, cursor at 0
  - Creator, Single user and Round robin on bulk add
  - a manual pick
  - Unassign and Transfer by person and by source, with Transfer keeping each deal's source and the rule
  - a manager creating a pipeline ends up on its access list (the Owner doesn't)
  - Revert round robin
  - removing a person with each handover, including the Single user target switching the rule to Manual
  - the foreign key refusing an owner who isn't on the list
  - deleting a user unassigning their deals
  - another company's pipeline and people not being reachable

---

## 8. Acceptance criteria

- [ ] Choosing each rule asks for confirmation, persists after a reload, and changes only who gets **new** deals.
- [ ] Share 500 unassigned deals between 4 people: 125 each, with progress; the rule doesn't change.
- [ ] Round robin the 500, then set Single user to one person: the 500 stay shared, and the next new deal goes to that person.
- [ ] Unassign and Transfer for one person: by method or all of their deals; the counts in the confirmation match what moves. Transfer keeps each deal's source and doesn't change the rule.
- [ ] A manager who creates a pipeline is on its access list and can own its deals; the Owner creating one isn't added.
- [ ] Revert round robin clears only round-robin deals.
- [ ] Creator: a deal a manager or staff member adds is theirs; one the Owner adds stays unassigned. Manual: new deals stay unassigned.
- [ ] The Owner never appears as an owner option anywhere.
- [ ] Removing someone with deals from Access users offers Unassign and Transfer. Removing the Single user target switches the rule to Manual.
- [ ] A deactivated user keeps their deals and gets no new ones.
- [ ] The deal card and drawer show the owner; picking one in the drawer sets the source to manual.
- [ ] The drawer can't be closed while a tool runs.
- [ ] Staff see the drawer read-only and get 403 from every write.
