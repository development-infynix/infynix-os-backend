/**
 * Deal moves against the real database: the one-statement re-index and the
 * pipeline lock that keeps two quick moves from writing over each other.
 * Creates a throwaway company with one pipeline and removes it afterwards.
 */
import { randomUUID } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { ClientsRepository } from '../src/clients/clients.repository.js';
import { CrmRepository } from '../src/crm/crm.repository.js';
import { CrmService } from '../src/crm/crm.service.js';
import { loadEnv } from '../src/db/load-env.js';
import { pgPoolConfig } from '../src/db/pg-config.js';
import {
  clients,
  crmDeals,
  crmPipelineStages,
  crmPipelines,
  tenants,
  users,
} from '../src/db/schema.js';
import { TenantDb } from '../src/db/tenant-db.js';
import type { Actor } from '../src/tenancy/tenancy.types.js';

loadEnv();

// Neon round trips plus one move waiting on the other's lock: well past vitest's 5s default.
describe('CRM deal moves', { timeout: 30_000 }, () => {
  const pool = new Pool(pgPoolConfig());
  const db = drizzle({ client: pool });
  const service = new CrmService(new TenantDb(db), new CrmRepository(), new ClientsRepository());
  const tag = randomUUID().slice(0, 8);
  let actor: Actor;
  let pipelineId: string;
  let from: string, to: string;
  /** Deal ids by client name, a..d, all starting in `from` in that order. */
  const deal: Record<string, string> = {};

  /** Each stage's deals in board order, by client name. */
  async function board() {
    const rows = await db
      .select({ stageId: crmDeals.stageId, position: crmDeals.position, name: clients.name })
      .from(crmDeals)
      .innerJoin(clients, eq(clients.id, crmDeals.clientId))
      .where(eq(crmDeals.pipelineId, pipelineId))
      .orderBy(asc(crmDeals.position));
    const column = (stageId: string) => rows.filter((r) => r.stageId === stageId);
    return { from: column(from), to: column(to) };
  }

  beforeAll(async () => {
    const [tenant] = await db
      .insert(tenants)
      .values({ name: `CRM move ${tag}` })
      .returning();
    const [user] = await db
      .insert(users)
      .values({
        email: `crm-move-${tag}@example.test`,
        fullName: 'CRM move',
        passwordHash: 'x',
        tenantId: tenant.id,
        role: 'owner',
      })
      .returning();
    actor = { user, tenant } as unknown as Actor;
    [{ id: pipelineId }] = await db
      .insert(crmPipelines)
      .values({ tenantId: tenant.id, name: 'Sales' })
      .returning({ id: crmPipelines.id });
    [{ id: from }, { id: to }] = await db
      .insert(crmPipelineStages)
      .values([
        { tenantId: tenant.id, pipelineId, name: 'From', position: 0 },
        { tenantId: tenant.id, pipelineId, name: 'To', position: 1 },
      ])
      .returning({ id: crmPipelineStages.id });
  });

  beforeEach(async () => {
    await db.delete(crmDeals).where(eq(crmDeals.pipelineId, pipelineId));
    await db.delete(clients).where(eq(clients.tenantId, actor.tenant.id));
    const made = await db
      .insert(clients)
      .values(['a', 'b', 'c', 'd'].map((name) => ({ tenantId: actor.tenant.id, name, email: `${name}-${tag}@example.test` })))
      .returning({ id: clients.id, name: clients.name });
    const rows = await db
      .insert(crmDeals)
      .values(
        made.map((c) => ({
          tenantId: actor.tenant.id,
          pipelineId,
          stageId: from,
          clientId: c.id,
          position: ['a', 'b', 'c', 'd'].indexOf(c.name),
        })),
      )
      .returning({ id: crmDeals.id, clientId: crmDeals.clientId });
    for (const row of rows) deal[made.find((c) => c.id === row.clientId)!.name] = row.id;
  });

  afterAll(async () => {
    if (pipelineId) await db.delete(crmDeals).where(eq(crmDeals.pipelineId, pipelineId));
    if (actor) await db.delete(tenants).where(inArray(tenants.id, [actor.tenant.id])); // cascades
    await pool.end();
  });

  it('moves a deal into another stage and re-indexes both', async () => {
    await service.moveDeal(actor, deal.b, { stageId: to, position: 0 });

    const after = await board();
    expect(after.from.map((r) => [r.name, r.position])).toEqual([['a', 0], ['c', 1], ['d', 2]]);
    expect(after.to.map((r) => [r.name, r.position])).toEqual([['b', 0]]);
  });

  it('reorders inside a stage', async () => {
    await service.moveDeal(actor, deal.d, { stageId: from, position: 1 });

    const after = await board();
    expect(after.from.map((r) => r.name)).toEqual(['a', 'd', 'b', 'c']);
    expect(after.from.map((r) => r.position)).toEqual([0, 1, 2, 3]);
  });

  it('loads the board in one query: order, totals, per-stage limit, empty stages', async () => {
    await service.moveDeal(actor, deal.b, { stageId: from, position: 0 });

    const two = await service.board(actor, pipelineId, 2);
    expect(two.stages.map((s) => s.name)).toEqual(['From', 'To']);
    expect(two.totals).toEqual({ [from]: 4, [to]: 0 });
    expect(two.columns[from].map((c) => c.name)).toEqual(['b', 'a']);
    expect(two.columns[to]).toEqual([]);
    const [first] = two.columns[from];
    expect(first.addedAt).toBeInstanceOf(Date);
    expect(Number.isNaN(first.addedAt.getTime())).toBe(false);
    expect(first.email).toBe(`b-${tag}@example.test`);
    expect(first.customDetails).toEqual({});

    const all = await service.board(actor, pipelineId, 100);
    expect(all.columns[from].map((c) => c.name)).toEqual(['b', 'a', 'c', 'd']);
  });

  it('lists pipelines with their stages nested, in board order', async () => {
    const list = await service.listPipelines(actor);
    expect(list).toEqual([
      {
        id: pipelineId,
        name: 'Sales',
        position: 0,
        stages: [
          { id: from, name: 'From', position: 0 },
          { id: to, name: 'To', position: 1 },
        ],
      },
    ]);
  });

  it('reorders stages in one statement and persists the new board order', async () => {
    const result = await service.reorderStages(actor, pipelineId, [to, from]);

    expect(result).toEqual([
      { id: to, name: 'To', position: 0 },
      { id: from, name: 'From', position: 1 },
    ]);
    const after = await service.board(actor, pipelineId, 100);
    expect(after.stages.map((stage) => stage.id)).toEqual([to, from]);
    expect(after.stages.map((stage) => stage.position)).toEqual([0, 1]);
    // Its deals stay with their stages.
    expect(after.totals).toEqual({ [from]: 4, [to]: 0 });
  });

  it('rejects an incomplete stage order without changing anything', async () => {
    const before = (await service.board(actor, pipelineId, 100)).stages.map((stage) => stage.id);
    await expect(service.reorderStages(actor, pipelineId, [from])).rejects.toThrow(
      'Provide every stage of the pipeline exactly once',
    );
    expect((await service.board(actor, pipelineId, 100)).stages.map((stage) => stage.id)).toEqual(before);
  });

  it('keeps both of two simultaneous moves into the same stage', async () => {
    // Two open connections, so the second move doesn't lag behind while one connects.
    await Promise.all([pool.query('select 1'), pool.query('select 1')]);
    await Promise.all([
      service.moveDeal(actor, deal.a, { stageId: to, position: 0 }),
      service.moveDeal(actor, deal.c, { stageId: to, position: 0 }),
    ]);

    const after = await board();
    expect(after.to.map((r) => r.name).sort()).toEqual(['a', 'c']);
    expect(after.to.map((r) => r.position)).toEqual([0, 1]);
    expect(after.from.map((r) => [r.name, r.position])).toEqual([['b', 0], ['d', 1]]);
  });
});
