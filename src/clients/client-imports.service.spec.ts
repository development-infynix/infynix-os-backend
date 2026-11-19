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
  const exists = vi.fn<ClientImportsRepository['exists']>();
  const deleteClientChunk = vi.fn<ClientImportsRepository['deleteClientChunk']>();
  const search = vi.fn<ClientImportsRepository['search']>();
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
    exists.mockResolvedValue(true);
    deleteClientChunk.mockResolvedValue({ deleted: 100, remaining: 20 });
    service = new ClientImportsService(
      { run } as unknown as TenantDb,
      { create, list, find, removeWithClients, exists, deleteClientChunk, search } as unknown as ClientImportsRepository,
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

  it('pages the import search and says whether more remain', async () => {
    search.mockResolvedValue({ items: [summary], total: 45 });
    const query = { q: 'acme', page: 2, pageSize: 20, withClients: true };

    await expect(service.search(actor, query)).resolves.toEqual({
      items: [summary],
      total: 45,
      page: 2,
      pageSize: 20,
      hasMore: true,
    });
    expect(search).toHaveBeenCalledWith(tx, query);

    search.mockResolvedValue({ items: [summary], total: 41 });
    await expect(service.search(actor, { ...query, page: 3 })).resolves.toMatchObject({ hasMore: false });
  });

  it('removes an import together with its linked clients', async () => {
    await expect(service.remove(actor, 'i1')).resolves.toBe(3);
    expect(exists).toHaveBeenCalledWith(tx, 'i1');
    expect(find).not.toHaveBeenCalled();
    expect(removeWithClients).toHaveBeenCalledWith(tx, 'i1');
  });

  it('deletes a chunk of an import without loading its stored rows', async () => {
    await expect(service.deleteClientChunk(actor, 'i1', 100)).resolves.toEqual({ deleted: 100, remaining: 20 });
    expect(exists).toHaveBeenCalledWith(tx, 'i1');
    expect(find).not.toHaveBeenCalled();
    expect(deleteClientChunk).toHaveBeenCalledWith(tx, 'i1', 100);
  });

  it('refuses to delete from an import of another tenant', async () => {
    exists.mockResolvedValue(false);
    await expect(service.deleteClientChunk(actor, 'other', 100)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove(actor, 'other')).rejects.toBeInstanceOf(NotFoundException);
    expect(deleteClientChunk).not.toHaveBeenCalled();
    expect(removeWithClients).not.toHaveBeenCalled();
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

describe('ClientImportsRepository.deleteClientChunk', () => {
  const fakeTx = (batch: { id: string }[], remaining: number) => {
    const limit = vi.fn().mockResolvedValue(batch);
    const countWhere = vi.fn().mockResolvedValue([{ value: remaining }]);
    let selects = 0;
    const select = vi.fn(() => ({
      from: () => ({
        where: (...args: unknown[]) => (++selects === 1 ? { limit } : countWhere(...args)),
      }),
    }));
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const del = vi.fn(() => ({ where: deleteWhere }));
    return { tx: { select, delete: del } as unknown as TenantTx, del };
  };

  it('lowers the import created count by the clients it deleted', async () => {
    const { tx: chunkTx, del } = fakeTx([{ id: 'c1' }, { id: 'c2' }], 5);
    const repo = new ClientImportsRepository();
    const decrement = vi.spyOn(repo, 'decrementCreated').mockResolvedValue(undefined);

    await expect(repo.deleteClientChunk(chunkTx, 'i1', 100)).resolves.toEqual({ deleted: 2, remaining: 5 });
    expect(del).toHaveBeenCalledOnce();
    expect(decrement).toHaveBeenCalledWith(chunkTx, 'i1', 2);
  });

  it('leaves the count alone when nothing is left to delete', async () => {
    const { tx: chunkTx, del } = fakeTx([], 0);
    const repo = new ClientImportsRepository();
    const decrement = vi.spyOn(repo, 'decrementCreated').mockResolvedValue(undefined);

    await expect(repo.deleteClientChunk(chunkTx, 'i1', 100)).resolves.toEqual({ deleted: 0, remaining: 0 });
    expect(del).not.toHaveBeenCalled();
    expect(decrement).not.toHaveBeenCalled();
  });
});
