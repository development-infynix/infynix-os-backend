# CRM phase 2 plan: permissions, activity log, payments, qualification

The four features deferred on 23 Nov 2026 when phase 1 closed. Phase 1 (core, assignment, transfer) is recorded in [crm-phase1.md](crm-phase1.md).

- **Status (23 Nov 2026):** planned, not started. Each feature gets its own detailed doc before it's built, in the usual order: decisions first, then a draft, then a review.
- **Related docs:** [crm-phase1.md](crm-phase1.md), [access-model.md](access-model.md), [user-deals-assignment.md](user-deals-assignment.md), [deal-transfer.md](deal-transfer.md), [performance.md](performance.md)

| # | Feature | Blocked by | Suggested order |
|---|---|---|---|
| 1 | Permissions | nothing | first: every later feature needs its rights decided |
| 2 | Activity log | nothing | second: it records what permissions allow |
| 3 | Payment actions | the Razorpay keys | when the keys arrive |
| 4 | Qualification actions | its own design (pipeline pairing, calendar) | last: the largest piece |

---

## 1. Permissions

Who may do what, beyond seeing a menu. App-wide, not only the CRM.

**Today:**
- Menus are granted per person by the Owner in Admin › Users ([access-model.md](access-model.md)). The Owner holds everything implicitly.
- Inside the CRM, actions are fixed by role through `CrmPolicy`:

| Check | Who | Covers |
|---|---|---|
| `use` | anyone with the `crm` grant | the board, search, adding deals (form, imports, bulk), dragging, deleting one deal or a selection, deal details |
| `manage` | the Owner and managers with `crm` | pipelines, stages, assignment rules and tools, access lists, changing a deal's owner, Deal transfer (Move / Add) |

- The Clients module has `use` only: anyone with the `clients` grant can do everything there.
- The per-pipeline access list limits which pipelines someone sees, on top of the role check.
- The schema already reserves action grants: `access_items.kind` has an `action` value that nothing uses yet.

**Decisions needed:**
1. **Model:** per-person action grants starting from role defaults, per-person starting empty, or one list per role for the whole company.
2. **Scope of the first pass:** the CRM and Clients, or the CRM only.
3. **Release day:** existing managers and staff keep exactly what they can do today (grants backfilled), or move to the new role defaults.
4. **Pipeline access list:** stays alongside the action grants (both must allow), or is replaced by them.
5. **The action list itself:** for example deleting deals, transferring, managing pipelines and stages, assignment tools, changing a deal's owner, importing and deleting clients.

**Shape so far:** action grants reuse `access_items` (`kind = 'action'`) and `user_access`, so the session's `access` list carries them and the API checks them with `@Can`, like menus. The Owner keeps everything.

---

## 2. Activity log

A history of what happened in a pipeline and to each deal.

**Today:** nothing is recorded. The deal drawer's **History** tab is a placeholder, and nothing records who deleted, moved or reassigned a deal.

**From the reference:** a `crm_pipeline_activity` table holding rule changes, assignments, unassignments and access-list changes. It copies the actor's name in, so entries survive renames and deletes.

**Decisions needed:**
1. **What's logged:** at least rule changes, assignment and unassignment, access-list changes, transfers (Move / Add) and deletes. Stage moves on the board too, or not?
2. **Where it shows:** the deal drawer's History tab (per deal), a pipeline history panel (in Assign deals or Actions), or both.
3. **Bulk actions:** one entry per deal, or one summary entry per run ("Shared 500 deals between 4 people"). This matters for [performance.md](performance.md): the log has to be written in the same statement or transaction as the action, not as a query per deal.
4. **Retention:** kept forever, or trimmed after a time.
5. **Clients:** whether client changes join this log (phase 1, decision 3).

---

## 3. Payment actions

The **Payment actions** card in CRM › Actions is a placeholder.

**Blocked by:** the Razorpay keys (test and live) haven't been handed over yet.

**To decide when they arrive:**
1. **What the card does:** for example create a payment link for a deal, see whether it was paid, and move the deal to a stage when payment lands.
2. **Where the keys live:** one Razorpay account for the platform, or each company connects its own (multi-tenant).
3. **Webhooks:** Razorpay calls the backend when a payment completes. That needs a public endpoint with signature checks, and a record of payments per deal.
4. **Link to the Payments & Budget menu,** which already exists in the access catalogue.

---

## 4. Qualification actions

The **Qualification actions** card in CRM › Actions is a placeholder. It's larger than a card, so it gets its own design doc.

**What it covers (as described on 23 Nov):**
- a **qualification stage** for deals: deals are qualified before they move on
- **pairing between the sales pipeline and the client pipeline:** a qualified deal in sales continues in a client pipeline
- later, **calendar booking pairing:** qualification or the next step books a slot in the Calendar module

**Decisions needed (in its own doc):**
1. How a stage is marked as the qualification stage, and what "qualified" records (a flag, answers, a score).
2. How two pipelines are paired, and what happens to the deal: moved, added (like Deal transfer's Add), or linked.
3. Whether owners carry over or follow the client pipeline's assignment rule.
4. What the Calendar module needs to exist first.

---

## What stays as it is until then

- The `use` / `manage` role checks, until permissions replace them.
- The History tab placeholder, until the activity log.
- The two placeholder cards in Actions.
