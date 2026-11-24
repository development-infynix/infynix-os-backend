# Calendar Module Plan (multitenant) — Phase 1: Announcements, Phase 2: Meetings

Port the Calendar feature from the ERP (`explorewings/erp-backend`, `erp-frontend`, `docs/calendar-module.md`) into infynix-os, adapted to the multitenant architecture. Phase 1 implements the **announcement** event type; Phase 2 adds **meetings**. Tasks, follow-ups, notifications and any background job come later.

## Status

Phases 1 and 2 implemented (2026-11-24): migration `calendar`, `src/calendar` (policy, repository, service, controller), `test/calendar.e2e-spec.ts`; frontend `src/calendar` (page, drawer, form, invite picker) and `src/calendar/lib/zoned.ts`. Verified against the real database in a rolled-back transaction (41 checks). Not yet: notifications, background job (C6, to be discussed), a History tab on the activity log, tasks and follow-ups.

## Decisions (owner-confirmed, 2026-11-24)

| # | Decision |
|---|---|
| C1 | **Announcements are created** by the owner and managers. Staff only read them. |
| C2 | **Announcements are managed** (edit, cancel, delete) by their creator and the owner. |
| C3 | **Meetings:** the creator can always view and manage their own. The **owner has every right the creator has, on every meeting**: sees private meetings in full (invited or not), edits, cancels, deletes, and changes open/private. Otherwise a **private** meeting is visible only to its creator and members; an **open** one to everyone. Managers and members only view. Anyone with the Calendar menu can create a meeting. Invitees exist only for private meetings. (Revised twice on 2026-11-24.) |
| C4 | **Deleted members:** their events stay, shown as "Deleted user" (`created_by` set to null, column-level, never `tenant_id`); their meeting invitations are removed. |
| C5 | **Timezone:** days in the month grid follow the company timezone (read from the Reports timezone setting for now, default `Asia/Kolkata`). |
| C6 | **Upcoming / live / ended** are derived when events are read. **No background job** in Phases 1–2; whether to add one (for timed alerts) is still to be discussed. |
| C8 | **Deleting a meeting** is for its creator and the owner, at any stage (upcoming, live, ended, cancelled). So a meeting whose creator was deleted can still be managed by the owner. |
| C9 | **What can be done, by status** (creator and owner only): **upcoming** → edit (the Status field can cancel) and delete; **live** → cancel only (a footer button with a confirmation; final, since its start has passed, so after that only delete); **ended** → delete; **cancelled** → delete, plus edit (and restore to upcoming) while its start time is still ahead. Cancelling and restoring happen in edit mode's Status field, not the footer. |
| C7 | **No notifications** in Phases 1–2; the shared notifications module comes next. |

## Multitenant mitigations

- Tenant-scoped tables `calendar_events`, `calendar_meeting_members`, `calendar_event_log`, each with `pgTable.withRLS` + `tenantIsolation(tenantId)` and grants to `infynix_tenant`.
- All company data access via `TenantDb.run(tenantId, fn)`.
- Composite FKs: `(tenant_id, created_by)` and `(tenant_id, user_id)` → `users(tenant_id, id)`, `(tenant_id, event_id)` → `calendar_events(tenant_id, id)`, so nothing can point across companies.
- Roles: ERP superadmin → **owner** (scoped to their company); ERP admin → **manager**; platform admins get no company calendar access.
- Menu gating: `CalendarPolicy.use` (owner always; others need the `calendar` grant), checked once per request.
- Invite picker lists only people in the company who can open the Calendar (owner, or a `calendar` grant), in one query.
- Round trips: about 4 per request (no per-item queries); member checks and the response are built in set-based SQL.

## Event model

One table, `type` ∈ `announcement | meeting`.

- Shared: title (1–200), description (≤ 5000), `starts_at`, `ends_at` (from `durationMinutes`, 1 minute to 62 days), stored status `scheduled | cancelled`, `cancel_reason`, `version` (optimistic concurrency), soft delete (`deleted_at`, `deleted_by`), `created_by`, timestamps.
- Announcement: description required.
- Meeting: `location` (room, address or link) and `visibility` (`open | private`) required; members in `calendar_meeting_members` (the creator is implicitly a member).
- Derived status on read: `cancelled`, else `upcoming` (before start), `live` (start ≤ now < end), `ended`.
- Edit and cancel only while upcoming or live; delete any time (by those who manage it).
- Every change writes a `calendar_event_log` row (`created`, `updated`, `cancelled`, `deleted`) with the actor and what changed.

## API (`/api/v1/calendar`)

| Route | Notes |
|---|---|
| `GET /calendar?from&to` | Events overlapping the range (≤ 62 days) that the caller can see, with permissions per event. |
| `GET /calendar/context` | Company timezone and today. |
| `GET /calendar/people?q` | Invite picker (people who can open the Calendar). |
| `GET /calendar/:id` | 404 when not visible. |
| `POST /calendar` | Create an announcement or meeting. |
| `PATCH /calendar/:id` | `{ version, ...fields }` to edit, or `{ version, action: 'cancel', reason? }`; 409 on a stale version. |
| `DELETE /calendar/:id` | Soft delete. |

Errors: 400 validation, 403 visible but not allowed, 404 missing or not visible, 409 stale version.

## Frontend

- Layout (ERP D11, the reference the owner proposed): the selected day's events on the left (day heading, **New event**), the month on the right (‹ month ›, Today), using the shared `MonthCalendar`. Phones: month first, the day's events below.
- Day panel: raised cards per event (type, time, title, status: Upcoming / Live / Ended / Cancelled).
- Drawer: view an event; edit, cancel and delete when allowed; create form per type (announcement; meeting with open/private and an invite picker).
- State in the URL: `month`, `date`, `event`.

## Validation

- tsc and lint, backend and frontend.
- e2e against the real database: company isolation, announcement create/manage rules, meeting visibility (private vs owner not invited), version conflict, deleted member.
