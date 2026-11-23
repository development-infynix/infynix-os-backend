# CRM: deal transfer

Moving deals to another pipeline, or adding them to another pipeline as well, by choosing whole stages. Phase 3 of [crm-plan.md](crm-plan.md).

- **Status:** **built 21 Nov 2026**: Move and Add to pipeline, from the Actions card, the board's Select menu and each card's options menu; plus bulk delete for Select. The manual checks in section 8 are pending.
- **Code:** backend `src/crm/crm-transfer.{repository,service,controller}.ts` and `dto/crm-transfer.dto.ts`; frontend `src/crm/components/DealTransferDrawer.tsx` and the shared `PipelineOption` picker
- **Tests:** `test/crm-transfer.e2e-spec.ts` (8 tests against the real database: deal ids beyond 100, Move order and positions, landing stage and duplicates, owners by target rule with the cursor, Add leaving the source and creating new deals, the error cases, a 500-deal chunk, bulk delete limited to visible pipelines)
- **Reference:** the earlier ERP's `explorewings/docs/crm-deal-transfer.md` (WI-2 Move, WI-3 Add) and its code: `erpnestbackend/src/crm/crm-deals.service.ts` (`transferDeals`, `listDealIdsByStages`) and `erpfrontend/src/crm/components/deal-transfer-drawer.jsx`. The behaviour carries over; the changes are in section 2.
- **Related:**
  - [user-deals-assignment.md](user-deals-assignment.md): owners, rules and eligibility, which this reuses
  - [performance.md](performance.md): one statement per chunk, 500 per request
- **Backend:** NestJS · Drizzle · PostgreSQL (Neon) with row-level security through `TenantDb.run()`
- **Frontend:** React · TanStack Query · the drawer shell and `card-3d` rows (see `frontend/DESIGN.md`)

**Where it lives:** CRM › **Actions** › **Deal transfer** card. The card is a menu, like Manage pipeline: **Add to pipeline** or **Move to pipeline** opens the drawer for that action.

---

## 1. The model in one paragraph

**Move** re-points existing deals to another pipeline and a landing stage there; the source pipeline loses them. **Add to another pipeline** leaves the source deals untouched and creates a **new** deal for each client in the target. Deals are chosen by **whole stages** of the current pipeline: every deal in them, not only the cards loaded on the board. A client already in the target is **skipped and reported**, because a client has at most one deal per pipeline. Owners don't travel: they're cleared, and only a target pipeline using **Round robin** or **Single user** gives the deals owners again. The work runs 500 deals per request, each request one SQL statement, with progress.

---

## 2. Decisions

| # | Decision |
|---|---|
| T1 | **Move** = the same deal row gets the target pipeline and landing stage; the source loses it. `created_by` and `created_at` stay. |
| T2 | **Add to another pipeline** = a **new** deal row for the same client in the target, with `created_by` = whoever does it; the source deal is untouched. The UI never says "copy" (the API's mode is `copy`). |
| T3 | **Landing stage:** chosen in the target pipeline; default = its first stage. A stage from another pipeline is 400. A target with no stages is 400. |
| T4 | **Selection by stage:** the user ticks stages of the current pipeline. **Every** deal in them is transferred, including those beyond the 100 per column loaded on the board. Stage counts come from the board (its true totals); the deal ids come from a dedicated endpoint at submit time. "Select by fields" shows as **Coming soon**. |
| T5 | **Owners on arrival** *(confirmed: as in the reference)*: cleared. A target on **Round robin** or **Single user** assigns them again, through the same eligibility check and round-robin cursor as everything else. A target on **Creator** or **Manual** leaves them **unassigned**: the person transferring doesn't become the owner. `assignment_source` = the target's rule when an owner is set, otherwise null. The result says how many were left unassigned. |
| T6 | **Duplicates:** a client already in the target is skipped and named in the result; the rest of the chunk goes through. A duplicate that slips in concurrently is skipped by the unique key, never an error. |
| T7 | **One source, another target:** all deals in a request must come from one pipeline (400 otherwise); the target must differ from it (400 otherwise). Both must be visible to the person (404 otherwise, so nothing leaks). |
| T8 | **Who can transfer** *(for now)*: the existing CRM `manage` check (Owner and managers, in pipelines they can see: both source and target). Permissions for every CRM action will be set from System settings later. |
| T9 | **500 deals per request**, each request one statement under the locks below, looping until done, with progress (see [performance.md](performance.md)). |
| T10 | **Positions:** moved or added deals go to the end of the landing stage, in their source order (source stage, then their position there). Gaps left in the source stages are harmless: order is by position, and the next drag renumbers that stage. |
| T11 | **Scope (confirmed):** the Deal transfer drawer, by stage. Not in this version: single-deal transfer from a card (with owner options), the board's **Select** toolbar actions, the card menu items, and the client activity log (we don't have one). |
| T12 | **The action is chosen on the card (confirmed 21 Nov):** the Deal transfer card is a menu card, like Manage pipeline, with **Add to pipeline** and **Move to pipeline**. Each opens the drawer set to that action, titled with it. Retargeting (a third option in the original idea) isn't wanted. The reference's "How to select deals" step (By stage / By fields) is dropped (23 Nov): the drawer opens on the stages. Move was built first, then Add, on the same endpoint and drawer. |

---

## 3. Data model

**No schema change.** Transfer uses existing columns: `crm_deals.pipeline_id`, `stage_id`, `position`, `owner_id`, `assignment_source` and `created_by`. The per-company foreign keys already guarantee, inside the same statement:
- the landing stage belongs to the target pipeline: `(tenant_id, pipeline_id, stage_id)` → stages
- any owner is on the target's access list: `(tenant_id, pipeline_id, owner_id)` → `crm_pipeline_users`
- one deal per client per pipeline: the unique key `(tenant_id, pipeline_id, client_id)`

---

## 4. Engine (`crm-transfer` service and repository)

Every request runs inside `TenantDb.run()`.

- **Deal ids by stage** (`dealIdsByStages`): the ids of every deal in the chosen stages of one pipeline, in source order (stage position, then deal position, then id). One query.
- **Transfer one chunk** (`transfer`): one statement doing all of the following.
  1. **Lock**, in a fixed order so two transfers can't deadlock:
     - both pipelines, ascending by id (`FOR NO KEY UPDATE`, the same lock deal moves and bulk adds take)
     - then the chunk's deals (`FOR UPDATE`)
  2. **Check** that every deal is from one source pipeline, that the target differs, and that the landing stage belongs to the target (default: its first stage). Deals that no longer exist are counted as missing.
  3. **Skip** deals whose client already has a deal in the target, returning their client names.
  4. **Pick owners** for the rest only if the target uses Round robin or Single user, using `eligibleOwners` (the shared definition from deal assignment). Round robin continues from the target's cursor and advances it, exactly like the bulk add.
  5. **Write:**
     - **Move:** one `UPDATE … FROM` setting pipeline, stage, position (end of the landing stage), owner and source.
     - **Add:** one `INSERT … SELECT` of new deals for the same clients, with `created_by` = the person, the same owners and positions, and `ON CONFLICT DO NOTHING`.
  6. **Return** `{ moved | added, unassigned, missing, skipped: [{ dealId, clientName }] }`.
- **Reuse:** Add is close to the existing `CrmRepository.addExistingClients` (it takes client ids, skips clients already there, appends positions and applies the rule). The difference is the owner policy (T5: Creator doesn't assign). It either takes an `ownerPolicy: 'rule' | 'transfer'` option or shares its SQL pieces with the new statement, whichever keeps both readable.

---

## 5. API (all under `/api/v1/crm`, behind `CrmPolicy`)

| Method | Path | Who | Body → response |
|---|---|---|---|
| `GET` | `/pipelines/:id/deal-ids?stageIds=a,b` | pipeline viewers | → `{ ids }`: every deal in those stages, in source order. 1–100 stage ids; a stage of another pipeline is ignored; an invisible pipeline is 404. |
| `POST` | `/deals/delete` | pipeline viewers (`use`) | `{ dealIds (1–500, unique uuids) }` → `{ deleted, missing }`. One statement; only deals in pipelines the person can see are deleted, the rest count as missing. Used by the board's Select › Delete. A single card's Delete uses the existing `DELETE /deals/:id`. |
| `POST` | `/deals/transfer` | manage | `{ mode: 'move' \| 'copy', dealIds (1–500, unique uuids), targetPipelineId, targetStageId? }` → `{ mode, moved?, added?, unassigned, missing, skipped: [{ dealId, clientName }] }` (`moved` for Move, `added` for Add) |

Errors: mixed source pipelines, the same pipeline as target, or a landing stage outside the target are 400; an invisible source or target is 404; a staff member is 403.

After a transfer, the board, the pipeline list and the assignment overview are refetched.

---

## 6. Frontend

- **Entry points**, all opening the same `DealTransferDrawer`; Add and Move appear only for the Owner and managers (T8):
  - **Actions › Deal transfer:** a menu card (the shared `MenuCard`, also used by Manage pipeline) with **Add to pipeline** and **Move to pipeline**. Deals are chosen by whole stages, through both steps.
  - **Board › Select:** the Select button's menu offers **Move to pipeline**, **Add to pipeline** and **Delete** for the ticked cards. Move and Add pass those deal ids (`dealIds` prop): the drawer opens at Destination with no steps strip, and select mode ends when the run finishes.
  - **Card options:** the settings icon on each card opens a floating menu (`DealOptionsMenu`, portaled so the scrolling column can't clip it) with **Add to pipeline**, **Move to pipeline** and **Delete** for that one deal. Add and Move open the drawer at Destination like Select.
- **The drawer** opens set to the chosen action, a right-side sheet like the others. It can't be closed while running.
  - **Header:** **Add to pipeline** or **Move to pipeline** (with its icon), the source pipeline's name, and close.
  - **Steps strip:** **Stages · Destination**, with done steps ticked and the current one in green. (Selecting **By fields** was dropped on 23 Nov; deals are chosen by stage only.)
  - **Step 1, "Choose stages":** a raised row per stage with its deal count (the true total, not just loaded cards), and **Clear**. Empty stages are disabled.
  - **Step 2, "Destination":**
    - a line that follows the action ("The deals leave ‹source›…" or "The deals stay in ‹source›; new deals for the same clients go to…")
    - the other pipelines as radio rows; the chosen one folds open to **Land in stage**, a radio list of its stages with the first preselected (the shared `PipelineOption` picker)
  - **Owner notice:** once a target is picked, a strip above the footer reads the target's assignment rule live: Round robin ("shared in turn between N people"), Single user ("every deal will go to ‹person›"), or Creator / Manual / nobody eligible ("will arrive unassigned"). Move adds "Their current owners are reset."
  - **Footer:** "N deals selected" on the left; **Cancel** / **Back**, then **Next**, then **Add N deals** or **Move N deals** on the right.
- **Running:** fetches the ids for the chosen stages, then sends 500 per request with a progress bar, "Moving / Adding X of Y deals…". A failure shows "Stopped after N deals", the error and **Try again** (which carries on from the failed chunk).
- **Result:** the success panel, "Moved N deals" ("Now in ‹target› › ‹stage›") or "Added N deals" ("Added to …"), then notes:
  - owners: "Owners were reset, so these deals are unassigned." (Move) or "The new deals are unassigned." (Add), or how many when the target's rule assigned some
  - skipped because already in the target, with names
  - no longer existed

  Then **Done**.

---

## 7. Tests

**e2e against the real database** (a throwaway company, like `test/crm-assignment.e2e-spec.ts`):
- **Move:** deals leave the source and appear in the target's landing stage, at the end, in source order; `created_by` is kept.
- **Add:** source deals untouched; new deals in the target with `created_by` = the person.
- **Stage selection:** `deal-ids` returns every deal in the chosen stages, including more than 100 in one stage.
- **Duplicates:** a client already in the target is skipped and named; the rest go through.
- **Owners:**
  - Round robin and Single user targets assign through the target's eligibility, and the cursor advances
  - Creator and Manual targets leave deals unassigned and count them
- **Errors:** mixed source pipelines, the same pipeline, and a landing stage of another pipeline are 400; another company's or an invisible pipeline is 404.
- **Size:** a 500-deal chunk goes through in one statement.

**Unit:** the service's checks (mixed sources, same pipeline, the landing stage default).

---

## 8. Acceptance criteria

- [ ] Move: the deals disappear from the source board and appear in the target at the chosen landing stage.
- [ ] Add to another pipeline: the source cards stay; new deals appear in the target at the chosen stage.
- [ ] Choosing a stage transfers **every** deal in it, including those beyond the 100 loaded on the board.
- [ ] A client already in the target is skipped and named in the result; the rest go through.
- [ ] Owners: a Round robin or Single user target assigns them; Creator and Manual targets leave them unassigned, and the result says how many.
- [ ] Mixed sources, the same pipeline, or a stage of another pipeline give 400; staff get 403; invisible pipelines give 404.
- [ ] While running, the drawer can't be closed and shows progress; a failure says how many were transferred and offers Try again.
- [ ] Afterwards, the board, pipeline counts and Assign deals overview are up to date.
