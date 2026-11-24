# Calendar Module Plan (multitenant) — Phase 1: Announcements

Port the Calendar feature from erp into infynixos, adapted to multitenant architecture. Phase 1 implements only the **announcement** event type first, per scope decision. Reference: `/tmp/erp-backend`, `/tmp/erp-frontend`.

## Multitenant mitigations

- Tenant-scoped tables `calendar_events`, `calendar_event_log` (and later meeting members) use `pgTable.withRLS` + `tenantIsolation(tenantId)`.
- All company data access via `TenantDb.run(tenantId, fn)`.
- Composite FKs `(tenant_id, id)` to users to prevent cross-company references.
- Roles: only `owner` elevated; manager/staff scoped to own/visible events per policy.
- Menu gating via `AccessService.keysFor` and CalendarPolicy.use.

## Announcement type (from erp)

- Fields: title, description (required), startsAt, durationMinutes (derived endsAt), status scheduled/cancelled.
- Time-boxed type: statuses scheduled/cancelled (and live/completed derived by time).
- Visible to all company users (policy: type announcement).
- Manage (edit/cancel/delete) by creator, or owner/manager? erp: super/admin. Infynix: owner (and maybe manager). Recommended owner-only for manage, creator can cancel own.
- Validation: description required; startsAt + durationMinutes required.

## Backend plan

1. Schema: add `calendar_events` (tenant-scoped) and `calendar_event_log` (tenant-scoped) tables; composite FKs; grants.
2. Module CalendarModule (Announcements only initially) with repo/service/policy/controller.
3. Policy CalendarPolicy.use: owner always; others require `calendar` menu grant.
4. Visibility: announcements visible to all company users.
5. Repository: tenant-scoped CRUD, filters by type/date, pagination.
6. Service: create announcement, update/edit, cancel, delete; version check; log.
7. Controller routes under /calendar (list, get, create, patch, delete; people/updates/history optional later).

## Frontend

- Calendar page month view + announcement creation form/drawer.
- API module.

## Phase 2: Meetings (planned)

- Fields: title, description, startsAt, durationMinutes, location, visibility (open/private), memberIds.
- Meeting members table `calendar_meeting_members` (tenant-scoped) unique (eventId, userId).
- Visibility: open meetings visible to all; private meetings visible to creator + members.
- Manage: creator; or owner/manager for open meetings.
- Validation: location required; visibility required.

## Validation

- tsc backend/frontend
- lint
- smoke: create announcement visible to staff; manager/owner manage.
