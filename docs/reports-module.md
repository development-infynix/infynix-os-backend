# Reports module (daily work reports)

Ported from the single-company ERP (`explorewings/erp-backend` + `erp-frontend`, `src/reports`) and adapted to infynix-os: one company per tenant, Postgres RLS through `TenantDb`, roles owner / manager / staff, the `reports` menu grant, and the design system in `frontend/DESIGN.md`.

## What it does

Each person files one report per calendar day: a list of **works** (what they did), the date it covers, and optionally one attachment, a link or an uploaded file. The owner can add remarks to any report. The owner configures, per company: the timezone (default `Asia/Kolkata`), a due time (reports filed after it are marked Late), and off days.

The UI calls report items "works" ("3 works"), never "points". The API field is still `reports`.

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
- **One per person per day.** Enforced by the unique index `(tenant_id, created_by, report_date)`. A duplicate is a 409 from the insert itself; there is no check-then-insert on the server. The form also checks the picked day up front (see Frontend) so nobody types a report that can't be saved.
- **Works.** 1–100 works, each 1–5000 characters after trimming.
- **Attachment.** At most one per report: a link (`http`/`https`, up to 2048 characters) or an uploaded file, never both (a check constraint enforces the shape). Modes: `none`, `url`, `file` (with `fileKey` and `fileName`), and `keep` (edit only).
- **Files.**
  - `POST /reports/files` (multipart field `file`) takes one file of at most 10 MB: PDF, JPEG/PNG/WebP/GIF/HEIC, Word (.doc/.docx), Excel (.xls/.xlsx), PowerPoint (.pptx), CSV or text.
  - It is streamed with `@nestjs/storage` (`uploadToDisk`, Fastify `FileInterceptor`) straight into the `S3_BUCKET` bucket (Neon Object Storage, `agency-os`) at `tenants/<company>/reports/<person>/<uuid>.<ext>`. The client's file name never becomes part of a key.
  - The type comes from the bytes: built-in detection for images and PDF; for Office and text, the signature decides the family (ZIP, old Office, or no binary bytes) and the extension picks within it. Too large is 413, any other type 415.
  - Creating or editing a report then attaches the returned key. It must be in the caller's own folder and still exist; size and type are read from storage, never from the client. An edit may re-send the report's current file unchanged.
  - Responses never include the key, only a 15-minute signed download link that saves under the original name.
  - Replacing or removing a file, or deleting the report, deletes the file from storage after the database change commits (best effort, logged).
  - An upload that is never attached (the form was cancelled) stays in storage; there is no cleanup job yet.
- **Edited.** `edited_at` is set when an edit changes the date, the works or the attachment. Remarks don't count as an edit.
- **Late.** `due_time IS NOT NULL AND submitted_at > ((report_date + due_time) AT TIME ZONE timezone)`, computed on read from the current settings, so changing the due time re-judges old reports. A back-filled report (yesterday's, filed today) is late; moving a report's date re-judges it.
- **Clocks.** "Today", Late and the 15-minute window use the database clock (`now()`), never the browser's. The drawer shows "Editable until …" from `submittedAt + 15 min`; a 403 from the server wins.
- **Date checks on edit** (future, off day) run only when the date changes, so a report on a day that later became an off day stays editable.
- **Timezone.** IANA names only (`Region/City` or `UTC`, accepted by `Intl`): Postgres reads `IST` as Israel time. Stored as `Asia/Kolkata` (Node lists it as the old alias `Asia/Calcutta`; both pass).
- **Remarks.** Up to 4000 characters, trimmed; empty clears them. Not an edit.
- **Deleted people.** The foreign keys use `ON DELETE SET NULL ("created_by")` / `("updated_by")` (column lists, so `tenant_id` is never nulled). Deleting a person keeps their reports with no author ("Deleted user"); only the owner can change those.

## Status codes

| Case | Status |
|---|---|
| Staff opens, edits or deletes someone else's report | 404 (same as missing) |
| Manager edits or deletes someone else's report | 403 |
| Author past the 15-minute window | 403 |
| Duplicate date (create, or edit onto a taken date) | 409 |
| Future date, off day, impossible date, bad link, bad timezone | 400 |
| File key not yours, or the upload no longer exists | 400 |
| Upload over 10 MB / unsupported type | 413 / 415 |
| Bad `page` / `limit` (1–100, default 100) / `date` / `userId` | 400; staff's `userId` is ignored |

## Data

`reports`: id, tenant_id, report_date (date), report_items (jsonb string[]), created_by (→ users, set null), submitted_at, updated_at, edited_at, attachment_type (`'url'` | `'file'` | null), attachment_url, attachment_key, attachment_name, attachment_size (int), attachment_content_type, remarks. Unique (tenant_id, created_by, report_date) and unique attachment_key. `reports_attachment_shape` allows exactly nothing, a link, or a complete file.

`report_settings` (one row per company, created on first save): tenant_id (PK), timezone (text, default `Asia/Kolkata`), due_time (time, nullable), skip_days (smallint[], 0 = Sunday … 6 = Saturday), updated_by, updated_at.

Both tables use `tenant_isolation` RLS and are granted to `infynix_tenant`.

Migrations:
- `reports` creates both tables (dropping any copy created outside migrations; there were no reports yet), the grants, and the `reports` menu item.
- `report_files` adds the file columns, the unique key and the widened checks.

## Storage configuration

`src/storage/storage.options.ts` registers one `S3Disk` named `files` through `StorageModule.forRootAsync`. Env (see `.env.example`):

| Variable | Example |
|---|---|
| `S3_BUCKET` | `agency-os` |
| `AWS_ENDPOINT_URL_S3` | `https://<branch>.storage.<region>.aws.neon.tech` |
| `AWS_REGION` | `eu-central-1` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | from the Neon console |

The backend refuses to start without `S3_BUCKET` and `AWS_ENDPOINT_URL_S3`.

## API (`/api/v1/reports`)

| Route | Who | Notes |
|---|---|---|
| `GET /reports?page&limit&date&userId` | all | Page + total in one query, newest report date first, 100 per page by default. Staff are always filtered to themselves; `userId` is honoured for owner and manager. |
| `GET /reports/settings` | all | Settings plus `today`, `todayIsOffDay`, `submittedToday` for the caller (one query). |
| `PATCH /reports/settings` | owner | The full object: timezone, dueTime (`HH:MM` or null), skipDays (at most 6). Returns the same shape as GET. |
| `GET /reports/people?q&limit&selected` | owner, manager | The person filter. Active people plus deactivated people who filed reports; `q` matches name or email (wildcards literal, prefix matches first); `limit` 1–50, default 20; `selected` is always returned, first. |
| `GET /reports/calendar?from&to&userId` | all | Per-day `{ date, count, late, mine }` for at most 62 days; staff always get their own. Not used by Reports now (kept for the Calendar module). |
| `POST /reports/files` | all | Multipart upload (see Files). Returns `{ key, name, size, contentType }`. |
| `GET /reports/:id` | all | Staff get 404 for someone else's report. |
| `POST /reports` | all | |
| `PATCH /reports/:id` | author within 15 min, owner any time | |
| `PATCH /reports/:id/remarks` | owner | |
| `DELETE /reports/:id` | author within 15 min, owner any time | Also deletes its file from storage. |

A report in every response: `{ id, reportDate, reports, createdBy, createdByName, submittedAt, updatedAt, editedAt, attachment, remarks, late }`, where `attachment` is `{ type: 'url', url }`, `{ type: 'file', name, size, contentType, url }` (`url` is the 15-minute signed download link), or null. Settings: `{ timezone, dueTime, skipDays, updatedAt, today, todayIsOffDay, submittedToday, editWindowMinutes }`.

Round trips (see `docs/performance.md`): the service's transaction is begin, tenant setup, at most two statements of work, commit. Every read and write selects one shared column list (author name and Late joined in), so writes return the full report in the same statement (CTE). Create reads settings and inserts (duplicates surface as the unique violation). Delete checks permission inside the `DELETE ... WHERE` and returns the file key, looking the report up only when nothing was deleted. Storage calls (checking an upload, deleting a file) run outside the transaction, so no connection waits on them; signing download links is local, with no network call. Known extra cost: for managers and staff, `ReportsPolicy` reads their menu grants in its own transaction, as every module's policy does.

Tested against the real database in `test/reports.e2e-spec.ts` (8 cases, including files, using an in-memory disk).

## Frontend

`frontend/src/reports/`, route `/_authed/reports` with `page`, `date` and `userId` in the URL.

- **Top bar** (fixed under the app header while the cards scroll): **All users ▾** (owner, manager; server-side search, debounced 300 ms), **All dates ▾** (date field, Today, All dates), the one primary action **New report**, and the owner's settings (sliders icon).
  - On phones New report is leftmost with its full label, and the two filters are icons with a green dot when active.
  - New report is disabled on an off day (the company's today), with the reason as a tooltip.
- **Grid:** one raised card (`card-3d`) per report, newest first: 1 column on phones, 2 on tablets, 3 on laptops, 4 on wide screens. A card reads:
  - the date as the title, with "Created by …" under it (staff: the weekday), and the works count top right;
  - "Submitted", then the time with "Edited" when it applies, and **Late** (muted red, `text-danger/75`) at the right of that line;
  - "Remarks added" at the foot when present.

  The card doesn't show the works or the link; the whole card opens the drawer.
- **Bottom bar:** the pagination ("1–100 | 169 reports", Previous / page / Next), fixed to the bottom, shown whenever there are reports. Changing page scrolls back to the first card.
- **Drawer (view):** Report panel (date, filed by, submitted with Late/Edited, files: a link, or the file's name and size as a download), numbered works, remarks (editable by the owner, read-only for others when present). Edit and delete appear while allowed, with "Editable until …" for the author.
- **Drawer (new / edit):**
  - **Date.** New reports start on today.
  - **Works.** Numbered rows; the last row ends in a primary **＋** (Enter adds the next work, Shift+Enter a new line, Backspace in an empty row removes it); earlier rows end in ✕.
  - **Files.** A sub-footer pinned above the actions, with a **Link | Upload** switch. The open tab is what gets attached. Upload is a drop zone that uploads as soon as a file is picked (progress bar, cancel, size and type errors); Submit waits for it.
  - **Heading alerts.** When the picked date can't take the report, the heading is replaced, in muted red, by "Sunday is an off day. Pick another day." or "You already filed a report for this day. Pick another day.", and Submit is disabled. The second check looks up the picked day as soon as it's set; the report being edited doesn't count against itself.
- **Settings (owner):** timezone, due time, off days.
- **Empty states:** an illustrated "No reports yet" (the drawing opens New report) or "No matching reports" with Clear filters.

`components/MonthCalendar.tsx`, `lib/calendar.ts` and `GET /reports/calendar` were built for a calendar layout that was tried and reverted; they stay for the Calendar module.

## Deploying

1. Run `pnpm db:migrate` against production (`reports`, then `report_files`).
2. Set `S3_BUCKET` and the `AWS_*` variables on the backend host (Stackshift), using a key that hasn't been shared.
3. Grant the **Reports** menu to the people who should use it (System › person › Permissions).

## Not in this version

- Missing-report reminders and remark notifications (needs a notifications module).
- A cleanup job for uploads that were never attached.
- "Next" (plan for tomorrow) and "Blockers" fields, seen in other daily-report tools.
