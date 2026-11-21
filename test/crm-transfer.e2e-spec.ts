/**
 * Deal transfer (Move) against the real database (docs/deal-transfer.md):
 * deal ids by stage, the one-statement move, landing stage and positions,
 * duplicates, owners by the target's rule, and the error cases. Creates a
 * throwaway company and removes it afterwards.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { CrmTransferRepository } from '../src/crm/crm-transfer.repository.js';
import { CrmTransferService } from '../src/crm/crm-transfer.service.js';
import { CrmRepository } from '../src/crm/crm.repository.js';
import { loadEnv } from '../src/db/load-env.js';
import { pgPoolConfig } from '../src/db/pg-config.js';
import {
  accessItems,
  clients,
  crmDeals,
  crmPipelineStages,
  crmPipelineUsers,
  crmPipelines,
  tenants,
  userAccess,
  users,
} from '../src/db/schema.js';
import { TenantDb } from '../src/db/tenant-db.js';
import type { Actor } from '../src/tenancy/tenancy.types.js';

loadEnv();

describe('CRM deal transfer: Move and Add', { timeout: 90_000 }, () => {
  const pool = new Pool(pgPoolConfig());
  const db = drizzle({ client: pool });
  const service = new CrmTransferService(new TenantDb(db), new CrmTransferRepository(), new CrmRepository());
  const tag = randomUUID().slice(0, 8);

  let tenantId: string;
  let owner: Actor;
  const ids: Record<string, string> = {};
  let seq = 0;

  /** Source and target pipelines with two stages each. */
  let source: { id: string; s1: string; s2: string };
  let target: { id: string; t1: string; t2: string };

  async function pipeline(name: string) {
    const [p] = await db.insert(crmPipelines).values({ tenantId, name: `${name} ${tag}` }).returning({ id: crmPipelines.id });
    const stages = await db
      .insert(crmPipelineStages)
      .values([
        { tenantId, pipelineId: p.id, name: 'One', position: 0 },
        { tenantId, pipelineId: p.id, name: 'Two', position: 1 },
      ])
      .returning({ id: crmPipelineStages.id, position: crmPipelineStages.position });
    const [first, second] = stages.sort((a, b) => a.position - b.position);
    await db.insert(crmPipelineUsers).values([ids.a, ids.b].map((userId) => ({ tenantId, pipelineId: p.id, userId })));
    return { id: p.id, first: first.id, second: second.id };
  }

  /** `n` deals in a stage, positions 0..n-1, each for a new client named `${prefix}${i}`. */
  async function deals(pipelineId: string, stageId: string, n: number, prefix: string, startPosition = 0) {
    const made = await db
      .insert(clients)
      .values(
        Array.from({ length: n }, (_, i) => {
          seq += 1;
          return { tenantId, name: `${prefix}${i}`, email: `t${seq}-${tag}@example.test` };
        }),
      )
      .returning({ id: clients.id, name: clients.name });
    const rows = await db
      .insert(crmDeals)
      .values(
        made.map((c, i) => ({ tenantId, pipelineId, stageId, clientId: c.id, position: startPosition + i, createdBy: ids.a })),
      )
      .returning({ id: crmDeals.id, clientId: crmDeals.clientId });
    return rows.map((row) => ({ ...row, name: made.find((c) => c.id === row.clientId)!.name }));
  }

  const inStage = (stageId: string) =>
    db
      .select({ id: crmDeals.id, position: crmDeals.position, ownerId: crmDeals.ownerId, source: crmDeals.assignmentSource, createdBy: crmDeals.createdBy, clientId: crmDeals.clientId })
      .from(crmDeals)
      .where(eq(crmDeals.stageId, stageId))
      .orderBy(asc(crmDeals.position));

  beforeAll(async () => {
    [{ id: tenantId }] = await db.insert(tenants).values({ name: `Transfer ${tag}` }).returning({ id: tenants.id });
    for (const [name, role] of [['owner', 'owner'], ['a', 'staff'], ['b', 'staff']] as const) {
      const [row] = await db
        .insert(users)
        .values({ email: `${name}-${tag}@example.test`, fullName: name.toUpperCase(), passwordHash: 'x', tenantId, role })
        .returning({ id: users.id });
      ids[name] = row.id;
    }
    owner = { user: { id: ids.owner, role: 'owner', tenantId }, tenant: { id: tenantId } } as unknown as Actor;
    const [crmItem] = await db.select({ id: accessItems.id }).from(accessItems).where(eq(accessItems.key, 'crm'));
    await db.insert(userAccess).values(['a', 'b'].map((n) => ({ tenantId, userId: ids[n], accessItemId: crmItem.id })));
    const s = await pipeline('Source');
    const t = await pipeline('Target');
    source = { id: s.id, s1: s.first, s2: s.second };
    target = { id: t.id, t1: t.first, t2: t.second };
  });

  beforeEach(async () => {
    await db.delete(crmDeals).where(eq(crmDeals.tenantId, tenantId));
    await db.delete(clients).where(eq(clients.tenantId, tenantId));
    await db
      .update(crmPipelines)
      .set({ assignmentRule: 'creator', singleUserId: null, roundRobinCursor: 0 })
      .where(eq(crmPipelines.tenantId, tenantId));
  });

  afterAll(async () => {
    if (tenantId) {
      await db.delete(crmDeals).where(eq(crmDeals.tenantId, tenantId));
      await db.delete(tenants).where(inArray(tenants.id, [tenantId])); // cascades
    }
    await pool.end();
  });

  it('lists every deal in the chosen stages, beyond the 100 loaded on the board, in board order', async () => {
    const big = await deals(source.id, source.s1, 120, 'big')
    const small = await deals(source.id, source.s2, 3, 'small')
    const both = await service.dealIds(owner, source.id, [source.s1, source.s2]);
    expect(both.ids).toEqual([...big, ...small].map((d) => d.id));
    expect((await service.dealIds(owner, source.id, [source.s2])).ids).toEqual(small.map((d) => d.id));
  });

  it('moves deals to the end of the landing stage in source order, keeping created_by; Creator targets leave them unassigned', async () => {
    const already = await deals(target.id, target.t1, 2, 'there');
    const moving = await deals(source.id, source.s1, 3, 'mv');
    // Give one an owner in the source: owners don't travel.
    await db.update(crmDeals).set({ ownerId: ids.a, assignmentSource: 'manual' }).where(eq(crmDeals.id, moving[0].id));

    const result = await service.run(owner, { mode: 'move', dealIds: moving.map((d) => d.id), targetPipelineId: target.id });
    expect(result).toEqual({ mode: 'move', moved: 3, added: 0, unassigned: 3, missing: 0, skipped: [] });

    expect(await inStage(source.s1)).toEqual([]);
    const landed = await inStage(target.t1);
    expect(landed.map((d) => d.id)).toEqual([...already, ...moving].map((d) => d.id));
    expect(landed.map((d) => d.position)).toEqual([0, 1, 2, 3, 4]);
    expect(landed.slice(2).every((d) => d.ownerId === null && d.source === null && d.createdBy === ids.a)).toBe(true);
  });

  it('lands in the chosen stage and skips clients already in the target, naming them', async () => {
    const moving = await deals(source.id, source.s1, 3, 'dup');
    // The target already has a deal for the second client.
    await db.insert(crmDeals).values({ tenantId, pipelineId: target.id, stageId: target.t1, clientId: moving[1].clientId, position: 0 });

    const result = await service.run(owner, {
      mode: 'move',
      dealIds: moving.map((d) => d.id),
      targetPipelineId: target.id,
      targetStageId: target.t2,
    });
    expect(result.moved).toBe(2);
    expect(result.skipped).toEqual([{ dealId: moving[1].id, clientName: 'dup1' }]);
    expect((await inStage(target.t2)).map((d) => d.id)).toEqual([moving[0].id, moving[2].id]);
    expect((await inStage(source.s1)).map((d) => d.id)).toEqual([moving[1].id]); // stayed behind
  });

  it('a Round robin target shares the owners and advances its cursor; Single user gives them all to the target', async () => {
    await db.update(crmPipelines).set({ assignmentRule: 'round_robin' }).where(eq(crmPipelines.id, target.id));
    const rr = await deals(source.id, source.s1, 3, 'rr');
    await expect(
      service.run(owner, { mode: 'move', dealIds: rr.map((d) => d.id), targetPipelineId: target.id }),
    ).resolves.toMatchObject({ moved: 3, unassigned: 0 });
    const owners = (await inStage(target.t1)).map((d) => d.ownerId);
    const [first, second] = [ids.a, ids.b].sort();
    expect(owners).toEqual([first, second, first]);
    expect((await inStage(target.t1)).every((d) => d.source === 'round_robin')).toBe(true);
    const [t] = await db.select().from(crmPipelines).where(eq(crmPipelines.id, target.id));
    expect(t.roundRobinCursor).toBe(1);

    await db.update(crmPipelines).set({ assignmentRule: 'single_user', singleUserId: ids.b }).where(eq(crmPipelines.id, target.id));
    const su = await deals(source.id, source.s2, 2, 'su');
    await service.run(owner, { mode: 'move', dealIds: su.map((d) => d.id), targetPipelineId: target.id, targetStageId: target.t2 });
    expect((await inStage(target.t2)).map((d) => d.ownerId)).toEqual([ids.b, ids.b]);
  });

  it('refuses mixed sources, the same pipeline and a stage of another pipeline; counts deals that no longer exist', async () => {
    const fromSource = await deals(source.id, source.s1, 1, 'x');
    const fromTarget = await deals(target.id, target.t1, 1, 'y');
    await expect(
      service.run(owner, { mode: 'move', dealIds: [fromSource[0].id, fromTarget[0].id], targetPipelineId: target.id }),
    ).rejects.toThrow('same pipeline');
    await expect(
      service.run(owner, { mode: 'move', dealIds: [fromSource[0].id], targetPipelineId: source.id }),
    ).rejects.toThrow('already in');
    await expect(
      service.run(owner, { mode: 'move', dealIds: [fromSource[0].id], targetPipelineId: target.id, targetStageId: source.s2 }),
    ).rejects.toThrow('doesn’t belong to the target');
    // Nothing moved by the refused calls.
    expect((await inStage(source.s1)).map((d) => d.id)).toEqual([fromSource[0].id]);

    await expect(
      service.run(owner, { mode: 'move', dealIds: [fromSource[0].id, randomUUID()], targetPipelineId: target.id }),
    ).resolves.toMatchObject({ moved: 1, missing: 1 });
  });

  it('Add to another pipeline leaves the source deals and creates new ones, with created_by = whoever adds them', async () => {
    const sourceDeals = await deals(source.id, source.s1, 3, 'cp');
    // One client is already in the target: skipped, the rest are added.
    await db.insert(crmDeals).values({ tenantId, pipelineId: target.id, stageId: target.t1, clientId: sourceDeals[2].clientId, position: 0 });
    await db.update(crmPipelines).set({ assignmentRule: 'single_user', singleUserId: ids.b }).where(eq(crmPipelines.id, target.id));

    const result = await service.run(owner, {
      mode: 'copy',
      dealIds: sourceDeals.map((d) => d.id),
      targetPipelineId: target.id,
      targetStageId: target.t2,
    });
    expect(result).toMatchObject({ mode: 'copy', added: 2, moved: 0, unassigned: 0, missing: 0 });
    expect(result.skipped).toEqual([{ dealId: sourceDeals[2].id, clientName: 'cp2' }]);

    // The source is untouched.
    expect((await inStage(source.s1)).map((d) => d.id)).toEqual(sourceDeals.map((d) => d.id));
    // New deals in the target, for the same clients, in source order, owned by the single-user target.
    const added = await inStage(target.t2);
    expect(added.map((d) => d.clientId)).toEqual([sourceDeals[0].clientId, sourceDeals[1].clientId]);
    expect(added.every((d) => !sourceDeals.some((s) => s.id === d.id))).toBe(true);
    expect(added.every((d) => d.createdBy === ids.owner && d.ownerId === ids.b && d.source === 'single_user')).toBe(true);

    await expect(
      service.run(owner, { mode: 'copy', dealIds: [sourceDeals[0].id], targetPipelineId: source.id }),
    ).rejects.toThrow('already in this pipeline');
  });

  it('Select › Delete removes only deals in pipelines the person can see', async () => {
    const mine = await deals(source.id, source.s1, 3, 'del');
    // A pipeline staff member A isn't on.
    const [hidden] = await db.insert(crmPipelines).values({ tenantId, name: `Hidden ${tag}` }).returning({ id: crmPipelines.id });
    const [hiddenStage] = await db
      .insert(crmPipelineStages)
      .values({ tenantId, pipelineId: hidden.id, name: 'Only', position: 0 })
      .returning({ id: crmPipelineStages.id });
    const [secret] = await deals(hidden.id, hiddenStage.id, 1, 'hid');
    const staffA = { user: { id: ids.a, role: 'staff', tenantId }, tenant: { id: tenantId } } as unknown as Actor;

    const result = await service.deleteMany(staffA, { dealIds: [mine[0].id, mine[1].id, secret.id] });
    expect(result).toEqual({ deleted: 2, missing: 1 });
    expect((await inStage(source.s1)).map((d) => d.id)).toEqual([mine[2].id]);
    expect(await inStage(hiddenStage.id)).toHaveLength(1);

    // The Owner sees every pipeline; deals already gone count as missing.
    expect(await service.deleteMany(owner, { dealIds: [secret.id, mine[0].id] })).toEqual({ deleted: 1, missing: 1 });
    await db.delete(crmPipelines).where(eq(crmPipelines.id, hidden.id));
  });

  it('moves a full 500-deal chunk in one request', async () => {
    const many = await deals(source.id, source.s1, 500, 'm');
    const result = await service.run(owner, { mode: 'move', dealIds: many.map((d) => d.id), targetPipelineId: target.id });
    expect(result.moved).toBe(500);
    const landed = await db
      .select({ n: crmDeals.id })
      .from(crmDeals)
      .where(and(eq(crmDeals.pipelineId, target.id), eq(crmDeals.stageId, target.t1)));
    expect(landed).toHaveLength(500);
  });
});
