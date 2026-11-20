import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client, ClientsRepository } from '../clients/clients.repository.js';
import type { TenantDb, TenantTx } from '../db/tenant-db.js';
import type { Actor } from '../tenancy/tenancy.types.js';
import type {
  CrmDeal,
  CrmDealCard,
  CrmPipeline,
  CrmRepository,
  CrmStage,
} from './crm.repository.js';
import { CrmService } from './crm.service.js';

const actor: Actor = {
  user: {
    id: 'u1',
    email: 'owner@acme.test',
    fullName: 'Owner',
    tenantId: 't1',
    role: 'owner',
    isPlatformAdmin: false,
    isActive: true,
    emailVerified: true,
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  tenant: { id: 't1', name: 'Acme', status: 'active', plan: 'free', createdAt: new Date() },
};

/** Someone with the CRM grant who isn't the owner: pipeline access applies to them. */
const staff: Actor = { ...actor, user: { ...actor.user, id: 'u2', role: 'staff' } };

const tx = {} as TenantTx;

const pipeline = (overrides: Partial<CrmPipeline> = {}): CrmPipeline => ({
  id: 'p1',
  tenantId: 't1',
  name: 'Sales',
  position: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const stage = (overrides: Partial<CrmStage> = {}): CrmStage => ({
  id: 's1',
  tenantId: 't1',
  pipelineId: 'p1',
  name: 'Lead In',
  position: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const client = (overrides: Partial<Client> = {}): Client => ({
  id: 'c1',
  tenantId: 't1',
  name: 'Acme',
  email: 'a@b.co',
  phone: null,
  importId: null,
  customDetails: {},
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const card = (overrides: Partial<CrmDealCard> = {}): CrmDealCard => ({
  id: 'd1',
  pipelineId: 'p1',
  stageId: 's1',
  clientId: 'c1',
  position: 0,
  name: 'Acme',
  email: 'a@b.co',
  phone: null,
  customDetails: {},
  addedAt: new Date(),
  ...overrides,
});

const deal = (overrides: Partial<CrmDeal> = {}): CrmDeal => ({
  id: 'd1',
  tenantId: 't1',
  pipelineId: 'p1',
  stageId: 's1',
  clientId: 'c1',
  position: 0,
  createdBy: 'u1',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

/** A pipeline as the picker gets it. */
const summary = () => ({
  id: 'p1',
  name: 'Sales',
  position: 0,
  stages: [{ id: 's1', name: 'Lead In', position: 0 }],
});

describe('CrmService', () => {
  const run = vi.fn(
    (_tenantId: string, fn: (tx: TenantTx) => Promise<unknown>) => fn(tx),
  );
  const findPipeline = vi.fn<CrmRepository['findPipeline']>();
  const createPipelineIfAbsent = vi.fn<CrmRepository['createPipelineIfAbsent']>();
  const createPipeline = vi.fn<CrmRepository['createPipeline']>();
  const createStages = vi.fn<CrmRepository['createStages']>();
  const findPipelineStages = vi.fn<CrmRepository['findPipelineStages']>();
  const findStage = vi.fn<CrmRepository['findStage']>();
  const findDeal = vi.fn<CrmRepository['findDeal']>();
  const findDealByClient = vi.fn<CrmRepository['findDealByClient']>();
  const nextDealPosition = vi.fn<CrmRepository['nextDealPosition']>();
  const createDeal = vi.fn<CrmRepository['createDeal']>();
  const lockPipeline = vi.fn<CrmRepository['lockPipeline']>();
  const placeDeals = vi.fn<CrmRepository['placeDeals']>();
  const dealIdsInStage = vi.fn<CrmRepository['dealIdsInStage']>();
  const removeDeal = vi.fn<CrmRepository['removeDeal']>();
  const dealCard = vi.fn<CrmRepository['dealCard']>();
  const countDealsInStage = vi.fn<CrmRepository['countDealsInStage']>();
  const removeStage = vi.fn<CrmRepository['removeStage']>();
  const countPipelines = vi.fn<CrmRepository['countPipelines']>();
  const pipelineSummaries = vi.fn<CrmRepository['pipelineSummaries']>();
  const isPipelineMember = vi.fn<CrmRepository['isPipelineMember']>();
  const listCrmEligibleUsers = vi.fn<CrmRepository['listCrmEligibleUsers']>();
  const addPipelineUsers = vi.fn<CrmRepository['addPipelineUsers']>();
  const nextPipelinePosition = vi.fn<CrmRepository['nextPipelinePosition']>();
  const dealCardsForStage = vi.fn<CrmRepository['dealCardsForStage']>();
  const boardColumns = vi.fn<CrmRepository['boardColumns']>();
  const updatePipeline = vi.fn<CrmRepository['updatePipeline']>();
  const removePipeline = vi.fn<CrmRepository['removePipeline']>();
  const removeDealsForPipeline = vi.fn<CrmRepository['removeDealsForPipeline']>();
  const countDealsInPipeline = vi.fn<CrmRepository['countDealsInPipeline']>();
  const countStagesInPipeline = vi.fn<CrmRepository['countStagesInPipeline']>();
  const createStage = vi.fn<CrmRepository['createStage']>();
  const nextStagePosition = vi.fn<CrmRepository['nextStagePosition']>();
  const updateStage = vi.fn<CrmRepository['updateStage']>();
  const findClient = vi.fn<ClientsRepository['find']>();
  const createClient = vi.fn<ClientsRepository['create']>();
  const findClientsByIds = vi.fn<ClientsRepository['findByIds']>();
  const clientIdsWithDealIn = vi.fn<CrmRepository['clientIdsWithDealIn']>();
  const createDeals = vi.fn<CrmRepository['createDeals']>();
  let service: CrmService;

  beforeEach(() => {
    vi.clearAllMocks();
    findPipeline.mockResolvedValue(pipeline());
    createPipelineIfAbsent.mockResolvedValue(pipeline());
    createStages.mockResolvedValue([stage()]);
    findPipelineStages.mockResolvedValue([stage()]);
    findStage.mockResolvedValue(stage());
    findDealByClient.mockResolvedValue(null);
    nextDealPosition.mockResolvedValue(0);
    createDeal.mockResolvedValue({
      id: 'd1',
      tenantId: 't1',
      pipelineId: 'p1',
      stageId: 's1',
      clientId: 'c1',
      position: 0,
      createdBy: 'u1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    dealCard.mockResolvedValue(card());
    lockPipeline.mockResolvedValue(true);
    placeDeals.mockResolvedValue(undefined);
    countDealsInStage.mockResolvedValue(0);
    countPipelines.mockResolvedValue(1);
    pipelineSummaries.mockResolvedValue([summary()]);
    isPipelineMember.mockResolvedValue(true);
    listCrmEligibleUsers.mockResolvedValue([
      { id: 'u2', fullName: 'Asha', email: 'asha@acme.test' },
      { id: 'u3', fullName: 'Ben', email: 'ben@acme.test' },
    ]);
    addPipelineUsers.mockResolvedValue(undefined);
    nextPipelinePosition.mockResolvedValue(1);
    dealCardsForStage.mockResolvedValue([]);
    boardColumns.mockResolvedValue({ stages: [stage()], columns: { s1: [] }, totals: { s1: 0 } });
    createPipeline.mockResolvedValue(pipeline({ id: 'p2', name: 'Partners', position: 1 }));
    findClient.mockResolvedValue(client());
    createClient.mockResolvedValue(client());
    findClientsByIds.mockImplementation(async (_tx, ids) => ids.map((id) => client({ id })));
    clientIdsWithDealIn.mockResolvedValue(new Set());
    createDeals.mockImplementation(async (_tx, rows) => rows.length);
    service = new CrmService(
      { run } as unknown as TenantDb,
      {
        findPipeline,
        createPipelineIfAbsent,
        createPipeline,
        createStages,
        findPipelineStages,
        findStage,
        findDeal,
        findDealByClient,
        nextDealPosition,
        createDeal,
        lockPipeline,
        placeDeals,
        dealIdsInStage,
        removeDeal,
        dealCard,
        countDealsInStage,
        removeStage,
        countPipelines,
        pipelineSummaries,
        isPipelineMember,
        listCrmEligibleUsers,
        addPipelineUsers,
        nextPipelinePosition,
        dealCardsForStage,
        boardColumns,
        updatePipeline,
        removePipeline,
        removeDealsForPipeline,
        countDealsInPipeline,
        countStagesInPipeline,
        createStage,
        nextStagePosition,
        updateStage,
        clientIdsWithDealIn,
        createDeals,
      } as unknown as CrmRepository,
      { find: findClient, create: createClient, findByIds: findClientsByIds } as unknown as ClientsRepository,
    );
  });

  it('seeds the default Sales pipeline the first time the CRM is opened', async () => {
    countPipelines.mockResolvedValue(0);
    pipelineSummaries.mockResolvedValueOnce([]).mockResolvedValueOnce([summary()]);

    const result = await service.listPipelines(actor);

    expect(createPipelineIfAbsent).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ tenantId: 't1', name: 'Sales', position: 0 }),
    );
    expect(createStages).toHaveBeenCalledWith(
      tx,
      expect.arrayContaining([
        expect.objectContaining({ pipelineId: 'p1', name: 'Lead In', position: 0 }),
        expect.objectContaining({ pipelineId: 'p1', name: 'Lost', position: 5 }),
      ]),
    );
    // Everyone who can use the CRM today gets access to the seeded board.
    expect(addPipelineUsers).toHaveBeenCalledWith(tx, [
      { tenantId: 't1', pipelineId: 'p1', userId: 'u2', grantedBy: null },
      { tenantId: 't1', pipelineId: 'p1', userId: 'u3', grantedBy: null },
    ]);
    expect(result).toEqual([
      {
        id: 'p1',
        name: 'Sales',
        position: 0,
        stages: [{ id: 's1', name: 'Lead In', position: 0 }],
      },
    ]);
  });

  it('creates the client and the deal together in the current pipeline', async () => {
    const expected = card();
    dealCard.mockResolvedValue(expected);

    const result = await service.createDeal(actor, {
      pipelineId: 'p1',
      name: 'Acme',
      email: 'a@b.co',
    });

    expect(run).toHaveBeenCalledWith('t1', expect.any(Function));
    expect(createClient).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        tenantId: 't1',
        name: 'Acme',
        email: 'a@b.co',
        phone: null,
        customDetails: {},
      }),
    );
    expect(createDeal).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        tenantId: 't1',
        pipelineId: 'p1',
        stageId: 's1',
        clientId: 'c1',
        createdBy: 'u1',
      }),
    );
    expect(result).toBe(expected);
  });

  it('attaches an existing client in the selected stage', async () => {
    findPipelineStages.mockResolvedValue([
      stage({ id: 's1', position: 0 }),
      stage({ id: 's2', name: 'Qualified', position: 1 }),
    ]);
    findStage.mockResolvedValue(stage({ id: 's2', name: 'Qualified', position: 1 }));
    dealCard.mockResolvedValue(card({ stageId: 's2', position: 4 }));

    await service.createDeal(actor, { pipelineId: 'p1', stageId: 's2', clientId: 'c1' });

    expect(createClient).not.toHaveBeenCalled();
    expect(createDeal).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ stageId: 's2', clientId: 'c1' }),
    );
  });

  it('refuses the same client twice in one pipeline', async () => {
    findDealByClient.mockResolvedValue({
      id: 'd1',
      tenantId: 't1',
      pipelineId: 'p1',
      stageId: 's1',
      clientId: 'c1',
      position: 0,
      createdBy: 'u1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      service.createDeal(actor, { pipelineId: 'p1', clientId: 'c1' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(createDeal).not.toHaveBeenCalled();
  });

  it('requires a contact method when creating a client from the form', async () => {
    await expect(
      service.createDeal(actor, { pipelineId: 'p1', name: 'Acme' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(createClient).not.toHaveBeenCalled();
  });

  it('refuses a stage that belongs to another pipeline', async () => {
    findStage.mockResolvedValue(stage({ id: 's2', pipelineId: 'p2' }));
    findDeal.mockResolvedValue({
      id: 'd1',
      tenantId: 't1',
      pipelineId: 'p1',
      stageId: 's1',
      clientId: 'c1',
      position: 0,
      createdBy: 'u1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      service.moveDeal(actor, 'd1', { stageId: 's2' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(placeDeals).not.toHaveBeenCalled();
  });

  it('re-indexes both stages when a deal moves', async () => {
    findDeal.mockResolvedValue(deal());
    findStage.mockResolvedValue(stage({ id: 's2', name: 'Qualified', position: 1 }));
    dealIdsInStage
      .mockResolvedValueOnce(['d2', 'd3'])
      .mockResolvedValueOnce(['d4']);
    dealCard.mockResolvedValue(card({ stageId: 's2', position: 1 }));

    await service.moveDeal(actor, 'd1', { stageId: 's2', position: 1 });

    expect(dealIdsInStage).toHaveBeenNthCalledWith(1, tx, 's2');
    expect(dealIdsInStage).toHaveBeenNthCalledWith(2, tx, 's1');
    expect(placeDeals.mock.calls).toEqual([
      [tx, 's2', ['d2', 'd1', 'd3']],
      [tx, 's1', ['d4']],
    ]);
  });

  it('locks the pipeline before reading the order, and re-reads the deal under the lock', async () => {
    // Another move put the deal in s3 while this one waited for the lock.
    findDeal
      .mockResolvedValueOnce(deal({ stageId: 's1' }))
      .mockResolvedValueOnce(deal({ stageId: 's3' }));
    findStage.mockResolvedValue(stage({ id: 's2', name: 'Qualified', position: 1 }));
    dealIdsInStage.mockResolvedValueOnce(['d2']).mockResolvedValueOnce(['d5']);

    await service.moveDeal(actor, 'd1', { stageId: 's2', position: 0 });

    expect(lockPipeline).toHaveBeenCalledWith(tx, 'p1');
    const locked = lockPipeline.mock.invocationCallOrder[0];
    expect(findDeal.mock.invocationCallOrder[1]).toBeGreaterThan(locked);
    expect(dealIdsInStage.mock.invocationCallOrder[0]).toBeGreaterThan(locked);
    // The source stage re-indexed is the one the deal is in now, not the stale one.
    expect(dealIdsInStage).toHaveBeenNthCalledWith(2, tx, 's3');
    expect(placeDeals).toHaveBeenNthCalledWith(2, tx, 's3', ['d5']);
  });

  it('reports a deal deleted while the move waited for the lock as not found', async () => {
    findDeal.mockResolvedValueOnce(deal()).mockResolvedValueOnce(null);

    await expect(service.moveDeal(actor, 'd1', { stageId: 's1' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(placeDeals).not.toHaveBeenCalled();
  });

  it('pages one column from the given offset, with its total', async () => {
    dealCardsForStage.mockResolvedValue([card({ id: 'd101' })]);
    countDealsInStage.mockResolvedValue(101);

    const result = await service.stageDeals(actor, 's1', 100, 100);

    expect(dealCardsForStage).toHaveBeenCalledWith(tx, 's1', 100, 100);
    expect(result.items.map((item) => item.id)).toEqual(['d101']);
    expect(result.total).toBe(101);
  });

  it("reports a column in a pipeline you can't see as not found", async () => {
    isPipelineMember.mockResolvedValue(false);

    await expect(service.stageDeals(staff, 's1', 0, 100)).rejects.toBeInstanceOf(NotFoundException);
    expect(dealCardsForStage).not.toHaveBeenCalled();
  });

  it('refuses to delete a stage that still holds deals', async () => {
    countDealsInStage.mockResolvedValue(2);

    await expect(service.deleteStage(actor, 's1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(removeStage).not.toHaveBeenCalled();
  });

  /* ── Pipeline access ─────────────────────────────────────────────────── */

  it('lists every pipeline for the owner and only memberships for everyone else', async () => {
    await service.listPipelines(actor);
    expect(pipelineSummaries).toHaveBeenLastCalledWith(tx, null);

    await service.listPipelines(staff);
    expect(pipelineSummaries).toHaveBeenLastCalledWith(tx, 'u2');
  });

  it('lists pipelines in one query when there are some, without counting', async () => {
    await expect(service.listPipelines(actor)).resolves.toEqual([summary()]);
    expect(pipelineSummaries).toHaveBeenCalledTimes(1);
    expect(countPipelines).not.toHaveBeenCalled();
    expect(createPipelineIfAbsent).not.toHaveBeenCalled();
  });

  it('does not seed a second board when the person just sees no pipelines', async () => {
    countPipelines.mockResolvedValue(3);
    pipelineSummaries.mockResolvedValue([]);

    await expect(service.listPipelines(staff)).resolves.toEqual([]);
    expect(createPipelineIfAbsent).not.toHaveBeenCalled();
  });

  it('never checks membership for the owner', async () => {
    await service.board(actor, 'p1', 100);
    expect(isPipelineMember).not.toHaveBeenCalled();
  });

  it('builds the board from one boardColumns query', async () => {
    boardColumns.mockResolvedValue({
      stages: [stage(), stage({ id: 's2', name: 'Won', position: 1 })],
      columns: { s1: [card()], s2: [] },
      totals: { s1: 140, s2: 0 },
    });

    const result = await service.board(actor, 'p1', 100);

    expect(boardColumns).toHaveBeenCalledWith(tx, 'p1', 100);
    expect(result.stages.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(result.totals).toEqual({ s1: 140, s2: 0 });
    expect(result.columns.s1.map((c) => c.id)).toEqual(['d1']);
  });

  it('reports pipelines, stages and deals outside your access as not found', async () => {
    isPipelineMember.mockResolvedValue(false);
    findDeal.mockResolvedValue({
      id: 'd1',
      tenantId: 't1',
      pipelineId: 'p1',
      stageId: 's1',
      clientId: 'c1',
      position: 0,
      createdBy: 'u1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(service.board(staff, 'p1', 100)).rejects.toBeInstanceOf(NotFoundException);
    expect(boardColumns).not.toHaveBeenCalled();
    await expect(service.searchDeals(staff, 'p1', 'acme', 20)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.deleteStage(staff, 's1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getDeal(staff, 'd1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.moveDeal(staff, 'd1', { stageId: 's1' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.deleteDeal(staff, 'd1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.createDeal(staff, { pipelineId: 'p1', clientId: 'c1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(isPipelineMember).toHaveBeenCalledWith(tx, 'p1', 'u2');
    expect(removeStage).not.toHaveBeenCalled();
    expect(lockPipeline).not.toHaveBeenCalled();
    expect(placeDeals).not.toHaveBeenCalled();
    expect(removeDeal).not.toHaveBeenCalled();
    expect(createDeal).not.toHaveBeenCalled();
  });

  it('keeps managers off pipelines they are not on: shaping routes answer not found too', async () => {
    const manager: Actor = { ...staff, user: { ...staff.user, role: 'manager' } };
    isPipelineMember.mockResolvedValue(false);

    await expect(service.updatePipeline(manager, 'p1', { name: 'Renamed' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.deletePipeline(manager, 'p1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getDeleteImpact(manager, 'p1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.createStage(manager, 'p1', { name: 'Won' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.updateStage(manager, 's1', { name: 'Renamed' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.reorderStages(manager, 'p1', ['s1'])).rejects.toBeInstanceOf(NotFoundException);

    expect(isPipelineMember).toHaveBeenCalledWith(tx, 'p1', 'u2');
    expect(updatePipeline).not.toHaveBeenCalled();
    expect(removeDealsForPipeline).not.toHaveBeenCalled();
    expect(removePipeline).not.toHaveBeenCalled();
    expect(countDealsInPipeline).not.toHaveBeenCalled();
    expect(countStagesInPipeline).not.toHaveBeenCalled();
    expect(createStage).not.toHaveBeenCalled();
    expect(updateStage).not.toHaveBeenCalled();
  });

  it('saves the chosen people as the access list of the new pipeline', async () => {
    await service.createPipeline(actor, { name: 'Partners', stages: ['Intro'], userIds: ['u2', 'u3', 'u2'] });

    expect(addPipelineUsers).toHaveBeenCalledWith(tx, [
      { tenantId: 't1', pipelineId: 'p2', userId: 'u2', grantedBy: 'u1' },
      { tenantId: 't1', pipelineId: 'p2', userId: 'u3', grantedBy: 'u1' },
    ]);
  });

  it('refuses access for someone without the CRM grant', async () => {
    await expect(
      service.createPipeline(actor, { name: 'Partners', stages: ['Intro'], userIds: ['u2', 'u9'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(createPipeline).not.toHaveBeenCalled();
    expect(addPipelineUsers).not.toHaveBeenCalled();
  });

  it('creates a pipeline with no one on it when nobody is chosen', async () => {
    await service.createPipeline(actor, { name: 'Partners', stages: ['Intro'] });

    expect(listCrmEligibleUsers).not.toHaveBeenCalled();
    expect(createPipeline).toHaveBeenCalled();
    expect(addPipelineUsers).toHaveBeenCalledWith(tx, []);
  });

  /* ── Bulk add from the Clients page ──────────────────────────────────── */

  it('adds clients at the end of the first stage and skips ones already in the pipeline', async () => {
    findClientsByIds.mockResolvedValue([client({ id: 'c1' }), client({ id: 'c2' }), client({ id: 'c3' })]);
    clientIdsWithDealIn.mockResolvedValue(new Set(['c2']));
    nextDealPosition.mockResolvedValue(7);

    const result = await service.addDeals(actor, { pipelineId: 'p1', clientIds: ['c1', 'c2', 'c3', 'c9'] });

    expect(createDeals).toHaveBeenCalledWith(tx, [
      expect.objectContaining({ pipelineId: 'p1', stageId: 's1', clientId: 'c1', position: 7, createdBy: 'u1' }),
      expect.objectContaining({ pipelineId: 'p1', stageId: 's1', clientId: 'c3', position: 8, createdBy: 'u1' }),
    ]);
    expect(result).toEqual({ added: 2, alreadyInPipeline: 1, notFound: 1 });
  });

  it('lands the deals in the chosen stage', async () => {
    findPipelineStages.mockResolvedValue([stage({ id: 's1' }), stage({ id: 's2', name: 'Qualified', position: 1 })]);

    await service.addDeals(actor, { pipelineId: 'p1', stageId: 's2', clientIds: ['c1'] });

    expect(createDeals).toHaveBeenCalledWith(tx, [expect.objectContaining({ stageId: 's2', clientId: 'c1' })]);
  });

  it('counts a client that got a deal meanwhile as already in the pipeline', async () => {
    createDeals.mockResolvedValue(1);

    const result = await service.addDeals(actor, { pipelineId: 'p1', clientIds: ['c1', 'c2'] });

    expect(result).toEqual({ added: 1, alreadyInPipeline: 1, notFound: 0 });
  });

  it('refuses a stage from another pipeline', async () => {
    await expect(
      service.addDeals(actor, { pipelineId: 'p1', stageId: 's9', clientIds: ['c1'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(createDeals).not.toHaveBeenCalled();
  });

  it('reports a pipeline outside your access as not found', async () => {
    isPipelineMember.mockResolvedValue(false);

    await expect(
      service.addDeals(staff, { pipelineId: 'p1', clientIds: ['c1'] }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(createDeals).not.toHaveBeenCalled();
  });
});
