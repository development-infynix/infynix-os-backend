# Request performance: round trips

Why requests in Infynix OS are slow when they are, and the rules that keep new endpoints and pages fast.

- **Status:** rules adopted 20 Nov 2026, after fixing the CRM board, the CRM pipeline list and the clients bulk actions
- **Backend:** NestJS · Drizzle ORM · PostgreSQL (Neon) · `TenantDb.run()` with row-level security
- **Frontend:** React · TanStack Router/Query
- **Examples in code:** `CrmRepository.boardColumns`, `CrmRepository.pipelineSummaries`, `ClientsRepository.page`, `ClientsRepository.removeMany`, `ClientImportsRepository.deleteClientChunk`
- **Tests that cover the raw SQL:** `test/crm-move.e2e-spec.ts`, `test/clients-bulk.e2e-spec.ts`

---

## 1. The problem in one paragraph

A request's speed is set by **how many queries it sends to the database one after another**, not by how expensive those queries are. From a developer machine to Neon each round trip costs about **165 ms**, while a typical query runs in **under 1 ms** (loading 100 cards from a 500-card stage: 0.4 ms). A request that makes 18 round trips therefore takes about 3 seconds no matter how well indexed it is. In production the backend sits closer to the database, so each trip is cheaper, but the count still multiplies.

| Request | Before | After | Change |
|---|---|---|---|
| CRM board (6 stages, 500 deals) | ~18 trips, ~3.0 s | ~6 trips, ~1.0 s | Board in one query |
| CRM pipeline list | 6 trips, ~1.16 s | 4 trips, ~0.64 s | Pipelines with stages nested; count only when empty |
| Clients list | 5 trips, ~0.84 s | 4 trips, ~0.66 s | Total via `count(*) over ()` |
| Delete a 5,000-client import | ~8 trips × 50 requests, ~65 s | 4 trips × 10 requests, ~7 s (estimate) | One statement per chunk; chunks of 500 |
| Delete 5,000 selected clients | ~15 trips × 10 requests, ~25 s | 4 trips × 10 requests, ~7 s (estimate) | One statement per request |

Timings were measured from a developer machine by calling the services directly. The two delete rows are estimates from trip counts.

---

## 2. Where the extra round trips came from

### 2.1 Every request has a fixed cost

`TenantDb.run()` wraps each request in a transaction: `BEGIN`, a setup statement (the company id for row-level security plus the restricted `infynix_tenant` role), your queries, `COMMIT`. That is three trips before any real work. The setup used to be two statements; it is now one:

```ts
sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('role', 'infynix_tenant', true)`
```

### 2.2 Queries in one transaction cannot overlap

A transaction runs on a single connection, and a connection runs one query at a time. `Promise.all` inside `TenantDb.run()` **does not** make queries parallel: they queue. node-postgres even warns about it ("Calling client.query() when the client is already executing a query is deprecated").

### 2.3 A query per item

Loops that query per item make the trip count grow with the data:

- the board fetched each stage's cards and count separately: 2 queries × 6 stages
- bulk delete found, deleted and updated counts per group of 100 ids, and once per affected import

### 2.4 Separate check, read and count queries

"Does the import exist?", then "delete a batch", then "update its count", then "count what is left" is four trips for one action.

### 2.5 Frontend waterfalls

The CRM page waited for the pipeline list before requesting the board, so the two requests ran back to back instead of side by side.

---

## 3. Rules for new code

### 3.1 Backend

1. **Count the round trips.** Aim for about 4 per request: `BEGIN`, setup, the work, `COMMIT`. A trip count that grows with the number of rows or items is a bug.
2. **No queries inside loops.** Use one set-based statement: `where id = any(array[...]::uuid[])`, `group by`, or a `lateral` join for "first N per group".
3. **Fetch a page and its total together** with a window count, which is computed before `LIMIT`:

   ```sql
   select ..., count(*) over () as total from clients where ... order by ... limit 50 offset 0
   ```

   An empty page carries no total. For page 1 that means zero; for a later page, run the count only then.

4. **Do a write and its follow-up updates in one statement** with data-modifying CTEs. They always run, even when the final `select` doesn't reference them:

   ```sql
   with gone as (delete from clients where id = any(...) returning import_id),
   per_import as (select import_id, count(*) n from gone where import_id is not null group by 1),
   counts as (update client_imports ci set created_count = greatest(0, ci.created_count - per_import.n)
                from per_import where ci.id = per_import.import_id returning 1)
   select (select count(*) from gone)::int as deleted
   ```

   Every part of one statement sees the data as it was before the statement started. To report "how many are left", count first and subtract what the statement deleted.

5. **Let the write report not found.** If the statement touches no rows, return 404. Don't run a separate `exists` check first. Row-level security hides other companies' rows, so this covers them too.
6. **Run rare-case queries only in the rare case.** The pipeline list counts the company's pipelines (to seed the default "Sales" one) only when its main query comes back empty.
7. **Don't expect `Promise.all` inside a transaction to help.** If two independent reads are both needed, combine them into one query instead.

### 3.2 Frontend

1. **No request waterfalls.** If request B needs an id you can know in advance (a remembered id, a route param), start it at the same time as A rather than after it.
2. **Prefetch in route loaders** (not awaited) so data starts loading on link hover through the router's preload-on-intent.
3. **Make bulk chunks as large as the endpoint allows** (currently 500). Each chunk is a whole request with its fixed cost.

---

## 4. Raw SQL with Drizzle

Set-based statements usually mean ``tx.execute(sql`...`)``. Two things to know:

- **Timestamps come back as strings** in Postgres's own format, not as `Date`. Drizzle turns off node-postgres's date parsing. Select them as ISO text and convert:

  ```ts
  const iso = (column: SQL) => sql`(to_json(${column}) #>> '{}')`;
  // ... then new Date(row.added_at)
  ```

- **Arrays in a `sql` template expand into a list of parameters**, not one array parameter. Build the array explicitly:

  ```ts
  const list = sql.join(ids.map((id) => sql`${id}`), sql`, `);
  sql`... where id = any(array[${list}]::uuid[])`;
  ```

Raw SQL isn't checked by the type system or by mocked unit tests. Give it an **e2e test against the real database**, following `test/crm-move.e2e-spec.ts`: a throwaway company, cleaned up afterwards, and a `{ timeout: 30_000 }` on the `describe` for Neon latency.

---

## 5. Checking a request

Time the service directly against the database with a small script that builds `TenantDb` and the service by hand, as the e2e tests do. Then divide by the round-trip time (time a `select 1` the same way) to get the trip count. If it's well above 4, or grows when you add data, look for the patterns in section 2.
