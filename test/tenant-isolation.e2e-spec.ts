/**
 * Proves row-level security keeps companies apart, against the real database
 * (DATABASE_URL, through the same pooled connection the app uses). Creates
 * two throwaway companies with one person each and removes them afterwards.
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { loadEnv } from '../src/db/load-env.js';
import { pgPoolConfig } from '../src/db/pg-config.js';
import { tenants, users } from '../src/db/schema.js';
import { TenantDb } from '../src/db/tenant-db.js';

loadEnv();

describe('tenant isolation (row-level security)', () => {
  const pool = new Pool(pgPoolConfig());
  const db = drizzle({ client: pool });
  const tenantDb = new TenantDb(db);
  const tag = randomUUID().slice(0, 8);
  let a: { id: string }, b: { id: string }, userB: { id: string };

  beforeAll(async () => {
    [a, b] = await db
      .insert(tenants)
      .values([{ name: `RLS A ${tag}` }, { name: `RLS B ${tag}` }])
      .returning({ id: tenants.id });
    await db.insert(users).values({
      email: `rls-a-${tag}@example.test`, fullName: 'RLS A', passwordHash: 'x', tenantId: a.id, role: 'owner',
    });
    [userB] = await db
      .insert(users)
      .values({ email: `rls-b-${tag}@example.test`, fullName: 'RLS B', passwordHash: 'x', tenantId: b.id, role: 'owner' })
      .returning({ id: users.id });
  });

  afterAll(async () => {
    await db.delete(tenants).where(inArray(tenants.id, [a.id, b.id])); // cascades to users
    await pool.end();
  });

  it("shows a company only its own people, even with no WHERE clause", async () => {
    const rows = await tenantDb.run(a.id, (tx) => tx.select().from(users));
    expect(rows.map((r) => r.tenantId)).toEqual([a.id]);
  });

  it("can't read another company's person by id", async () => {
    const rows = await tenantDb.run(a.id, (tx) => tx.select().from(users).where(eq(users.id, userB.id)));
    expect(rows).toEqual([]);
  });

  it('refuses to create a person in another company', async () => {
    await expect(
      tenantDb.run(a.id, (tx) =>
        tx.insert(users).values({
          email: `rls-x-${tag}@example.test`, fullName: 'X', passwordHash: 'x', tenantId: b.id,
        }),
      ),
    ).rejects.toThrow();
  });

  it("can't update or delete another company's people", async () => {
    await tenantDb.run(a.id, async (tx) => {
      await tx.update(users).set({ role: 'staff' }).where(eq(users.id, userB.id));
      await tx.delete(users).where(eq(users.id, userB.id));
    });
    const [still] = await db.select().from(users).where(eq(users.id, userB.id));
    expect(still.role).toBe('owner');
  });

  it('sees nobody when no company is set', async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`set local role infynix_tenant`);
      return tx.select().from(users);
    });
    expect(rows).toEqual([]);
  });

  it("doesn't leak the company setting into the next transaction on the pool", async () => {
    await tenantDb.run(a.id, async () => undefined);
    const { rows } = await pool.query<{ role: string; tenant: string | null }>(
      `select current_user as role, current_setting('app.tenant_id', true) as tenant`,
    );
    const row = rows[0];
    expect(row.role).not.toBe('infynix_tenant');
    expect(row.tenant || null).toBeNull();
  });
});
