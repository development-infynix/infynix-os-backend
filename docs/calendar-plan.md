# Calendar Module Plan (multitenant)

Port the Calendar feature from the ExploreWings ERP (`explorewings/docs/calendar-module.md`, `erp-backend/src/calendar`, `erp-frontend/src/calendar`) into infynix-os, adapted to the multitenant architecture (TenantDb + RLS, owner / manager / staff, menu grants) and `frontend/DESIGN.md`.

What is built and how it works is in **[calendar-module.md](calendar-module.md)**. This file holds the decisions, the phases and what's still open.

## Phases

| Phase | Scope | Status |
|---|---|---|
| 1 | Announcements | **Done** (2026-11-24) |
| 2 | Meetings (open / private, invitees) | **Done** (2026-11-24) |
| 3 | **Tasks** (ERP workflow; decisions T1–T8 below) | **Built** (2026-11-24) |
| 4 | Notifications module + push (shared with Reports and CRM) | Design agreed below |
| 5 | History tab on the event drawer (the activity log is already written) | Planned |
| 6 | Follow-ups linked to CRM pipelines and deals | Later (not now) |

## Decisions (owner-confirmed, 2026-11-24)

| # | Decision |
|---|---|
| C1 | **Announcements are created** by the owner and managers. Staff only read them. |
| C2 | **Announcements are managed** (edit, cancel, delete) by their creator and the owner. |
| C3 | **Meetings:** anyone with the Calendar menu can create one. The creator manages their own, and the **owner has every right the creator has, on every meeting**: sees private meetings in full (invited or not), edits, cancels, deletes, changes open/private. Otherwise a **private** meeting is visible only to its creator and invitees; an **open** one to everyone. Managers, staff and invitees only view others' meetings. Invitees exist only for private meetings. (Revised twice on 2026-11-24; an "owner sees only an outline" version was built and dropped.) |
| C4 | **Deleted members:** their events stay, shown as "Deleted user" (`created_by` set to null, column-level, never `tenant_id`); their invitations are removed. The owner can still manage those events. |
| C5 | **Timezone:** days follow the company timezone (read from the Reports timezone setting for now, default `Asia/Kolkata`). |
| C6 | **Upcoming / live / ended** are derived from the time, on the server on every read and in the browser on the exact second. **No background job** for Calendar. |
| C7 | **No notifications** in Phases 1–2; they arrive with Phase 3. |
| C8 | **Deleting** is for the creator and the owner. |
| C9 | **What can be done, by status** (creator and owner): **upcoming** → edit (the Status field can cancel) and delete; **live** → cancel only, and that's final (its start has passed, so no restore; afterwards only delete); **ended** → delete; **cancelled** → delete, plus edit and restore to upcoming while its start time is still ahead. Upcoming cancels and restores happen in edit mode's Status field; a live cancel is a footer button with a confirmation. |

## Task decisions (owner-confirmed, 2026-11-24)

Reference: the ERP task workflow (`explorewings/docs/calendar-module.md` §1, `erp-backend/src/calendar/constants/task-transitions.ts`, `calendar.service.ts`, `erp-frontend/src/calendar/events/task`). Role map: ERP superadmin (S) → owner, ERP admin → manager.

| # | Decision |
|---|---|
| T1 | **The full ERP workflow.** Statuses: assigned, progress, on_review, on_hold, request_cancelation, cancelled, failed, completed. Actions: start, submit, approve, reject (send back, counts "Assigned (n)"), hold / resume (hold needs an end on or before the deadline; the assignee must give a reason), request_cancel / approve_cancel / decline_cancel / withdraw_cancel, cancel, extend (failed → assigned with a new deadline), request_extension / approve_extension / decline_extension / withdraw_extension (one pending at a time), reopen (completed or cancelled → assigned). Self-assigned tasks skip review (progress → completed) and cancel directly. The transitions live in one table, as in the ERP, and every response lists the viewer's allowed actions. |
| T2 | **The owner has the creator's rights on every task** (like C3): edit, approve, send back, extend, cancel, delete, reopen. |
| T3 | **Managers** assign to **staff or themselves**, and **see only tasks they created or were assigned** (ERP A8). |
| T4 | **Staff** assign only to **themselves** (the picker is hidden). The **owner** can assign to anyone in the company. Assignees must be able to open the Calendar. |
| T5 | **Deleting:** the creator only while the task is **assigned or cancelled** (otherwise cancel first); the **owner** at any time. |
| T6 | **Deleted members:** open tasks **assigned to** them go back to their **creator** as assigned (logged); finished ones keep showing "Deleted user". Tasks they **created** stay, managed by the owner (like C4). |
| T7 | **Actions UI:** the task drawer has a **Status dropdown** (same control for the assignee and the creator/owner) showing the current status and only the moves the viewer may make ("Submit → In review"); picking one shows its inputs (hold reason and end, new deadline, more-time request, notes) and a Save, and nothing changes until Save. (Revised 2026-11-24 from a row of step buttons.) Editing fields (title, description, deadline, priority, assignee) stays in Edit, allowed for the creator/owner while assigned, in progress, on hold or failed; reassigning resets to assigned. |
| T8 | **Placement:** a task shows **on its deadline day** only. **Failed** (assigned or in progress past the deadline) and an expired hold are worked out on read and in the browser on the second, like C6: **no background job**; the stored status catches up on the next change. |

## Multitenant mitigations (applied)

- Tenant-scoped tables (`calendar_events`, `calendar_meeting_members`, `calendar_event_log`) with `tenantIsolation` RLS and grants to `infynix_tenant`; all access via `TenantDb.run`.
- Composite FKs to `users(tenant_id, id)` and `calendar_events(tenant_id, id)`, so nothing can point across companies; person FKs set only the person column to null.
- Role map: ERP superadmin → owner (company-scoped), ERP admin → manager. Platform admins get no company calendar access.
- One menu check per request (`CalendarPolicy`); the invite picker and the server only accept people in the company who can open the Calendar.
- About 4–5 database round trips per request; writes save the event, invitees and log entry in one statement.

## Phase 3: notifications and push (design agreed, not built)

- **Action-triggered** notifications (invited, meeting changed or cancelled, announcement posted; remarks on reports): written in the same transaction as the change; the push is sent after commit. No job.
- **Clock-triggered** notifications ("starts in 10 minutes", "today's report not filed" at the due time, later task deadlines): a `scheduled_notifications` table (company, due time, kind, target) written when events are created or changed. An in-process timer (`@nestjs/schedule`, one instance via `@nestjs/locks`) sleeps until the earliest due row, sends, and re-arms; on startup it catches up and drops reminders that no longer make sense. Idle nights cost nothing on the Neon free tier.
- **Push:** standard Web Push (VAPID) with a service worker on the Cloudflare Pages frontend; subscriptions stored per person per company. iPhones need the app added to the Home Screen (iOS 16.4+).
- **Open:** whether the Stackshift free tier sleeps when idle. Check `/api/v1/health` `uptime` after a quiet night; if it sleeps, a hosted delayed-message service (e.g. Upstash QStash) calls the backend at each due time instead of the in-process timer.

## Open questions

1. **Announcements while live:** they follow C9, so a multi-day announcement can't be edited while running (only cancelled). Keep, or allow edits?
2. **Background refresh:** the page refetches other people's changes every 5 minutes (plus on tab focus and the Refresh button). 15 minutes would let the free-tier database sleep more.
3. **Shared company timezone:** move the timezone from Reports settings to a company-level setting both modules read.
