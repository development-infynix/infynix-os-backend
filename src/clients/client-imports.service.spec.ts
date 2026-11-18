import { NotFoundException } from '@nestjs/common';
import { SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ClientImport,
  type ClientImportSummary,
  ClientImportsRepository,
} from './client-imports.repository.js';
import { ClientImportsService } from './client-imports.service.js';
import type { TenantDb, TenantTx } from '../db/tenant-db.js';
import type { Actor } from '../tenancy/tenancy.types.js';

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
const summary: ClientImportSummary = {
  id: 'i1',
  name: 'Contacts',
  fileName: 'contacts.csv',
  rowCount: 3,
  createdCount: 0,
  skippedCount: 0,
  createdAt: new Date(),
};
const withRows: ClientImport = { ...summary, rows: [] };

describe('ClientImportsService', () => {
  const create = vi.fn<ClientImportsRepository['create']>();
  const list = vi.fn<ClientImportsRepository['list']>();
  const find = vi.fn<ClientImportsRepository['find']>();
  const removeWithClients = vi.fn<ClientImportsRepository['removeWithClients']>();
  const run = vi.fn(
    (_tenantId: string, fn: (tx: TenantTx) => Promise<unknown>) => fn(tx),
  );
  let service: ClientImportsService;

  beforeEach(() => {
    vi.clearAllMocks();
    create.mockResolvedValue(summary);
    list.mockResolvedValue([summary]);
    find.mockResolvedValue(withRows);
    removeWithClients.mockResolvedValue(3);
    service = new ClientImportsService(
      { run } as unknown as TenantDb,
      { create, list, find, removeWithClients } as unknown as ClientImportsRepository,
    );
  });

  it('creates an empty import attributed to the actor in their tenant', async () => {
    await expect(
      service.create(actor, { name: 'Contacts', fileName: 'contacts.csv', rowCount: 3 }),
    ).resolves.toBe(summary);

    expect(run).toHaveBeenCalledWith('t1', expect.any(Function));
    expect(create).toHaveBeenCalledWith(tx, {
      tenantId: 't1',
      name: 'Contacts',
      fileName: 'contacts.csv',
      rowCount: 3,
      createdBy: 'u1',
    });
  });

  it('lists summaries and returns stored rows only on the detail path', async () => {
    await expect(service.list(actor)).resolves.toEqual([summary]);
    await expect(service.get(actor, 'i1')).resolves.toBe(withRows);
    expect(find).toHaveBeenCalledWith(tx, 'i1');
  });

  it('does not reveal imports of another tenant', async () => {
    find.mockResolvedValue(null);
    await expect(service.get(actor, 'other')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('removes an import together with its linked clients', async () => {
    await expect(service.remove(actor, 'i1')).resolves.toBe(3);
    expect(find).toHaveBeenCalledWith(tx, 'i1');
    expect(removeWithClients).toHaveBeenCalledWith(tx, 'i1');
  });
});

describe('ClientImportsRepository.recordChunk', () => {
  it('increments both counters with SQL expressions in one update', async () => {
    const set = vi.fn();
    const where = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn(() => ({ set: (...args: unknown[]) => { set(...args); return { where }; } }));
    const updateTx = { update } as unknown as TenantTx;
    const repo = new ClientImportsRepository();

    await repo.recordChunk(updateTx, 'i1', 2, 1, []);

    const values = set.mock.calls[0][0] as Record<string, unknown>;
    expect(update).toHaveBeenCalledOnce();
    expect(values.createdCount).toBeInstanceOf(SQL);
    expect(values.skippedCount).toBeInstanceOf(SQL);
    expect(values.rows).toBeInstanceOf(SQL);
    expect(where).toHaveBeenCalledOnce();
  });
});
