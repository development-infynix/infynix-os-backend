# Servers & deployment: problems we hit and how we fixed them

Last updated: 2026-11-17

## Current setup

```
Browser
  │  https://infynixos.pages.dev/api/v1/…
  ▼
Frontend: Cloudflare Pages (infynixos.pages.dev)
  │  functions/api/[[path]].ts forwards every /api/* request
  ▼
Backend: Stackshift (infynix-os-backend.stackshift.cloud), NestJS + Fastify
  │
  ▼
Database: Neon Postgres (pooled URL for the app, direct URL for migrations/seed)
```

| Piece | Where | Repo | Key settings |
|---|---|---|---|
| Frontend | Cloudflare Pages: `https://infynixos.pages.dev` | `development-infynix/infynix-os-frontend` | Build `pnpm build`, output `dist`, `NODE_VERSION=22`. Optional `API_ORIGIN` overrides the proxy target |
| Backend | Stackshift: `https://infynix-os-backend.stackshift.cloud` | `development-infynix/infynix-os-backend` | `DATABASE_URL` (Neon **pooled**), `CORS_ORIGINS=https://infynixos.pages.dev,http://localhost:5173` |
| Database | Neon (eu-central-1) | — | `DATABASE_URL_UNPOOLED` is only for `migrate` / `seed`, run locally |

- **Health check:** `https://infynix-os-backend.stackshift.cloud/api/v1/health` or `https://infynixos.pages.dev/api/v1/health` (through the proxy). Both should return `{"status":"ok"}`.
- **`/` returns 404 `Cannot GET /` by design.** The API lives under `/api/v1`.

---

## Problems and solutions

### 1. Stackshift database unreachable
- **Symptom:** migrations failed with `ENOENT` / host not found. The Stackshift DB used an internal hostname and needed a CA file we didn't have.
- **Fix:** moved the database to **Neon**. `src/db/pg-config.ts` turns `sslmode=require` into "verify against system CAs" and maps `channel_binding`.
- **Rule:** the app uses the **pooled** URL (`DATABASE_URL`). Migrations and seed use the **direct** URL (`DATABASE_URL_UNPOOLED`).

### 2. pnpm refused to run tsx / drizzle-kit
- **Symptom:** the scripts failed because esbuild's install script was blocked.
- **Fix:** approve esbuild under `allowBuilds` in `pnpm-workspace.yaml`.

### 3. Migrations dropped data / asked rename questions
- **Symptom:** `drizzle-kit generate` asked "rename or create?" interactively. Generated SQL dropped columns before moving their data.
- **Fix:** generate with `--hints`, then hand-edit the SQL so data moves (backfills) run **before** column drops. Add grants by hand, e.g. `GRANT … ON "users" TO "infynix_tenant"`.

### 4. Sign-out did nothing
- **Symptom:** the UI signed out, but the session stayed valid.
- **Cause:** the frontend sent `Content-Type: application/json` with an **empty body**. Fastify rejects that with a 400.
- **Fix:** `src/lib/api.ts` only sends the JSON header when there's a body. The sidebar now awaits sign-out.

### 5. CORS blocked PATCH / PUT / DELETE
- **Symptom:** editing, resetting passwords and deleting failed in the browser with CORS errors.
- **Cause:** `@fastify/cors` allows only GET/HEAD/POST by default.
- **Fix:** `main.ts` lists `methods: ['GET','HEAD','POST','PUT','PATCH','DELETE']`.

### 6. Duplicate email returned 500 instead of 409
- **Cause:** Drizzle wraps the Postgres error, so code `23505` sits in `.cause`.
- **Fix:** `src/db/errors.ts` `isUniqueViolation` walks the `.cause` chain.

### 7. Port already in use (EADDRINUSE) locally
- **Cause:** an old backend process was still running.
- **Fix:** stop the old process and start one again. **The developer runs and restarts the backend (`pnpm dev`). Tools/assistants must not start, stop or restart it.**

### 8. Vercel detected the backend as Vite
- **Cause:** `vite` is in devDependencies (used by Vitest), so Vercel guessed Vite.
- **Fix at the time:** `backend/vercel.json` with `"framework": "nestjs"`. Vercel was later dropped for the backend (see 10).

### 9. Backend crashed on startup: `"*" is not an origin`
- **Symptom:** `500 INTERNAL_FUNCTION_INVOCATION_FAILED`. Logs showed `TypeError: session.trustedOrigins: "*" is not an origin`.
- **Cause:** `CORS_ORIGINS=*`. The API uses sign-in cookies, so the auth library refuses a wildcard: it would let any website act as a signed-in user. A JWT backend with `credentials: false` (like `erpnestbackend`) can use `*`; this one can't.
- **Fix:** set exact origins, e.g. `https://infynixos.pages.dev,http://localhost:5173`. `src/config/origins.ts` now:
  - trims spaces and trailing slashes
  - **skips** `*` and malformed entries with a warning instead of crashing
  - logs `[config] allowed origins: …` at startup
- **Gotcha:** environment variables are baked into each deployment. After changing one, **redeploy**, and test the new deployment's URL, not an old one.

### 10. Moved off Vercel
- The backend went to **Stackshift** and the frontend to **Cloudflare Pages**. `frontend/vercel.json` is a leftover and is unused.

### 11. Signed in, but refresh logged out and users list returned 401
- **Symptom:** `401 {"errorCode":"missing_credentials"}` on `/api/v1/members`. After a refresh you were back on the login page.
- **Cause:** the frontend called `https://infynix-os-backend.stackshift.cloud` **directly**. From `infynixos.pages.dev` that's a different site, so the browser kept the `__Host-sid` cookie but never sent it back (SameSite=Lax, cross-site).
- **Fix:**
  1. `frontend/functions/api/[[path]].ts` is a Cloudflare Pages Function that proxies `/api/*` to Stackshift, passing cookies, headers, body and `Set-Cookie` through. The cookie becomes first-party to `infynixos.pages.dev`.
  2. `src/lib/api.ts`: production builds **always** call same-origin `/api/v1`. `VITE_API_URL` only applies in dev (`import.meta.env.DEV`). This was needed because the Cloudflare `VITE_API_URL` variable still pointed at Stackshift and got baked into the build.
- **How to verify:** in the browser Network tab, API calls must go to `infynixos.pages.dev/api/v1/…`, never `stackshift.cloud`.

---

## Checklists

**After changing an environment variable**
- [ ] Saved for the right environment (Production, and Preview if used)
- [ ] Not stored as a *secret*: Cloudflare doesn't expose secrets to the build
- [ ] Redeployed (frontend: `VITE_*` values are baked in at build time)
- [ ] Tested the new deployment, not an old deployment URL

**Before deploying**
- [ ] Never commit `.env`, certificates or real passwords (tests use sample passwords like `Sample@2026x`)
- [ ] Don't put `SEED_*` variables on servers; seed locally against the direct Neon URL
- [ ] Backend `CORS_ORIGINS` lists every frontend origin exactly (no `*`, no paths)

**Still to do**
- [ ] Rotate the Neon database password and the admin account password (both were shared in chat)
- [ ] Delete the unused `VITE_API_URL` from Cloudflare and `vercel.json` from the frontend repo
- [ ] Add rate limiting on sign-in before selling to other companies
