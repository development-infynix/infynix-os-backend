# Reports Module Plan (multitenant) — Implemented

Port the daily Reports feature from the erp project into infynixos, adapted to the existing multitenant architecture (TenantDb + RLS, owner/manager/staff roles, menu grants).

## Status

- Backend: implemented and typecheck/lint clean; DB tables created.
- Frontend: reports API module + ReportsPage with list and create form.

## Backend

Schema (`src/db/schema.ts`): tenant-scoped `reports` and `report_settings` using `pgTable.withRLS` + `tenantIsolation`.

- reports: uuid id, tenant_id, report_date (date), report_items jsonb string[], created_by uuid (composite FK to users tenant/id), submitted_at, updated_at, edited_at, attachment_type ('url'|null), attachment_url, remarks. Unique (tenant_id, created_by, report_date).
- report_settings: tenant_id (PK), due_time (time, default 21:00), skip_days smallint[], updated_by, updated_at. Composite FK to users.

Module (`src/reports`): imports TenancyModule + AccessModule; providers repository, service, policy, controller. Exports repository/service.

Policy `ReportsPolicy.use`: owner always; others require `reports` menu grant via AccessService.keysFor.

Repository: tenant-scoped CRUD inside TenantDb; page with filters/pagination; find; create; update; updateRemarks; remove; get/upsert settings; findExistingForDate; off-day check in service.

Service: assertCanUseReports (staff/manager/owner + menu grant for non-owners). Elevated = owner only. Non-elevated scoped to own reports. Validation: 1-100 items, 1-5000 chars, URL validation (http/https), off-day check, duplicate date check, 15-min edit window, remarks owner-only. Settings readable by all reports users; update owner-only.

Controller: /reports routes: GET list, GET settings, PATCH settings, GET :id, POST, PATCH :id, PATCH :id/remarks, DELETE :id. Settings declared before :id.

## Frontend

- `src/reports/api.ts`: list, get, create, update, remove, getSettings, updateSettings, updateRemarks.
- `src/reports/pages/ReportsPage.tsx`: list with design tokens, create form.

## Validation

- Backend `npx tsc --noEmit` clean.
- Backend lint clean for reports.
- Frontend `npx tsc -b` clean.
EOF
echo done