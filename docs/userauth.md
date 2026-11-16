# Users, Companies & Authentication

How sign-up, sign-in, companies (tenants), roles and data isolation work in the Infynix API.

- **Stack:** NestJS 12 · `@nestjs/authentication` (sessions, password hashing) · `@nestjs/authorization` (policies) · `@nestjs/drizzle` + Drizzle ORM · PostgreSQL on Neon
- **Base URL:** `http://localhost:3001/api/v1`

---

## 1. Model

Infynix OS is a multi-tenant SaaS with a simple shape:

1. A business signs up on the public sign-up page. That creates **one company (tenant) and its owner account**.
2. Inside the app the owner **adds employees** in **Admin › Users** by setting their name, email, password and role.
3. **Each person belongs to exactly one company** (`users.tenant_id`, `users.role`). Everyone signs in on the same page with their email. The company comes from who signed in, so URLs are plain (`/`, `/members`).

| Table | What | Isolation |
|---|---|---|
| `tenants` | a company (name, status, plan) | looked up from the signed-in person's `tenant_id` |
| `users` | a person: company, role, login | **row-level security on `tenant_id`** |
| `sessions` | browser sessions | per person |

---

## 2. Roles & permissions

| Action | owner | manager | staff |
|---|:-:|:-:|:-:|
| Use the app | ✅ | ✅ | ✅ |
| See the **Admin** menu (sidebar) and its pages | ✅ | ❌ | ❌ |
| Create, edit, deactivate, set the password of, or remove users | ✅ | ❌ | ❌ |

The Admin menu isn't rendered for managers or staff, the `/admin` routes send them home, and the API refuses them (403). All three checks hold independently.

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

`users` has a Postgres policy:

```sql
USING (tenant_id = current_setting('app.tenant_id')::uuid)   -- for role infynix_tenant
```

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
| Origins allowed to use the cookie for writes, sign-in and sign-up | `CORS_ORIGINS` | `http://localhost:5173` |

- The cookie is `__Host-sid` (`HttpOnly`, `Secure`, `SameSite=Lax`), and only its SHA-256 is stored.
- Sign-in replaces the browser's previous session.
- CORS allows `GET, HEAD, POST, PUT, PATCH, DELETE` with credentials. Fastify's default is GET/HEAD/POST only.
- The frontend sends `credentials: 'include'`, and sets `Content-Type: application/json` **only when there is a body**: Fastify rejects an empty JSON body with a 400.

---

## 6. API

Errors have the shape `{ statusCode, message, error?, errorCode? }`.

### Auth: `/auth`

| Method & path | Who | Notes |
|---|---|---|
| `POST /auth/sign-up` `{companyName, fullName, email, password}` | public | `201 { user, tenant }` + cookie. 409 if the email is in use, 400 for a weak password |
| `POST /auth/sign-in` `{email, password}` | public | `200 { user, tenant }` + cookie. 401 for wrong credentials, 403 for a deactivated person or suspended company |
| `POST /auth/sign-out` | public | `204`; ends the session on the server |
| `GET /auth/me` | signed in | `{ user, tenant }` (`user.role`, `user.tenantId`) |
| `PATCH /auth/me` `{fullName}` | signed in | Changes your own name |
| `POST /auth/change-password` `{currentPassword, newPassword}` | signed in | `204`; ends your other sessions |

### Admin › Users: `/members` (owner only)

| Method & path | Notes |
|---|---|
| `GET /members` | `{ items: Member[] }` |
| `POST /members` `{fullName, email, password, role}` | `201 Member`. 409 if the email is in use |
| `PATCH /members/:id` `{fullName?, role?, isActive?}` | Rules in §2 |
| `PUT /members/:id/password` `{password}` | `204`; signs them out |
| `DELETE /members/:id` | `204`; deletes the account |

`Member` is `{ id, email, fullName, role, isActive, lastLoginAt, createdAt }`.

---

## 7. Database & setup

Migrations in `drizzle/`:

- `…_init_auth_users`
- `…_multitenancy`: tenants, the RLS role and grants
- `…_single_company_users`: people carry `tenant_id` and `role`, and RLS moves onto `users`

```bash
pnpm db:migrate   # apply migrations (uses DATABASE_URL_UNPOOLED)
pnpm db:seed      # the Infynix company + its owner/platform admin from SEED_SUPERADMIN_* (SEED_TENANT_NAME)
pnpm test         # unit tests (policy, passwords)
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
├── db/
│   ├── schema.ts             tenants, users (RLS), sessions, roles
│   ├── tenant-db.ts          TenantDb.run(): the only door to company-owned rows
│   ├── errors.ts             isUniqueViolation (unwraps Drizzle errors)
│   └── pg-config.ts, migrate.ts, seed-superadmin.ts
├── auth/                     sign-up/in/out, me, session store, password policy
├── tenancy/
│   ├── actor.resolver.ts     signed-in user → { user, tenant }; suspended → 403
│   ├── tenant.policy.ts      who may manage whom
│   └── tenants.repository.ts company lookup; sign-up creates company + owner
├── members/                  /members (everything through TenantDb)
└── users/                    own-account lookups (sign-in, session, profile)
```

To protect a company route: add `@Can(TenantPolicy, '<ability>')`, read `@CurrentActor()`, and do the data work inside `TenantDb.run(actor.tenant.id, …)`.

---

## 9. Next

- Email via **Resend**: a real forgot-password flow (today `/forgot-password` explains that the owner or a manager sets a new one), and optionally emailed invitations instead of starting passwords.
- A platform admin console to list and suspend companies.
- Before launch: rate limiting on sign-in and sign-up (`@nestjs/throttler`).
