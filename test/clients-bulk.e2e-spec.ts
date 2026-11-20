/**
 * The clients page's one-statement queries against the real database: the
 * list's page + total, bulk delete with import counts, and the import deletes.
 * Creates throwaway companies and removes them afterwards.
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { ClientImportsRepository } from '../src/clients/client-imports.repository.js';
import { ClientImportsService } from '../src/clients/client-imports.service.js';
import { ClientsRepository } from '../src/clients/clients.repository.js';
import { ClientsService } from '../src/clients/clients.service.js';
import { loadEnv } from '../src/db/load-env.js';
import { pgPoolConfig } from '../src/db/pg-config.js';
import { clientImports, clients, tenants } from '../src/db/schema.js';
import { TenantDb } from '../src/db/tenant-db.js';
import type { Actor } from '../src/tenancy/tenancy.types.js';

loadEnv();

// Neon round trips: well past vitest's 5s default.
describe('clients bulk queries', { timeout: 30_000 }, () => {
  const pool = new Pool(pgPoolConfig());
  const db = drizzle({ client: pool });
  const tenantDb = new TenantDb(db);
  const clientsService = new ClientsService(tenantDb, new ClientsRepository(), new ClientImportsRepository());
  const importsService = new ClientImportsService(tenantDb, new ClientImportsRepository());
  const tag = randomUUID().slice(0, 8);
  let actor: Actor;
  let other: Actor;

  const actorFor = (tenant: { id: string }) => ({ user: { role: 'owner' }, tenant }) as unknown as Actor;
  const otherActor = () => other;

  /** An import with `n` linked clients (created_count = n), plus `loose` clients with no import. */
  async function seed(n: number, loose = 0, tenant = actor) {
    const [imp] = await db
      .insert(clientImports)
      .values({ tenantId: tenant.tenant.id, name: `Import ${tag}`, fileName: 'x.csv', rowCount: n, createdCount: n })
      .returning({ id: clientImports.id });
    const rows = [
      ...Array.from({ length: n }, (_, i) => ({ importId: imp.id, name: `imp-${i}` })),
      ...Array.from({ length: loose }, (_, i) => ({ importId: null, name: `loose-${i}` })),
    ];
    const made = rows.length
      ? await db
          .insert(clients)
          .values(rows.map((r) => ({ ...r, tenantId: tenant.tenant.id, email: `${r.name}-${tag}@example.test` })))
          .returning({ id: clients.id, importId: clients.importId })
      : [];
    return { importId: imp.id, ids: made.map((c) => c.id), linked: made.filter((c) => c.importId).map((c) => c.id) };
  }

  const createdCount = async (id: string) =>
    (await db.select({ n: clientImports.createdCount }).from(clientImports).where(eq(clientImports.id, id)))[0]?.n;

  beforeAll(async () => {
    const [a, b] = await db
      .insert(tenants)
      .values([{ name: `Clients A ${tag}` }, { name: `Clients B ${tag}` }])
      .returning();
    actor = actorFor(a);
    other = actorFor(b);
  });

  beforeEach(async () => {
    await db.delete(clients).where(inArray(clients.tenantId, [actor.tenant.id, other.tenant.id]));
    await db.delete(clientImports).where(inArray(clientImports.tenantId, [actor.tenant.id, other.tenant.id]));
  });

  afterAll(async () => {
    if (actor) await db.delete(tenants).where(inArray(tenants.id, [actor.tenant.id, other.tenant.id])); // cascades
    await pool.end();
  });

  it('pages the list with its total in one query, and still counts past the last page', async () => {
    await seed(0, 7);

    const first = await clientsService.list(actor, 1, 3);
    expect(first.items).toHaveLength(3);
    expect(first.total).toBe(7);
    expect(first.totalPages).toBe(3);
    expect(first.items[0]).not.toHaveProperty('total');

    const last = await clientsService.list(actor, 3, 3);
    expect(last.items).toHaveLength(1);
    expect(last.total).toBe(7);

    const past = await clientsService.list(actor, 9, 3);
    expect(past.items).toEqual([]);
    expect(past.total).toBe(7);

    const none = await clientsService.list(actor, 1, 3, 'no-such-client');
    expect(none).toMatchObject({ items: [], total: 0 });
  });

  it('imports a full 500-row chunk in one request, counting created and skipped', async () => {
    const [imp] = await db
      .insert(clientImports)
      .values({ tenantId: actor.tenant.id, name: `Big ${tag}`, fileName: 'big.csv', rowCount: 500 })
      .returning({ id: clientImports.id });
    const rows = Array.from({ length: 500 }, (_, i) => ({
      name: `row-${i}`,
      // Every 50th row has no contact: skipped, not failed.
      email: i % 50 === 0 ? undefined : `row-${i}-${tag}@example.test`,
      customDetails: { City: 'Pune', Note: 'x'.repeat(40) },
    }));

    await expect(clientsService.importChunk(actor, { importId: imp.id, clients: rows })).resolves.toEqual({
      created: 490,
      skipped: 10,
      duplicates: 0,
      existingClientIds: [],
    });
    const [saved] = await db.select().from(clientImports).where(eq(clientImports.id, imp.id));
    expect(saved.createdCount).toBe(490);
    expect(saved.skippedCount).toBe(10);
    expect(saved.rows).toHaveLength(500);
    expect((await clientsService.list(actor, 1, 50)).total).toBe(490);
  });

  it('never imports the same person twice: email ignoring case, phone by digits, repeats in the file', async () => {
    const [known] = await db
      .insert(clients)
      .values([
        { tenantId: actor.tenant.id, name: 'Vishnu', email: `Vishnu-${tag}@Example.test`, phone: null },
        { tenantId: actor.tenant.id, name: 'Asha', email: null, phone: '+91 80035 09196' },
      ])
      .returning({ id: clients.id });
    const [asha] = await db.select({ id: clients.id }).from(clients).where(eq(clients.name, 'Asha'));
    const [imp] = await db
      .insert(clientImports)
      .values({ tenantId: actor.tenant.id, name: `Dupes ${tag}`, fileName: 'dupes.csv', rowCount: 6 })
      .returning({ id: clientImports.id });

    const result = await clientsService.importChunk(actor, {
      importId: imp.id,
      clients: [
        { name: 'Vishnu again', email: ` vishnu-${tag}@example.TEST ` }, // existing, other case
        { name: 'Asha again', phone: '+918003509196' }, // existing, other phone format
        { name: 'New one', email: `new-${tag}@example.test` },
        { name: 'New one, repeated', email: `NEW-${tag}@example.test` }, // repeat inside the file
        { name: 'No contact' }, // invalid
        { name: 'Second new', phone: '+91 22222 33333' },
      ],
    });

    expect(result.created).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.duplicates).toBe(3);
    expect([...result.existingClientIds].sort()).toEqual([known.id, asha.id].sort());
    const [saved] = await db.select().from(clientImports).where(eq(clientImports.id, imp.id));
    expect(saved.createdCount).toBe(2);
    expect(saved.skippedCount).toBe(4); // 1 invalid + 3 duplicates
    expect(saved.rows).toHaveLength(6);
    expect((await clientsService.list(actor, 1, 50)).total).toBe(4); // 2 known + 2 new, no copies

    // A second import of the same rows adds nobody.
    const again = await clientsService.importChunk(actor, {
      importId: imp.id,
      clients: [{ name: 'New one', email: `new-${tag}@example.test` }],
    });
    expect(again).toMatchObject({ created: 0, duplicates: 1 });
  });

  it('refuses to add or edit a client into a duplicate, but allows the same person in another company', async () => {
    const [vishnu] = await db
      .insert(clients)
      .values({ tenantId: actor.tenant.id, name: 'Vishnu Nair', email: `vn-${tag}@example.test`, phone: '+91 99999 00000' })
      .returning({ id: clients.id });
    const [other] = await db
      .insert(clients)
      .values({ tenantId: actor.tenant.id, name: 'Other', email: `other-${tag}@example.test` })
      .returning({ id: clients.id });

    await expect(clientsService.create(actor, { name: 'Copy', email: `VN-${tag}@example.test` })).rejects.toThrow(
      'A client with this email already exists: Vishnu Nair.',
    );
    await expect(clientsService.create(actor, { name: 'Copy', phone: '+919999900000' })).rejects.toThrow(
      'A client with this phone number already exists: Vishnu Nair.',
    );
    await expect(clientsService.update(actor, other.id, { phone: '+91-99999-00000' })).rejects.toThrow('Vishnu Nair');
    // Saving a client with its own contact is not a duplicate of itself.
    await expect(clientsService.update(actor, vishnu.id, { name: 'Vishnu N.' })).resolves.toMatchObject({ name: 'Vishnu N.' });
    // The same person in another company is fine.
    await expect(
      clientsService.create(otherActor(), { name: 'Vishnu elsewhere', email: `vn-${tag}@example.test` }),
    ).resolves.toMatchObject({ name: 'Vishnu elsewhere' });
  });

  it('bulk delete removes the clients and lowers their import count', async () => {
    const { importId, linked, ids } = await seed(5, 2);
    const loose = ids.filter((id) => !linked.includes(id));

    const result = await clientsService.removeMany(actor, { ids: [...linked.slice(0, 3), loose[0]] });

    expect(result).toEqual({ deleted: 4 });
    expect(await createdCount(importId)).toBe(2);
    expect((await clientsService.list(actor, 1, 50)).total).toBe(3);
  });

  it("bulk delete skips ids that don't exist or belong to another company", async () => {
    const mine = await seed(0, 2);
    const theirs = await seed(2, 0, other);

    const result = await clientsService.removeMany(actor, { ids: [mine.ids[0], theirs.ids[0], randomUUID()] });

    expect(result).toEqual({ deleted: 1 });
    expect(await createdCount(theirs.importId)).toBe(2);
    expect((await clientsService.list(other, 1, 50)).total).toBe(2);
  });

  it('deletes an import in chunks, reporting what is left and keeping its count right', async () => {
    const { importId } = await seed(5, 1);

    await expect(importsService.deleteClientChunk(actor, importId, 2)).resolves.toEqual({ deleted: 2, remaining: 3 });
    expect(await createdCount(importId)).toBe(3);
    await expect(importsService.deleteClientChunk(actor, importId, 500)).resolves.toEqual({ deleted: 3, remaining: 0 });
    expect(await createdCount(importId)).toBe(0);
    await expect(importsService.deleteClientChunk(actor, importId, 500)).resolves.toEqual({ deleted: 0, remaining: 0 });

    // The client that wasn't part of the import is untouched.
    expect((await clientsService.list(actor, 1, 50)).total).toBe(1);
  });

  it('removes an import with its remaining clients in one statement', async () => {
    const { importId } = await seed(3, 1);

    await expect(importsService.remove(actor, importId)).resolves.toBe(3);
    expect(await createdCount(importId)).toBeUndefined();
    expect((await clientsService.list(actor, 1, 50)).total).toBe(1);
  });

  it("reports another company's import as not found for both deletes", async () => {
    const theirs = await seed(2, 0, other);

    await expect(importsService.deleteClientChunk(actor, theirs.importId, 100)).rejects.toThrow('Import not found');
    await expect(importsService.remove(actor, theirs.importId)).rejects.toThrow('Import not found');
    expect(await createdCount(theirs.importId)).toBe(2);
  });
});
