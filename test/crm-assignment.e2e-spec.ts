/**
 * Deal assignment against the real database (docs/user-deals-assignment.md):
 * eligibility, the four rules on new deals, Share/Give, Unassign, Transfer,
 * the access list with its handover, hand-picked owners and the access-list
 * foreign key. Creates a throwaway company and removes it afterwards.
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { ClientsRepository } from '../src/clients/clients.repository.js';
import { CrmAssignmentRepository } from '../src/crm/crm-assignment.repository.js';
import { CrmAssignmentService } from '../src/crm/crm-assignment.service.js';
import { CrmRepository } from '../src/crm/crm.repository.js';
import { CrmService } from '../src/crm/crm.service.js';
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

describe('CRM deal assignment', { timeout: 60_000 }, () => {
  const pool = new Pool(pgPoolConfig());
  const db = drizzle({ client: pool });
  const tenantDb = new TenantDb(db);
  const crmRepo = new CrmRepository();
  const assignment = new CrmAssignmentService(tenantDb, new CrmAssignmentRepository(), crmRepo);
  const crm = new CrmService(tenantDb, crmRepo, new ClientsRepository());
  const tag = randomUUID().slice(0, 8);

  let tenantId: string;
  let pipelineId: string;
  let stageId: string;
  /** People by name: owner, manager, staff a/b/c, n (no CRM grant), i (inactive). */
  const person: Record<string, { id: string; actor: Actor }> = {};
  let clientSeq = 0;

  const actorOf = (user: { id: string; role: string }) =>
    ({ user: { ...user, tenantId }, tenant: { id: tenantId } }) as unknown as Actor;

  async function newClients(n: number): Promise<string[]> {
    const rows = await db
      .insert(clients)
      .values(
        Array.from({ length: n }, () => {
          clientSeq += 1;
          return { tenantId, name: `client ${clientSeq}`, email: `c${clientSeq}-${tag}@example.test` };
        }),
      )
      .returning({ id: clients.id });
    return rows.map((row) => row.id);
  }

  /** Deal owners in this pipeline: { ownerName: count }, plus sources. */
  async function owners() {
    const rows = await db
      .select({ ownerId: crmDeals.ownerId, source: crmDeals.assignmentSource })
      .from(crmDeals)
      .where(eq(crmDeals.pipelineId, pipelineId));
    const byName: Record<string, number> = {};
    const name = (id: string | null) => Object.entries(person).find(([, p]) => p.id === id)?.[0] ?? 'none';
    for (const row of rows) byName[name(row.ownerId)] = (byName[name(row.ownerId)] ?? 0) + 1;
    return { byName, rows };
  }

  beforeAll(async () => {
    [{ id: tenantId }] = await db.insert(tenants).values({ name: `Assign ${tag}` }).returning({ id: tenants.id });
    const make = async (name: string, role: 'owner' | 'manager' | 'staff', isActive = true) => {
      const [row] = await db
        .insert(users)
        .values({ email: `${name}-${tag}@example.test`, fullName: name.toUpperCase(), passwordHash: 'x', tenantId, role, isActive })
        .returning({ id: users.id });
      person[name] = { id: row.id, actor: actorOf({ id: row.id, role }) };
    };
    await make('owner', 'owner');
    await make('manager', 'manager');
    for (const name of ['a', 'b', 'c', 'n']) await make(name, 'staff');
    await make('i', 'staff', false);

    const [crmItem] = await db.select({ id: accessItems.id }).from(accessItems).where(eq(accessItems.key, 'crm'));
    await db.insert(userAccess).values(
      ['manager', 'a', 'b', 'c', 'i'].map((name) => ({ tenantId, userId: person[name].id, accessItemId: crmItem.id })),
    );

    [{ id: pipelineId }] = await db
      .insert(crmPipelines)
      .values({ tenantId, name: 'Sales' })
      .returning({ id: crmPipelines.id });
    [{ id: stageId }] = await db
      .insert(crmPipelineStages)
      .values({ tenantId, pipelineId, name: 'Lead', position: 0 })
      .returning({ id: crmPipelineStages.id });
    // Everyone but the Owner is on the list, including n (no CRM grant) and i (inactive).
    await db.insert(crmPipelineUsers).values(
      ['manager', 'a', 'b', 'c', 'n', 'i'].map((name) => ({ tenantId, pipelineId, userId: person[name].id })),
    );
  });

  beforeEach(async () => {
    await db.delete(crmDeals).where(eq(crmDeals.pipelineId, pipelineId));
    await db
      .update(crmPipelines)
      .set({ assignmentRule: 'creator', singleUserId: null, roundRobinCursor: 0 })
      .where(eq(crmPipelines.id, pipelineId));
  });

  afterAll(async () => {
    if (tenantId) {
      await db.delete(crmDeals).where(eq(crmDeals.tenantId, tenantId));
      await db.delete(tenants).where(inArray(tenants.id, [tenantId])); // cascades
    }
    await pool.end();
  });

  const owner = () => person.owner.actor;
  const addAs = (actor: Actor, clientIds: string[]) =>
    crm.addDeals(actor, { pipelineId, clientIds });

  it('only active people with CRM access on the list, never the Owner, can own deals', async () => {
    const overview = await assignment.overview(owner(), pipelineId);
    const eligible = Object.fromEntries(overview.people.map((p) => [p.fullName, p.eligible]));
    expect(eligible).toEqual({ A: true, B: true, C: true, I: false, MANAGER: true, N: false });
    expect(overview.rule).toBe('creator');
  });

  it('Creator: the adder owns new deals; the Owner adding leaves them unassigned', async () => {
    await addAs(person.a.actor, await newClients(2));
    await addAs(owner(), await newClients(1));
    const { byName, rows } = await owners();
    expect(byName).toEqual({ a: 2, none: 1 });
    expect(rows.filter((r) => r.ownerId).every((r) => r.source === 'creator')).toBe(true);
  });

  it('Round robin on new deals walks the eligible people in order and keeps the cursor', async () => {
    await assignment.setRule(owner(), pipelineId, { rule: 'round_robin' });
    await addAs(owner(), await newClients(6)); // 4 eligible: 2,2,1,1
    await addAs(owner(), await newClients(2)); // continues: everyone ends on 2
    const { byName } = await owners();
    expect(byName).toEqual({ a: 2, b: 2, c: 2, manager: 2 });
    const [p] = await db.select().from(crmPipelines).where(eq(crmPipelines.id, pipelineId));
    expect(p.roundRobinCursor).toBe(0);
  });

  it('Single user: every new deal goes to the target; an ineligible target is refused', async () => {
    await expect(
      assignment.setRule(owner(), pipelineId, { rule: 'single_user', singleUserId: person.n.id }),
    ).rejects.toThrow('can’t own deals');
    await assignment.setRule(owner(), pipelineId, { rule: 'single_user', singleUserId: person.b.id });
    await addAs(person.a.actor, await newClients(3));
    expect((await owners()).byName).toEqual({ b: 3 });
  });

  it('Share and Give work on existing unassigned deals only, without touching the rule', async () => {
    await assignment.setRule(owner(), pipelineId, { rule: 'manual' });
    await addAs(owner(), await newClients(9));
    const shared = await assignment.distribute(owner(), pipelineId, { method: 'round_robin' });
    expect(shared).toMatchObject({ assigned: 9, remaining: 0, eligibleCount: 4 });
    const counts = Object.values((await owners()).byName).sort();
    expect(counts).toEqual([2, 2, 2, 3]);

    await addAs(owner(), await newClients(2));
    await expect(
      assignment.distribute(owner(), pipelineId, { method: 'single_user', userId: person.i.id }),
    ).rejects.toThrow('can’t own deals');
    await expect(
      assignment.distribute(owner(), pipelineId, { method: 'single_user', userId: person.c.id }),
    ).resolves.toMatchObject({ assigned: 2, remaining: 0 });
    expect((await assignment.overview(owner(), pipelineId)).rule).toBe('manual');
  });

  it('Unassign by person or source, Transfer keeps the source, Revert round robin', async () => {
    await assignment.setRule(owner(), pipelineId, { rule: 'manual' });
    await addAs(owner(), await newClients(8));
    await assignment.distribute(owner(), pipelineId, { method: 'round_robin' }); // 2 each
    await assignment.setRule(owner(), pipelineId, { rule: 'creator' });
    await addAs(person.a.actor, await newClients(1)); // a: 2 round robin + 1 creator

    await expect(
      assignment.transfer(owner(), pipelineId, { fromUserId: person.b.id, toUserId: person.c.id }),
    ).resolves.toEqual({ transferred: 2, remaining: 0 });
    const afterTransfer = await owners();
    expect(afterTransfer.byName.c).toBe(4);
    expect(afterTransfer.rows.filter((r) => r.ownerId === person.c.id).every((r) => r.source === 'round_robin')).toBe(true);
    expect((await assignment.overview(owner(), pipelineId)).rule).toBe('creator');

    await expect(
      assignment.transfer(owner(), pipelineId, { fromUserId: person.a.id, toUserId: person.n.id }),
    ).rejects.toThrow('can’t own deals');

    await expect(assignment.unassign(owner(), pipelineId, { source: 'round_robin' })).resolves.toEqual({
      unassigned: 8,
      remaining: 0,
    });
    expect((await owners()).byName).toEqual({ a: 1, none: 8 }); // a's creator deal stays

    await expect(assignment.unassign(owner(), pipelineId, { userId: person.a.id })).resolves.toEqual({
      unassigned: 1,
      remaining: 0,
    });
  });

  it('Access list: added people need CRM access; removing an owner of deals needs a handover', async () => {
    await assignment.setRule(owner(), pipelineId, { rule: 'single_user', singleUserId: person.c.id });
    await addAs(owner(), await newClients(3)); // all to c
    const keep = ['manager', 'a', 'b', 'n', 'i'].map((name) => person[name].id);

    await expect(
      assignment.saveAccessList(owner(), pipelineId, { userIds: [...keep, person.owner.id] }),
    ).rejects.toThrow('Only people with CRM access');
    await expect(assignment.saveAccessList(owner(), pipelineId, { userIds: keep })).rejects.toThrow(
      'unassign them or transfer',
    );

    const list = await assignment.saveAccessList(owner(), pipelineId, {
      userIds: keep,
      handover: { mode: 'transfer', toUserId: person.a.id },
    });
    expect(list.find((p) => p.userId === person.c.id)?.onList).toBe(false);
    expect((await owners()).byName).toEqual({ a: 3 });
    const overview = await assignment.overview(owner(), pipelineId);
    expect(overview).toMatchObject({ rule: 'manual', singleUserId: null }); // the target left

    // Put c back for the other tests.
    await assignment.saveAccessList(owner(), pipelineId, { userIds: [...keep, person.c.id] });
  });

  it('a hand-picked owner is manual; the database refuses an owner who is not on the list', async () => {
    await addAs(owner(), await newClients(1));
    const [{ id: dealId }] = await db.select({ id: crmDeals.id }).from(crmDeals).where(eq(crmDeals.pipelineId, pipelineId));

    const card = await assignment.setDealOwner(owner(), dealId, person.b.id);
    expect(card).toMatchObject({ ownerId: person.b.id, ownerName: 'B', assignmentSource: 'manual' });
    await expect(assignment.setDealOwner(owner(), dealId, person.i.id)).rejects.toThrow('can’t own deals');
    await expect(assignment.setDealOwner(owner(), dealId, null)).resolves.toMatchObject({ ownerId: null });

    await expect(
      db.execute(sql`update crm_deals set owner_id = ${person.owner.id} where id = ${dealId}`),
    ).rejects.toThrow();
  });

  it('a manager who creates a pipeline is on its list; the Owner is not', async () => {
    const byManager = await crm.createPipeline(person.manager.actor, { name: `M ${tag}` });
    const byOwner = await crm.createPipeline(owner(), { name: `O ${tag}` });
    const onList = async (id: string) =>
      (await db.select({ userId: crmPipelineUsers.userId }).from(crmPipelineUsers).where(eq(crmPipelineUsers.pipelineId, id))).map(
        (row) => row.userId,
      );
    expect(await onList(byManager.id)).toEqual([person.manager.id]);
    expect(await onList(byOwner.id)).toEqual([]);
    const [created] = await db.select().from(crmPipelines).where(eq(crmPipelines.id, byManager.id));
    expect(created.createdBy).toBe(person.manager.id);
  });
});
