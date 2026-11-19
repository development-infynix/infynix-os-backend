import { BadRequestException, ConflictException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client, ClientsRepository } from '../clients/clients.repository.js';
import type { TenantDb, TenantTx } from '../db/tenant-db.js';
import type { Actor } from '../tenancy/tenancy.types.js';
import type {
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

describe('CrmService', () => {
  const run = vi.fn(
    (_tenantId: string, fn: (tx: TenantTx) => Promise<unknown>) => fn(tx),
  );
  const findPipeline = vi.fn<CrmRepository['findPipeline']>();
  const listPipelines = vi.fn<CrmRepository['listPipelines']>();
  const listStages = vi.fn<CrmRepository['listStages']>();
  const createPipelineIfAbsent = vi.fn<CrmRepository['createPipelineIfAbsent']>();
  const createPipeline = vi.fn<CrmRepository['createPipeline']>();
  const createStages = vi.fn<CrmRepository['createStages']>();
  const findPipelineStages = vi.fn<CrmRepository['findPipelineStages']>();
  const findStage = vi.fn<CrmRepository['findStage']>();
  const findDeal = vi.fn<CrmRepository['findDeal']>();
  const findDealByClient = vi.fn<CrmRepository['findDealByClient']>();
  const nextDealPosition = vi.fn<CrmRepository['nextDealPosition']>();
  const createDeal = vi.fn<CrmRepository['createDeal']>();
  const moveDeal = vi.fn<CrmRepository['moveDeal']>();
  const dealIdsInStage = vi.fn<CrmRepository['dealIdsInStage']>();
  const removeDeal = vi.fn<CrmRepository['removeDeal']>();
  const dealCard = vi.fn<CrmRepository['dealCard']>();
  const countDealsInStage = vi.fn<CrmRepository['countDealsInStage']>();
  const removeStage = vi.fn<CrmRepository['removeStage']>();
  const findClient = vi.fn<ClientsRepository['find']>();
  const createClient = vi.fn<ClientsRepository['create']>();
  let service: CrmService;

  beforeEach(() => {
    vi.clearAllMocks();
    findPipeline.mockResolvedValue(pipeline());
    listPipelines.mockResolvedValue([pipeline()]);
    listStages.mockResolvedValue([stage()]);
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
    countDealsInStage.mockResolvedValue(0);
    findClient.mockResolvedValue(client());
    createClient.mockResolvedValue(client());
    service = new CrmService(
      { run } as unknown as TenantDb,
      {
        findPipeline,
        listPipelines,
        listStages,
        createPipelineIfAbsent,
        createPipeline,
        createStages,
        findPipelineStages,
        findStage,
        findDeal,
        findDealByClient,
        nextDealPosition,
        createDeal,
        moveDeal,
        dealIdsInStage,
        removeDeal,
        dealCard,
        countDealsInStage,
        removeStage,
      } as unknown as CrmRepository,
      { find: findClient, create: createClient } as unknown as ClientsRepository,
    );
  });

  it('seeds the default Sales pipeline the first time the CRM is opened', async () => {
    listPipelines.mockResolvedValueOnce([]);

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
    expect(moveDeal).not.toHaveBeenCalled();
  });

  it('re-indexes both stages when a deal moves', async () => {
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
    findStage.mockResolvedValue(stage({ id: 's2', name: 'Qualified', position: 1 }));
    moveDeal.mockResolvedValue({
      id: 'd1',
      tenantId: 't1',
      pipelineId: 'p1',
      stageId: 's2',
      clientId: 'c1',
      position: 0,
      createdBy: 'u1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    dealIdsInStage
      .mockResolvedValueOnce(['d2', 'd3'])
      .mockResolvedValueOnce(['d4']);
    dealCard.mockResolvedValue(card({ stageId: 's2', position: 1 }));

    await service.moveDeal(actor, 'd1', { stageId: 's2', position: 1 });

    expect(dealIdsInStage).toHaveBeenNthCalledWith(1, tx, 's2');
    expect(dealIdsInStage).toHaveBeenNthCalledWith(2, tx, 's1');
    expect(moveDeal.mock.calls).toEqual([
      [tx, 'd2', 's2', 0],
      [tx, 'd1', 's2', 1],
      [tx, 'd3', 's2', 2],
      [tx, 'd4', 's1', 0],
    ]);
  });

  it('refuses to delete a stage that still holds deals', async () => {
    countDealsInStage.mockResolvedValue(2);

    await expect(service.deleteStage(actor, 's1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(removeStage).not.toHaveBeenCalled();
  });
});
