# Reports module (daily work reports)

Ported from the single-company ERP (`explorewings/erp-backend` + `erp-frontend`, `src/reports`) and adapted to infynix-os: one company per tenant, Postgres RLS through `TenantDb`, roles owner / manager / staff, the `reports` menu grant, and the design system in `DESIGN.md`.

## What it does

Each person files one report per calendar day: a list of short points, an optional link, and the date it covers. The owner can add remarks to any report. The owner configures, per company: the timezone (default `Asia/Kolkata`), a due time, and off days.

## Who can do what

| | Owner | Manager | Staff |
|---|---|---|---|
| Use Reports | always | with the `reports` menu grant | with the `reports` menu grant |
| See reports | everyone's | everyone's | their own |
| Filter by person | yes | yes | no (always themselves) |
| File a report | yes | yes | yes |
| Edit / delete own report | any time | within 15 minutes of submitting | within 15 minutes of submitting |
| Edit / delete someone else's | any time | no | no |
| Add remarks | yes | no | no |
| Change settings | yes | no | no |

The menu grant is checked once, by `ReportsPolicy` on every route; the service only checks roles, which need no database query.

## Rules

- **Date.** A report covers one plain `YYYY-MM-DD` date. "Today" is today in the company's timezone. A report can't be dated in the future, or on an off day.
- **One per person per day.** Enforced by the unique index `(tenant_id, created_by, report_date)`. A duplicate is a 409 from the insert itself; there is no check-then-insert.
- **Points.** 1–100 points, each 1–5000 characters after trimming.
- **Attachment.** One per report: a link (`http`/`https`, up to 2048 characters) or an uploaded file, never both. Modes: `none`, `url`, `file` (with `fileKey`/`fileName`), and `keep` (edit only).
- **Files.** `POST /reports/files` (multipart field `file`, 10 MB, PDF / images / Word / Excel / PowerPoint / CSV / text) streams the file with `@nestjs/storage` into the `S3_BUCKET` bucket (Neon Object Storage, `agency-os`) at `tenants/<company>/reports/<person>/<uuid>.<ext>`; the type is detected from the bytes (built in for images and PDF, a signature-plus-extension check for Office and text), 413/415 otherwise. The report then attaches the returned key: it must be in the caller's own folder and still exist; size and type come from storage. Responses never include the key, only a 15-minute signed download link that saves under the original name. Replacing or removing a file, or deleting the report, deletes it from storage after the database change commits (best effort, logged). An upload that is never attached stays in storage (no cleanup job yet).
- **Edited.** `edited_at` is set when an edit changes the date, points or link. Remarks don't count as an edit.
- **Late.** `due_time IS NOT NULL AND submitted_at > ((report_date + due_time) AT TIME ZONE timezone)`, computed on read from the current settings, so changing the due time re-judges old reports. A back-filled report (yesterday's, filed today) is late; moving a report's date re-judges it. Reminders for missing reports come later, with the notifications module.
- **Clocks.** "Today", late and the 15-minute window use the database clock (`now()`), never the browser's. The drawer shows "Editable until …" from `submittedAt + 15 min`; a 403 from the server wins.
- **Date checks on edit** (future, off day) run only when the date changes, so a report on a day that later became an off day stays editable.
- **Timezone.** IANA names only (`Region/City` or `UTC`, accepted by `Intl`): Postgres reads `IST` as Israel time. Stored as `Asia/Kolkata`.
- **Remarks.** Up to 4000 characters, trimmed; empty clears them. Not an edit.
- **Deleted people.** The foreign keys use `ON DELETE SET NULL ("created_by")` / `("updated_by")`, so deleting a person keeps their reports with no author ("Deleted user"); only the owner can change those.

## Status codes

| Case | Status |
|---|---|
| Staff opens, edits or deletes someone else's report | 404 (same as missing) |
| Manager edits or deletes someone else's report | 403 |
| Author past the 15-minute window | 403 |
| Duplicate date (create, or edit onto a taken date) | 409 |
| Future date, off day, impossible date, bad link, bad timezone | 400 |
| Bad `page` / `limit` (1–100, default 50) / `date` / `userId` | 400; staff's `userId` is ignored |

## Data

`reports`: id, tenant_id, report_date (date), report_items (jsonb string[]), created_by (→ users, set null), submitted_at, updated_at, edited_at, attachment_type (`'url'` | null), attachment_url, remarks. Unique (tenant_id, created_by, report_date).

`report_settings` (one row per company, created on first save): tenant_id (PK), timezone (text, default `Asia/Kolkata`), due_time (time, nullable), skip_days (smallint[], 0 = Sunday … 6 = Saturday), updated_by, updated_at.

Both tables use `tenant_isolation` RLS and are granted to `infynix_tenant`. Migration `reports` creates them (dropping any copy created outside migrations; there were no reports yet) and registers the `reports` menu item.

## API (`/api/v1/reports`)

| Route | Who | Notes |
|---|---|---|
| `GET /reports?page&limit&date&userId` | all | Page + total in one query. Staff are always filtered to themselves; `userId` is honoured for owner and manager. |
| `GET /reports/settings` | all | Settings plus `today`, `todayIsOffDay`, `submittedToday` for the caller (one query), so the New report button needs no extra request. |
| `PATCH /reports/settings` | owner | The full object: timezone, dueTime (`HH:MM` or null), skipDays (at most 6). Returns the same shape as GET. |
| `GET /reports/calendar?from&to&userId` | all | Per-day `{ date, count, late, mine }` for a range of at most 62 days; staff always get their own. |
| `GET /reports/people` | owner, manager | Active people, plus deactivated people who filed reports, for the person filter. |
| `GET /reports/:id` | all | Staff get 404 for someone else's report. |
| `POST /reports` | all | |
| `PATCH /reports/:id` | author within 15 min, owner any time | |
| `PATCH /reports/:id/remarks` | owner | |
| `DELETE /reports/:id` | author within 15 min, owner any time | |

A report in every response: `{ id, reportDate, reports, createdBy, createdByName, submittedAt, updatedAt, editedAt, attachment: { type: 'url', url } | null, remarks, late }`. Settings: `{ timezone, dueTime, skipDays, updatedAt, today, todayIsOffDay, submittedToday, editWindowMinutes }`.

Round trips (see `docs/performance.md`): the service's transaction is begin, tenant setup, at most two statements of work, commit. Every read and write selects one shared column list (author name and late joined in), so writes return the full report in the same statement (CTE); create reads settings and inserts (duplicates surface as the unique violation); delete checks permission inside the `DELETE ... WHERE`, looking the report up only when nothing was deleted. Known extra cost: for managers and staff, `ReportsPolicy` reads their menu grants in its own transaction, as every module's policy does.

Tested against the real database in `test/reports.e2e-spec.ts`.

## Frontend

`frontend/src/reports/`, route `/_authed/reports` with `page`, `date` and `userId` in the URL.

- **Toolbar (right):** **All users ▾** (owner, manager; server-side search), **All dates ▾** (date field, Today, All dates), the one primary action **New report**, and the owner's settings (sliders icon). On phones the two filters are icons with a green dot when active.
- **Grid:** one raised card per report, newest first, 1/2/3 columns; server paging, 100 per page. A card reads top to bottom: the date (title) and "Created by …" (staff: the weekday) with the works count top right; "Submitted" with its time, Late (muted red) and Edited; the first work; the link and "Remarks added" when present. The whole card opens the drawer.
- **Drawer and settings:** view, edit, remarks, delete; timezone, due time, off days.
- `GET /reports/calendar` and `components/MonthCalendar.tsx` stay for the Calendar module; Reports doesn't use them now.

## Not in this version

Missing-report reminders and remark notifications (needs a notifications module); a cleanup job for uploads that were never attached.
