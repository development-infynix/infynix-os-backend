# Users, Companies & Authentication

How sign-up, sign-in, companies (tenants), roles, menu access and data isolation work in the Infynix API.

- **Stack:** NestJS 12 · `@nestjs/authentication` (sessions, password hashing) · `@nestjs/authorization` (policies) · `@nestjs/drizzle` + Drizzle ORM · PostgreSQL on Neon
- **Base URL:** local `http://localhost:3001/api/v1`; production `https://infynixos.pages.dev/api/v1`, which the frontend's Cloudflare proxy forwards to the backend on Stackshift (see §5 and `../../servers.md`)

---

## 1. Model

Infynix OS is a multi-tenant SaaS with a simple shape:

1. A business signs up on the public sign-up page. That creates **one company (tenant) and its owner account**.
2. Inside the app the owner **adds employees** in **Admin › System** (route `/admin/users`) by setting their name, email, password and role.
3. **Each person belongs to exactly one company** (`users.tenant_id`, `users.role`). Everyone signs in on the same page with their email. The company comes from who signed in, so URLs are plain (`/`, `/members`).
4. **The owner decides which menus everyone else sees.** Each menu (Clients, CRM, Calendar, Payments & Budget, Project Management, Invoices, Media) is an access item, granted per person in **Admin › System**. See §9.

| Table | What | Isolation |
|---|---|---|
| `tenants` | a company (name, status, plan) | looked up from the signed-in person's `tenant_id` |
| `users` | a person: company, role, login | **row-level security on `tenant_id`** |
| `sessions` | browser sessions | per person |
| `access_items` | the menu catalogue (global, shared by all companies) | read-only catalogue; grants are per company |
| `user_access` | which access items a person holds | **row-level security on `tenant_id`** |

---

## 2. Roles & permissions

| Action | owner | manager | staff |
|---|:-:|:-:|:-:|
| Use the app | ✅ | ✅ | ✅ |
| See the **Admin** menu (sidebar) and its pages | ✅ | ❌ | ❌ |
| Create, edit, deactivate, set the password of, or remove users | ✅ | ❌ | ❌ |
| Open every feature menu | ✅ | granted only | granted only |
| Grant or revoke feature menus for managers and staff | ✅ | ❌ | ❌ |

The Admin menu isn't rendered for managers or staff, the `/admin` routes send them home, and the API refuses them (403). All three checks hold independently. Feature menus follow grants: the sidebar hides them, the routes redirect home, and the session carries the granted keys. Owners hold every menu implicitly and cannot be edited through the grant endpoints.

**Platform admin** (`users.is_platform_admin`): Infynix staff. Reserved for the future platform console, where companies are listed and suspended.

Rules (`MembersService`; policy in `src/tenancy/tenant.policy.ts`):

- **One owner per company**: whoever signed it up. Users created in Admin are **managers or staff**; the API refuses `role: "owner"` (400).
- You can't change your own role, deactivate yourself or remove yourself.
- A company always keeps **at least one active owner** (409).
- Deactivating someone or setting their password **signs them out everywhere**. A role change applies on their next request, because the role is read on every request.
- People in other companies are invisible: acting on their id answers **404**.
- People in a **suspended** company can't sign in (403). Platform admins are exempt.

---

## 3. Data isolation (row-level security)

`users` and `user_access` have a Postgres policy:

```sql
USING (tenant_id = current_setting('app.tenant_id')::uuid)   -- for role infynix_tenant
```

`access_items` is deliberately global (the menu catalogue: key, label, kind, sort order), so it has no RLS. It is readable by `infynix_tenant`; only the owner connection seeds or edits it.

- The app's connection role (`neondb_owner`) **bypasses** RLS. Company-scoped work therefore goes through `TenantDb.run(tenantId, tx => …)` (`src/db/tenant-db.ts`). It opens a transaction, sets `app.tenant_id` and switches to the restricted, non-login role **`infynix_tenant`** with `SET LOCAL ROLE`. Both settings are `LOCAL`, so they end with the transaction, which keeps them safe behind Neon's pgbouncer pooler.
- Inside `run()`, a query can't see or write another company's rows, even with no `WHERE` clause.
- Outside `run()`, the owner connection is used. Keep that to lookups that must work before a company is known: sign-in, session validation, the person's own profile and sign-up.

`test/tenant-isolation.e2e-spec.ts` proves this against the real database. Each company sees only its own people. It can't read, insert, update or delete another company's people. Nothing is visible when no company is set, and the setting never leaks into the next pooled transaction.

### Adding a company-owned table

1. In `src/db/schema.ts`, define it with `pgTable.withRLS(...)`, a `tenantId` column and `tenantIsolation(t.tenantId)` (see `users`).
2. Run `pnpm db:generate --name <change>`.
3. Append to the generated SQL: `GRANT SELECT, INSERT, UPDATE, DELETE ON "<table>" TO "infynix_tenant";`. Never use `ALTER DEFAULT PRIVILEGES`, which would also open global tables.
4. Access it only through `TenantDb.run()`, and extend the isolation test.

---

## 4. Password policy

Defined once in `src/auth/password-policy.ts`; the frontend mirrors it in `src/lib/password-rules.ts`.

- 8–128 characters.
- At least one uppercase letter, one lowercase letter, one number and one special character.
- No spaces.

Sign-in doesn't check these rules, so tightening them later never locks anyone out.

---

## 5. Sessions

| Setting | Env var | Default |
|---|---|---|
| Absolute lifetime | `SESSION_ABSOLUTE_TTL` | `7d` |
| Idle timeout | `SESSION_IDLE_TTL` | `1d` |
| Origins allowed to use the cookie for writes, sign-in and sign-up (also the CORS list) | `CORS_ORIGINS` | `http://localhost:5173` |

- The cookie is `__Host-sid` (`HttpOnly`, `Secure`, `SameSite=Lax`), and only its SHA-256 is stored.
- Sign-in replaces the browser's previous session.
- CORS allows `GET, HEAD, POST, PUT, PATCH, DELETE` with credentials. Fastify's default is GET/HEAD/POST only.
- The frontend sends `credentials: 'include'`, and sets `Content-Type: application/json` **only when there is a body**: Fastify rejects an empty JSON body with a 400.

### `CORS_ORIGINS`

- A comma-separated list of exact origins, e.g. `https://infynixos.pages.dev,http://localhost:5173`. It's parsed once in `src/config/origins.ts` and used for both CORS and the session's trusted origins.
- Spaces and trailing slashes are tidied up. **`*` is never allowed**, because the API uses cookies and a wildcard would let any website act as a signed-in user. `*` and malformed entries (paths, missing scheme) are skipped with a warning instead of crashing startup.
- Startup logs `[config] allowed origins: …`, showing what the deployment actually received.

### Cookies in production (same-site rule)

- The browser only sends `__Host-sid` back to the site that set it. If the frontend called the backend's own domain (`*.stackshift.cloud`) from `infynixos.pages.dev`, the cookie would be cross-site and never sent. Sign-in would appear to work, then every request would get `401 missing_credentials` and a refresh would sign you out.
- So production builds of the frontend always call **same-origin `/api/v1`** (`frontend/src/lib/api.ts`). The Cloudflare Pages Function `frontend/functions/api/[[path]].ts` proxies those calls to the backend, passing cookies and `Set-Cookie` through. `VITE_API_URL` only applies in development.

---

## 6. API

Errors have the shape `{ statusCode, message, error?, errorCode? }`.

### Auth: `/auth`

| Method & path | Who | Notes |
|---|---|---|
| `POST /auth/sign-up` `{companyName, fullName, email, password}` | public | `201 { user, tenant, access }` + cookie. 409 if the email is in use, 400 for a weak password |
| `POST /auth/sign-in` `{email, password}` | public | `200 { user, tenant, access }` + cookie. 401 for wrong credentials, 403 for a deactivated person or suspended company |
| `POST /auth/sign-out` | public | `204`; ends the session on the server |
| `GET /auth/me` | signed in | `{ user, tenant, access }` (`user.role`, `user.tenantId`) |
| `PATCH /auth/me` `{fullName}` | signed in | Changes your own name |
| `POST /auth/change-password` `{currentPassword, newPassword}` | signed in | `204`; ends your other sessions |

### Admin › System: `/members` (owner only)

| Method & path | Notes |
|---|---|
| `GET /members?page=1&pageSize=50` | `{ items: Member[], total, page, pageSize, totalPages }`. Oldest first; `pageSize` 1–100, default 50 |
| `GET /members/search?q=priya&limit=20` | `{ items: Member[] }`. Name or email contains `q` (1–100 chars, `%`/`_` matched literally); names starting with `q` first. `limit` 1–50, default 20 |
| `GET /members/:id` | `Member`; 404 if not in your company |
| `POST /members` `{fullName, email, password, role}` | `201 Member`. 409 if the email is in use |
| `PATCH /members/:id` `{fullName?, email?, role?, isActive?}` | Rules in §2. 409 if the new email is in use |
| `PUT /members/:id/password` `{password}` | `204`; signs them out |
| `DELETE /members/:id` | `204`; deletes the account |
| `GET /members/:id/access` | `{ items: AccessItem[], accessKeys: string[] }`; 404 for another company, 400 for the owner |
| `PUT /members/:id/access` `{accessKeys: string[]}` | Replaces the whole set. `{ items, accessKeys }`. Unknown or inactive keys → 400; the owner → 400 |

### Access: `/access`

| Method & path | Who | Notes |
|---|---|---|
| `GET /access/items` | owner only | `{ items: AccessItem[] }`; the active menu catalogue, ordered by `sortOrder` |

`Member` is `{ id, email, fullName, role, isActive, lastLoginAt, createdAt }`.
`AccessItem` is `{ id, key, label, kind: "menu" | "action", sortOrder, isActive }`.
`access` on sign-in/sign-up/me is a `string[]` of access keys. For the owner it lists every active item; for everyone else it lists their grants. The frontend treats `role === "owner"` as all-access even if the list is stale.

---

## 7. Database & setup

Migrations in `drizzle/`:

- `…_init_auth_users`
- `…_multitenancy`: tenants, the RLS role and grants
- `…_single_company_users`: people carry `tenant_id` and `role`, and RLS moves onto `users`
- `…_access_lists`: `access_items`, `user_access`, RLS on grants, the seven menu rows and the `infynix_tenant` grants

```bash
pnpm db:migrate   # apply migrations (uses DATABASE_URL_UNPOOLED)
pnpm db:seed      # the Infynix company + its owner/platform admin from SEED_SUPERADMIN_* (SEED_TENANT_NAME)
pnpm test         # unit tests (policy, passwords, access)
pnpm test:e2e     # includes the tenant-isolation test against the database
```

`.env` holds two connection strings:

- `DATABASE_URL`: Neon **pooled**, used by the app.
- `DATABASE_URL_UNPOOLED`: direct, used by migrations and the seed.

`sslmode=require` verifies the server certificate against the system CAs, and `channel_binding=require` is honoured.

---

## 8. Code map

```
src/
├── app.module.ts             Drizzle, sessions, authorization (getUser → ActorResolver)
├── main.ts                   Fastify, helmet, CORS (incl. PUT/PATCH/DELETE)
├── config/origins.ts         CORS_ORIGINS → exact origin list (no '*'), logged at startup
├── db/
│   ├── schema.ts             tenants, users (RLS), sessions, roles, accessItems, userAccess (RLS)
│   ├── tenant-db.ts          TenantDb.run(): the only door to company-owned rows
│   ├── errors.ts             isUniqueViolation (unwraps Drizzle errors)
│   └── pg-config.ts, migrate.ts, seed-superadmin.ts
├── access/
│   ├── access.repository.ts  menu catalogue + a person's granted keys
│   ├── access.service.ts     owner = all keys; replace a set, validate keys
│   └── access.controller.ts  GET /access/items (owner only)
├── auth/                     sign-up/in/out, me, session store, password policy; session includes access keys
├── tenancy/
│   ├── actor.resolver.ts     signed-in user → { user, tenant }; suspended → 403
│   ├── tenant.policy.ts      who may manage whom
│   └── tenants.repository.ts company lookup; sign-up creates company + owner
├── members/                  /members: list, search, get, add, edit, password, remove, get/set access (all through TenantDb)
└── users/                    own-account lookups (sign-in, session, profile)
```

To protect a company route: add `@Can(TenantPolicy, '<ability>')`, read `@CurrentActor()`, and do the data work inside `TenantDb.run(actor.tenant.id, …)`.

---

## 9. Menus & access

Full implementation details, API shapes, frontend behaviour and operations: [access-model.md](access-model.md).

Access is a **catalogue plus grants**, not a per-company copy of the menu tree.

- **Catalogue.** `access_items` is global and shared by every company: `key` (stable, unique, e.g. `clients`), `label` (sidebar text), `kind` (`menu` or `action`), `sort_order`, `is_active`. The seven menus ship in migration `…_access_lists`:

  | key | label | sort |
  |---|---|---:|
  | `clients` | Clients | 10 |
  | `crm` | CRM | 20 |
  | `calendar` | Calendar | 30 |
  | `payments-budget` | Payments & Budget | 40 |
  | `project-management` | Project Management | 50 |
  | `invoices` | Invoices | 60 |
  | `media` | Media | 70 |

- **Grants.** `user_access` holds one row per person per item (`tenant_id`, `user_id`, `access_item_id`, `granted_by`, `granted_at`), unique on `(user_id, access_item_id)` and protected by RLS. Managers and staff start with **no** grants; the owner is never stored, because the owner holds every item implicitly (`role === 'owner'` short-circuits in `AccessService.keysFor`).
- **Replacing a set.** `PUT /members/:id/access` deletes that person's rows and inserts the requested keys inside one `TenantDb.run` transaction, so removing a tick removes the menu. Keys are de-duplicated, looked up in the active catalogue, and any unknown/inactive key rejects the whole request (400).
- **What grants gate today.** The sidebar renders only granted menus (Overview is always present, Admin stays owner-only), the seven routes redirect to `/` without the grant, and the session response carries `access` so the frontend can decide without an extra request. **The feature APIs are not authorized by menu yet** — a manager who knows a feature endpoint could still call it. Add `@Can(...)`/`keysFor` checks in each feature module when those APIs are built.
- **Freshness.** A grant change applies to the employee on their next session fetch (the frontend caches `/auth/me` for 60 seconds and refetches on window focus). Existing pages stay open until they navigate or reload.

### Adding a menu

1. Insert the row (a migration is cleanest): unique `key`, `label`, `kind = 'menu'`, `sort_order`, `is_active = true`.
2. Create the frontend folder under `src/<key>/` with `components/` and `pages/`, and a guarded route in `src/routes/_authed/<key>.tsx` using `requireAccess`.
3. Add it to `MAIN_NAV` in `src/mainpage/components/Sidebar.tsx` (key + icon) and to `TITLES` in `AppLayout.tsx`.
4. The Admin user drawer reads the catalogue automatically, so no grant UI change is needed.

---

## 10. Next

- Email via **Resend**: a real forgot-password flow (today `/forgot-password` explains that the company owner sets a new one), and optionally emailed invitations instead of starting passwords.
- A platform admin console to list and suspend companies.
- Before launch: rate limiting on sign-in and sign-up (`@nestjs/throttler`).
