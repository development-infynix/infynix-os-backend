# Menu access model

How sidebar access works in Infynix OS: a global menu catalogue, per-person grants owned by the company owner, and the UI that hides what was not granted.

- **Status:** implemented on 17 Nov 2026
- **Backend:** NestJS 12 · Drizzle ORM · PostgreSQL (Neon)
- **Frontend:** React 19 · TanStack Router/Query · Tailwind 4
- **Migration:** `drizzle/20261117062344_access_lists/migration.sql`
- **Complementary auth doc:** [userauth.md](userauth.md)

---

## 1. The model in one paragraph

Menus are **access items** in a catalogue shared by every company. A company does not copy the menu tree. Instead, each person holds **grants** into that catalogue. The company owner holds every item implicitly and is never stored in the grant table, so the owner cannot lock themselves out. Managers and staff start with no grants; the owner ticks the menus they may open in **Admin › System**. The sidebar and routes read the grants; the API session carries them as `access`.

```
access_items (global)          user_access (per company)
─────────────────────          ─────────────────────────
clients      menu   10   ◄──── user_id, access_item_id, tenant_id
crm          menu   20         granted_by, granted_at
calendar     menu   30
…                              unique (user_id, access_item_id)
                               RLS: tenant_id = app.tenant_id
```

---

## 2. Data model

### `access_items` — the catalogue

Global, not tenant-owned. Every company sees the same list.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | primary key, `gen_random_uuid()` |
| `key` | `text` | stable unique key used by code (`clients`, `crm`, …) |
| `label` | `text` | sidebar / checklist label |
| `kind` | `access_kind` enum | `menu` or `action` |
| `sort_order` | `integer` | sidebar order, default `0` |
| `is_active` | `boolean` | inactive items disappear from lists and sessions |
| `created_at`, `updated_at` | `timestamptz` | defaults `now()` |

Indexes: unique on `key`; `(kind, sort_order)`.

No RLS: the catalogue is shared. The app's owner connection seeds/edits it; runtime code only reads it.

### `user_access` — the grants

Company-owned, one row per person per item.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | primary key |
| `tenant_id` | `uuid` | FK `tenants.id`, `ON DELETE CASCADE` |
| `user_id` | `uuid` | FK `users.id`, `ON DELETE CASCADE` |
| `access_item_id` | `uuid` | FK `access_items.id`, `ON DELETE CASCADE` |
| `granted_by` | `uuid` | FK `users.id`, `ON DELETE SET NULL` |
| `granted_at` | `timestamptz` | default `now()` |

Indexes: unique `(user_id, access_item_id)`; `(tenant_id)`; `(user_id)`.

RLS policy `tenant_isolation` on `user_access`, for role `infynix_tenant`:

```sql
USING      (tenant_id = (nullif(current_setting('app.tenant_id', true), ''))::uuid)
WITH CHECK (tenant_id = (nullif(current_setting('app.tenant_id', true), ''))::uuid)
```

The app reaches this table only through `TenantDb.run(tenantId, …)`, which sets `app.tenant_id` and switches to `infynix_tenant` inside one transaction.

### Seeded menus

| `key` | `label` | `sort_order` |
|---|---|---:|
| `clients` | Clients | 10 |
| `crm` | CRM | 20 |
| `calendar` | Calendar | 30 |
| `payments-budget` | Payments & Budget | 40 |
| `project-management` | Project Management | 50 |
| `invoices` | Invoices | 60 |
| `media` | Media | 70 |

The migration inserts them with `ON CONFLICT ("key") DO UPDATE`, so re-running it would refresh labels/order without duplicating rows.

---

## 3. Authorization rules

| Rule | Implementation |
|---|---|
| Only the owner grants/revokes menus | `TenantPolicy.administer` on both member access endpoints and `GET /access/items` |
| Owner holds everything, implicitly | `AccessService.keysFor` returns every active item when `role === 'owner'`; no `user_access` rows are created |
| Owner cannot be edited through the access API | `MembersService.setAccess` answers **400** (“The owner already has access to every menu”) |
| Managers/staff start with nothing | No grants are created with a member; the empty set is valid |
| Replacing a set removes unticked menus | `AccessRepository.replaceForUser` deletes all of that person's rows, then inserts the requested set |
| Unknown or inactive keys are rejected | `AccessService.replace` resolves keys against active `kind = 'menu'` rows; any missing key fails the whole request with **400** |
| Duplicate keys are ignored | `MembersService.setAccess` trims, drops empties and de-duplicates before the transaction |
| Cross-company targets are invisible | `findOrFail` inside `TenantDb.run`; another company's id answers **404** |
| Suspended companies are refused | Existing `ActorResolver` behaviour, **403** |
| Actions are reserved | `access_kind = 'action'` exists, but the grant endpoints currently accept active **menu** keys only |

The owner check is deliberate: it is the one account that can always recover access, and there is exactly one owner per company.

---

## 4. API

Base URL: `http://localhost:3001/api/v1` (or the deployment's `/api/v1`). Errors use `{ statusCode, message, error?, errorCode? }`.

### Session responses

`POST /auth/sign-up`, `POST /auth/sign-in` and `GET /auth/me` now return:

```json
{
  "user": { "...": "..." },
  "tenant": { "...": "..." },
  "access": ["clients", "crm"]
}
```

- **Owner:** every active item key, including future action keys.
- **Manager/staff:** the active granted keys, in sidebar order.
- The frontend also short-circuits `role === "owner"` to all-access, so a stale list cannot hide menus from the owner.

`AuthController.session` fetches the tenant and the keys in parallel; `AuthModule` imports `AccessModule`.

### `GET /access/items` — owner only

Returns the active menu catalogue, ordered by `sort_order` then label:

```json
{ "items": [
  { "id": "…", "key": "clients", "label": "Clients", "kind": "menu", "sortOrder": 10, "isActive": true }
] }
```

The current grant drawer gets the catalogue from the per-member endpoint instead; this endpoint remains the clean primitive for future access screens.

### `GET /members/:id/access` — owner only

```json
{
  "items": [ { "id": "…", "key": "clients", "label": "Clients", "kind": "menu", "sortOrder": 10, "isActive": true } ],
  "accessKeys": ["clients", "crm"]
}
```

- `items` is always the full active menu catalogue.
- `accessKeys` is that person's grants.
- Owner target: returns every menu key (but the current UI does not call it for owners).
- Another company: **404**.

### `PUT /members/:id/access` — owner only

Request:

```json
{ "accessKeys": ["clients", "crm"] }
```

- Replaces the complete set; `[]` removes every menu.
- The write runs in one `TenantDb.run` transaction: delete all rows for the person, insert the new ones.
- Response: the same shape as `GET /members/:id/access`.
- **400** for an unknown/inactive menu key or for an owner target; **404** for another company; **403** for a non-owner caller.

Validation: up to 100 keys, unique, each 1–80 characters. The service trims and de-duplicates again.

---

## 5. Backend implementation

```
src/
├── db/schema.ts                  accessItems, userAccess, ACCESS_KINDS
├── access/
│   ├── access.types.ts           AccessKind, AccessItem, MemberAccess
│   ├── access.repository.ts      catalogue reads, granted keys, replace grants
│   ├── access.service.ts         owner short-circuit, key validation
│   ├── access.controller.ts      GET /access/items
│   ├── access.module.ts          exports AccessService
│   └── access.service.spec.ts    unit tests for the rules above
├── members/
│   ├── members.controller.ts     GET/PUT /members/:id/access
│   ├── members.service.ts        getAccess, setAccess, owner refusal
│   └── dto/members.dto.ts        SetMemberAccessDto
├── auth/auth.controller.ts       session includes `access`
└── auth/auth.module.ts           imports AccessModule
```

### Flow: reading a session

1. Authentication resolves the user.
2. `AuthController.session` calls `AccessService.keysFor(user)`.
3. Owner → `AccessRepository.listActive()` on the owner connection.
4. Manager/staff → `TenantDb.run(tenantId)` → `keysForUser(tx, userId)`, joining `user_access` to active `access_items` in `sort_order`.
5. The keys are returned with the user and tenant.

### Flow: changing grants

1. `PUT /members/:id/access` runs `TenantPolicy.administer` (owner).
2. `MembersService.setAccess` normalizes the keys.
3. Inside `TenantDb.run`:
   - `findOrFail` loads the target member (404 if another company);
   - owner target → 400;
   - `AccessService.replace` resolves keys to active menu ids (400 on any unknown/inactive key);
   - `AccessRepository.replaceForUser` deletes and inserts.
4. The controller returns the refreshed `{ items, accessKeys }`.

`granted_by` records the owner who granted the current set. Because replacement is delete-then-insert, historical grants are not retained; the current set and its last grantor are.

---

## 6. Frontend implementation

```
src/
├── lib/access.ts                 types, queries, setMemberAccess, hasAccess, requireAccess
├── lib/auth.ts                   Session.access
├── mainpage/components/Sidebar.tsx
├── mainpage/components/AppLayout.tsx
├── routes/_authed/{clients,crm,calendar,payments-budget,project-management,invoices,media}.tsx
├── components/EmptyState.tsx
├── admin/components/UserDetailsDrawer.tsx
└── {clients,crm,calendar,payments-budget,project-management,invoices,media}/
    ├── components/*Empty.tsx
    └── pages/*Page.tsx
```

### Access helpers

- `hasAccess(session, key)` returns true for owners, otherwise checks `session.access` defensively.
- `requireAccess(session, key)` throws a TanStack Router redirect to `/` when the key is missing.
- `memberAccessQuery(id)` loads `GET /members/:id/access`.
- `setMemberAccess(id, accessKeys)` calls `PUT` with `{ accessKeys }`.

### Sidebar

- `MAIN_NAV` holds Overview plus the seven menus, each with its `access` key.
- Overview is always rendered; feature items are filtered with `hasAccess`.
- The owner-only **System** destination is pinned at the **top of the sidebar footer**, above the account block. It uses the normal 32px nav row, has no section caption, and is separated from the account block by a full-bleed hairline. The main menu scrolls; System and the account stay put.
- Selected rows use the primary button treatment: `--btn-primary-bg` gradient, `--btn-primary-shadow` bevel, `on-primary` text, and the button hover brightness. The same treatment applies to System when it is the active route.
- The Admin area remains owner-only (`canAdminister`).

### Routes and pages

Each feature route is guarded in `beforeLoad`:

```tsx
export const Route = createFileRoute('/_authed/clients')({
  beforeLoad: ({ context }) => requireAccess(context.session, 'clients'),
  component: ClientsPage,
})
```

- The parent `_authed` route ensures a session and renders `AppLayout`.
- Missing grants redirect to `/` before the page renders.
- Each route has a page under `src/<feature>/pages/` and an empty-state component under `src/<feature>/components/`.
- Empty states share `src/components/EmptyState.tsx` and describe what will live in the module; they are not fake actions.
- `AppLayout` maps each path to its header title, including “Payments & Budget” and “Project Management”.

### Grant UI

The owner grants menus from **Admin › System → a person → Menu access**, inside the existing user details drawer.

- **Owner:** no checkboxes; a shield icon and one sentence saying owners hold every menu.
- **Manager/staff:** one row per active menu, native checkboxes with the green accent, and a caption count (“2 of 7 menus”).
- **Save access:** disabled until the set differs from the server baseline; shows a saving state; appends “· Saved” after success; server errors use the shared form error.
- Loading uses the shared `Loader`; a load failure offers **Try again**.
- The editor keeps a local baseline after saving, so the button does not flash enabled. Reopening the drawer fetches the person's current grants.
- Saving replaces the whole set; unticking removes the menu on the person's next session fetch.

---

## 7. When grants take effect

- The frontend caches `/auth/me` for **60 seconds** and refetches on window focus (React Query defaults).
- After an owner saves, the employee's sidebar and route guards update on the next session fetch, navigation that remounts the route, or reload.
- A page already open stays open until it navigates or reloads.
- The backend reads grants on every session request; there is no cached grant list on the server.

---

## 8. Security boundaries

**What grants gate today:** the sidebar items, the seven `/…` routes, and the session payload; and the grant endpoints themselves are owner-only.

**What they do not gate yet:** the feature APIs. Those modules have no endpoints in this pass. When they are built, each must authorize against the actor's granted keys rather than trusting the client. A manager who knows a URL should not be able to call a feature endpoint just because the route is hidden.

Other boundaries:

- The owner cannot be locked out: no rows are needed and the access API refuses owner targets.
- RLS keeps grants company-local even if a query forgets a tenant filter.
- The catalogue is global and read-only at runtime; the API cannot invent menu keys.
- Inactive items disappear from sessions, the drawer catalogue and granted keys, without deleting the grant rows.
- `granted_by` provides a last-grantor audit trail; replacement means only the current set is recorded.
- Email uniqueness remains cross-tenant (existing limitation, unchanged here).

---

## 9. Adding a menu

1. **Catalogue row.** Add a migration inserting the active item with a stable unique `key`, `label`, `kind = 'menu'` and a `sort_order`. Do not rename a key after grants exist; add a new key and retire the old one.
2. **Backend feature.** Build the endpoints and authorize them against the actor's access keys as part of that work.
3. **Frontend module.** Create `src/<key>/components/` and `src/<key>/pages/`, then a guarded route at `src/routes/_authed/<key>.tsx` using `requireAccess`.
4. **Navigation.** Add the item to `MAIN_NAV` in `Sidebar.tsx` with its key and icon, and add the path to `TITLES` in `AppLayout.tsx`.
5. **Grant UI.** No change needed: the drawer reads the active catalogue and renders the new row automatically.
6. **Tests.** Extend the access service tests where the rule applies, and verify the route guard and sidebar with a granted and a non-granted session.

The action kind is reserved for future per-action permissions. Today the grant endpoints only resolve `kind = 'menu'`.

---

## 10. Operations

### Apply the migration

```bash
cd infynix-os-backend
pnpm db:migrate
```

- Uses `DATABASE_URL_UNPOOLED` (the direct connection).
- Deploy the backend **after** the migration, or `/auth/me` will fail with `relation "access_items" does not exist` and every signed-in screen will show a 500.
- No new environment variables, secrets or scheduled jobs.
- The menu seed is idempotent; no separate seed step is needed.

### Verify

```sql
select key, label, kind, sort_order, is_active
from access_items
order by sort_order;

select count(*) from user_access;
```

The first query must return the seven menus. The second starts at 0 for a fresh install; grants appear as the owner ticks menus.

### Rollback

Reverting the feature requires dropping `user_access` and `access_items` and the `access_kind` enum, then removing the backend/frontend code. This is destructive: grants are lost. Prefer deactivating the affected catalogue rows if the tables must stay.

---

## 11. Verification performed

- **Backend:** `pnpm test` → 5 files, 22 tests passing, including the access service rules; `pnpm lint` and `pnpm build` clean.
- **Frontend:** `pnpm lint` clean except the pre-existing `__root.tsx` fast-refresh warning; `pnpm build` clean; the route tree regenerated.
- **Runtime smoke (Playwright, mocked API):**
  - staff with only `clients` saw Overview and Clients, no CRM, no System, and `/crm` redirected to `/`;
  - owner saw all seven menus plus System and the grant drawer showed “2 of 7 menus” for a manager;
  - no console errors.
- **Database:** the migration was applied to the configured database; the seven catalogue rows are present and `/auth/me` no longer returns the missing-table 500.
- **Not covered:** an automated e2e test of the grant endpoints against the real database, and feature-API authorization (the APIs do not exist yet).

---

## 12. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `/auth/me` 500, `relation "access_items" does not exist` | Migration not applied. Run `pnpm db:migrate`, then reload. |
| Signed-in employee sees only Overview | No grants, or the grant is for an inactive item. Tick menus in Admin › System. |
| A newly granted menu is still missing | The employee's `/auth/me` is cached up to 60s; refocus the window or reload. |
| A route redirects to `/` despite a grant | The route key and the catalogue key differ, or the session payload is stale. |
| `PUT /members/:id/access` → 400 | Unknown/inactive key, or the target is the owner. |
| `GET/PUT /members/:id/access` → 404 | The person is not in the caller's company. |
| Grant drawer says it could not load | The owner-only endpoint rejected the session, or the member was deleted. Use **Try again**. |
| Grant appears in the drawer but not for the employee | Confirm they signed in again / window refocused; grants are read on session requests, not pushed. |

---

## 13. Possible next steps

- Authorize each feature API against the actor's access keys; add a reusable guard/decorator so a new module cannot forget it.
- Add an audit view for `granted_by` / `granted_at`, or an append-only grant history if compliance needs it.
- Per-company catalogue customisation (today the catalogue is global) if customers need different menu names or extra modules.
- Action-level grants (the `action` kind) once there are actions worth granting separately from a menu.
- Wiring the unused `GET /access/items` into a dedicated access overview if the drawer becomes too small.
