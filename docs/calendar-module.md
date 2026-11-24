# Calendar module (announcements, meetings and tasks)

Ported from the ExploreWings ERP calendar and adapted to infynix-os: one company per tenant, Postgres RLS through `TenantDb`, roles owner / manager / staff, the `calendar` menu grant, and `frontend/DESIGN.md`. Decisions, phases and open questions are in **[calendar-plan.md](calendar-plan.md)** (C1–C9, T1–T8).

## What it does

A company calendar with three kinds of event:

- **Announcements**: company-wide notices with a start and end (one minute to 62 days). Posted by the owner and managers.
- **Meetings**: a time slot with a place (room, address or link), open to everyone or private to the people invited. Anyone with the Calendar menu can create one.
- **Tasks**: work with one assignee, a deadline and a priority, moved along a workflow (start, submit, approve, hold, more time…). See [Tasks](#tasks).

Events show on a month grid and in a day panel. Announcements and meetings follow the clock (upcoming, live, ended, cancelled); tasks follow their workflow, with failed and an ended hold also worked out from the clock.

## Who can do what

| | Owner | Creator | Manager | Staff | Invitee |
|---|---|---|---|---|---|
| Open the Calendar | always | — | with the `calendar` grant | with the `calendar` grant | — |
| Post an announcement | ✅ | — | ✅ | ❌ | — |
| Create a meeting | ✅ | — | ✅ | ✅ | — |
| See announcements and open meetings | ✅ | ✅ | ✅ | ✅ | ✅ |
| See a private meeting | ✅ in full | ✅ | only if invited | only if invited | ✅ |
| Edit, cancel, restore, delete | ✅ any event | ✅ their own | ❌ others' | ❌ others' | ❌ |
| Change open ↔ private | ✅ | ✅ | ❌ | ❌ | ❌ |

The owner has every right the creator has, on every event (C3). The menu grant is checked once, by `CalendarPolicy` on every route; per-event rules live in `CalendarService` and need no extra query.

## What can be done, by status (C9)

| Status | Edit | Delete | Status change |
|---|---|---|---|
| **Upcoming** | ✅ | ✅ | cancel (edit mode's Status field; restorable until the start) |
| **Live** | ❌ | ❌ | cancel only, **final** (footer button with a confirmation) |
| **Ended** | ❌ | ✅ | — |
| **Cancelled, before its start** | ✅ | ✅ | restore to upcoming (Status field) |
| **Cancelled, after its start** | ❌ | ✅ | — |

Status is never stored as upcoming, live or ended: the row stores `scheduled | cancelled` and the rest is derived from `starts_at` / `ends_at`, on the server on every read and in the browser on the exact second (C6). There is no background job.

## Rules

- **Time:** an event runs from `starts_at` to `ends_at` (1 minute to 62 days). The form takes wall-clock dates and times in the **company timezone** (C5) and sends instants; days in the grid are grouped in that zone. An event ending exactly at midnight doesn't spill into the next day.
- **Announcement:** title and text required; no place, visibility or invitees.
- **Meeting:** title, place and visibility required; agenda optional. Invitees only for **private** meetings (an open meeting is saved with none). The creator is always part of their meeting and is never stored as an invitee.
- **Invitees:** active people in the same company who can open the Calendar (the owner, or a `calendar` grant). The picker lists only them and the server checks again.
- **Concurrency:** every write names the `version` it read; a stale one is a 409 with the latest copy.
- **Cancel:** optional reason (up to 1000 characters); the event stays on the calendar, marked cancelled.
- **Delete:** soft (`deleted_at`), so the activity log keeps the event.
- **Deleted members (C4):** their events stay with no creator ("Deleted user") and stay manageable by the owner; their invitations are removed.
- **Activity log:** every create, edit, cancel, restore and delete writes `calendar_event_log` (actor, action, status move, reason, changed fields). Not shown in the UI yet (Phase 4).

## Status codes

| Case | Status |
|---|---|
| Missing, deleted, other company, or a private meeting you can't see | 404 |
| Visible but not allowed (wrong role, or not allowed in its status) | 403 |
| Stale `version` | 409, with `current` |
| Validation (missing place, bad time range, more than 62 days, invitee not allowed, staff posting an announcement…) | 400 / 403 |

## Data

`calendar_events`: id (uuid), tenant_id, type (`announcement | meeting`), title, description, status (`scheduled | cancelled`), starts_at, ends_at, location, visibility (`open | private`), cancel_reason, version, created_by, deleted_at, deleted_by, created_at, updated_at. Checks: valid type and status, non-blank title, `ends_at > starts_at`, and each type carries exactly its own fields.

`calendar_meeting_members`: (tenant_id, event_id, user_id) primary key; deleting the event or the person removes the row.

`calendar_event_log`: id, tenant_id, event_id, actor_id, action (`created | updated | cancelled | restored | deleted`), from_status, to_status, reason, meta (jsonb), created_at.

All three use `tenant_isolation` RLS, are granted to `infynix_tenant`, and reference users and events through `(tenant_id, id)` composite keys; person keys use `ON DELETE SET NULL (column)`. Migration: `calendar`.

## API (`/api/v1/calendar`)

| Route | Notes |
|---|---|
| `GET /calendar?from&to` | Events overlapping the range (ISO instants, at most 62 days) the caller can see, earliest first, each with `effectiveStatus` and `permissions`. Capped at 2000 (`truncated`). |
| `GET /calendar/context` | `{ timezone, today }` for the company. |
| `GET /calendar/people?q&limit` | Invite picker: people who can open the Calendar; `q` matches name or email; limit 1–50, default 20. |
| `GET /calendar/:id` | One event; 404 when not visible. |
| `POST /calendar` | `{ type, title, description?, startsAt, durationMinutes, location?, visibility?, memberIds? }`. |
| `PATCH /calendar/:id` | `{ version, ...fields }` to edit; `{ version, action: 'cancel', reason? }`; `{ version, action: 'restore' }`. |
| `DELETE /calendar/:id` | Soft delete. |

An event in every response: `{ id, type, title, description, status, effectiveStatus, startsAt, endsAt, location, visibility, members: [{ id, fullName }], isMember, cancelReason, version, createdBy, createdByName, createdAt, updatedAt, permissions: { canEdit, canCancel, canRestore, canDelete } }`.

Round trips: begin, tenant setup, one or two statements of work, commit. Writes save the event, invitees and log entry in one statement (CTE) and read the result back once.

Tested against the real database in `test/calendar.e2e-spec.ts` (7 cases: announcements, private-meeting visibility and owner rights, live cancel, cancel/restore/delete, no restore after the start, invite rules, deleted members).

## Frontend

`frontend/src/calendar/`, route `/_authed/calendar` with `month`, `date` and `event` in the URL.

- **Desktop (lg+):** the selected day on the left (Refresh, **New event**, and a panel with a fixed date header listing the day's events) and the month on the right (Today, ‹ month ›).
- **Below lg (ERP D11):** one header row (month switcher, Today, Refresh, ＋) and the month; tapping a day opens a drawer titled "Events" with that day's list.
- **Month grid** (`components/MonthCalendar.tsx`, shared): today as a green number tile, the selected day on the green wash, arrow-key navigation; each day shows up to **three dots** in its bottom-right corner (green live, ink upcoming, muted ended or cancelled), then "+".
- **Day list:** raised cards (type, private lock, status tag, title, times, place, host, invitee count for private meetings). An empty day shows an illustration that starts a meeting, and **Create ▾**.
- **Event drawer:** status, **From** and **Till**, place (a link gets Copy and Open buttons), visibility, host, invitees (private only), cancel reason, and the announcement text or agenda. Footer buttons per the status table, right-aligned with Delete last.
- **Create / edit form:** title; start and end date and time in the company timezone; for meetings the place, **Open | Private**, and **Invite** (private only, server-side search); agenda or announcement text. In edit mode a **Status** field (Upcoming · Live · Ended · Cancelled) allows only the moves in the status table; the save button turns red for a cancel.
- **Live status:** `lib/live-status.ts` arms one timer for the next start or end on screen, so statuses and buttons change on the second; a background refetch every 5 minutes, tab focus and the Refresh button pick up other people's changes.
- **Time:** `lib/zoned.ts` converts between instants and company-timezone wall time (daylight saving handled).

## Tasks

Ported from the ERP task workflow; decisions T1–T8 in the plan. Code: `src/calendar/task-workflow.ts` (the transition table and `taskStatusAt`), `task-rules.ts` (allowed steps, what a step or an edit writes), and the task branches in `calendar.service.ts`.

**Who.** A task has one assignee and is seen by its creator, its assignee and the owner (T3). Staff assign only to themselves; managers to staff or themselves; the owner to anyone (T4). Assignees must be active and able to open the Calendar. The owner has every creator right on every task (T2) and alone can reopen.

**Statuses.** assigned · in progress · in review · on hold · cancel requested · cancelled · failed · completed. The status chip shows "Assigned (n)" after the work was sent back n times.

**Steps** (A = assignee, C = creator or owner, O = owner only). Reviewed tasks (someone else's):

| From | Step | To | Who | Inputs |
|---|---|---|---|---|
| assigned | Start work | in progress | A | — |
| in progress | Submit | in review | A | — |
| in review | Approve | completed | C | notes (optional) |
| in review | Send back | assigned (count +1) | C | note (optional) |
| assigned, in progress | Hold | on hold | A, C | until (≤ deadline), reason (required from A) |
| on hold | Lift hold | previous | C | — |
| assigned, in progress, on hold | Ask to cancel | cancel requested | A | reason |
| cancel requested | Allow cancel / Decline / Withdraw | cancelled / previous / previous | C / C / A | — / note / — |
| any open | Cancel task | cancelled | C | reason (optional) |
| failed | Extend | assigned | C | new deadline |
| assigned, in progress, failed | More time | (same) | A | proposed date, reason (one pending at a time) |
| (more time pending) | Approve / Decline / Withdraw | deadline moved (failed → assigned) / — / — | C / C / A | deadline defaults to the date asked, note |
| completed, cancelled | Reopen | assigned | O | new deadline when the old one passed |

Self-assigned tasks skip review and cancel requests: start, then **Complete**; hold and cancel directly.

**Failed and holds (T8).** An assigned or in-progress task whose deadline passes is **failed**; an on-hold task whose hold end passes is back to its previous status. Both are worked out on every read (server) and on the second (browser); there is no job. The stored status catches up on the next change, and the page reloads a task's steps once when the clock moves it.

**Editing (T7).** Creator or owner, while assigned, in progress, on hold or failed (not in review: send it back first). Title, details, deadline, priority, assignee. Reassigning starts over (assigned, count 0, requests cleared); a new deadline on a failed task brings it back to assigned.

**Deleting (T5).** The creator while assigned or cancelled; the owner at any time.

**Deleted assignee (T6).** A database trigger (`users_return_calendar_tasks`) hands their open tasks back to the creator as assigned and logs `reassigned`; finished ones keep no assignee ("Deleted user").

**On the calendar.** A task shows only on its **deadline day**, sorted by due time. Its card shows the due time (muted red when failed) and the other person ("For Sam", or "From Max" when it's yours). The drawer shows a **Status** dropdown (the current status plus only the moves the server allows this viewer, e.g. "Submit → In review"; the chosen move's inputs and Save appear under it), then the details (status, due, priority, assigned to, created by, hold, more time asked, cancel reason, times sent back, completion notes). Edit and Delete sit in the footer.

**API.** `POST /calendar` with `{ type: 'task', title, description?, deadline, assigneeId?, priority? }` (assignee defaults to you, priority to medium). `PATCH /calendar/:id` with `{ version, action, ...inputs }` for a step, or `{ version, title?, description?, deadline?, assigneeId?, priority? }` for an edit. `GET /calendar/people?for=assign` lists whom you may assign. A task in a response adds `assigneeId, assigneeName, priority, previousStatus, holdReason, holdUntil, completionRemarks, rejectCount, extensionUntil, extensionReason`, and `permissions.actions: [{ action, to, fields }]`. `endsAt` is the deadline; `startsAt` is when it was created.

**Data.** Task columns on `calendar_events`: assignee_id (composite FK, `ON DELETE SET NULL ("assignee_id")`), priority, previous_status, hold_reason, hold_until, completion_remarks, reject_count, extension_until, extension_reason. Checks keep task statuses and fields to tasks, and a hold always has an end. Migrations: `calendar_tasks` (with the T6 trigger) and `calendar_tasks_trigger_fix` (skips the hand-back while the company or the creator is being deleted).

Tested in `test/calendar-tasks.e2e-spec.ts` (11 cases, including deleting a whole company with open tasks).

## Deploying

1. Run `pnpm db:migrate` against production (`calendar`, `calendar_tasks`, `calendar_tasks_trigger_fix`).
2. Grant the **Calendar** menu to the people who should use it (System › person › Permissions).
3. Restart or redeploy the backend.
