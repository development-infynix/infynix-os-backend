import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientImport, ClientImportsRepository } from './client-imports.repository.js';
import type { TenantDb, TenantTx } from '../db/tenant-db.js';
import type { Actor } from '../tenancy/tenancy.types.js';
import type { Client, ClientsRepository } from './clients.repository.js';
import type { ImportClientRowDto } from './dto/clients.dto.js';
import {
  assertContact,
  ClientsService,
  normalizeContact,
} from './clients.service.js';

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
const client = (overrides: Partial<Client> = {}): Client => ({
  id: 'c1',
  tenantId: 't1',
  name: 'Acme',
  email: 'old@acme.test',
  phone: null,
  importId: null,
  customDetails: { tier: 'gold' },
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('client contact rules', () => {
  it('normalizes blank optional contacts to null', () => {
    expect(normalizeContact('  A@B.CO  ')).toBe('A@B.CO');
    expect(normalizeContact('   ')).toBeNull();
    expect(normalizeContact(undefined)).toBeNull();
  });

  it('requires at least one contact method', () => {
    expect(() => assertContact(null, null)).toThrow(BadRequestException);
    expect(() => assertContact('a@b.co', null)).not.toThrow();
    expect(() => assertContact(null, '123')).not.toThrow();
  });
});

describe('ClientsService', () => {
  const find = vi.fn<ClientsRepository['find']>();
  const create = vi.fn<ClientsRepository['create']>();
  const update = vi.fn<ClientsRepository['update']>();
  const remove = vi.fn<ClientsRepository['remove']>();
  const findImport = vi.fn<ClientImportsRepository['find']>();
  const recordChunk = vi.fn<ClientImportsRepository['recordChunk']>();
  const importExists = vi.fn<ClientImportsRepository['exists']>();
  const createMany = vi.fn<ClientsRepository['createMany']>();
  const importRow: ClientImport = {
    id: 'i1',
    name: 'Contacts',
    fileName: 'contacts.csv',
    rowCount: 3,
    createdCount: 0,
    skippedCount: 0,
    createdAt: new Date(),
    rows: [],
  };
  const run = vi.fn(
    (_tenantId: string, fn: (tx: TenantTx) => Promise<unknown>) => fn(tx),
  );
  let service: ClientsService;

  beforeEach(() => {
    vi.clearAllMocks();
    findImport.mockResolvedValue(importRow);
    recordChunk.mockResolvedValue(undefined);
    importExists.mockResolvedValue(true);
    createMany.mockImplementation(async (_tx, data) => data.length);
    service = new ClientsService(
      { run } as unknown as TenantDb,
      { find, create, createMany, update, remove } as unknown as ClientsRepository,
      { find: findImport, exists: importExists, recordChunk } as unknown as ClientImportsRepository,
    );
  });

  it('creates in the actor tenant, normalizing contacts and keeping customDetails', async () => {
    const customDetails = { source: 'import', tags: ['vip'] };
    create.mockResolvedValue(client({ customDetails }));

    await service.create(actor, {
      name: 'Acme',
      email: '  A@B.CO ',
      customDetails,
    });

    expect(run).toHaveBeenCalledWith('t1', expect.any(Function));
    expect(create).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        tenantId: 't1',
        email: 'A@B.CO',
        phone: null,
        customDetails,
      }),
    );
  });

  it('keeps customDetails and the stored contact when patching only the name', async () => {
    const existing = client({ email: null, phone: ' 123 ', customDetails: { a: 1 } });
    find.mockResolvedValue(existing);
    update.mockResolvedValue(existing);

    await service.update(actor, 'c1', { name: 'New name' });

    expect(update).toHaveBeenCalledWith(tx, 'c1', {
      name: 'New name',
      email: null,
      phone: ' 123 ',
    });
  });

  it('imports valid rows from a chunk, skips unusable ones and updates the import', async () => {
    const rows = [
      { name: 'Good', email: 'A@B.CO', customDetails: { tier: 'gold' } },
      { name: 'No contact' },
      { name: 'Bad email', email: 'not-an-email' },
    ] as ImportClientRowDto[];

    await expect(service.importChunk(actor, { importId: 'i1', clients: rows })).resolves.toEqual({
      created: 1,
      skipped: 2,
    });
    expect(importExists).toHaveBeenCalledWith(tx, 'i1');
    expect(findImport).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany).toHaveBeenCalledWith(tx, [
      expect.objectContaining({
        tenantId: 't1',
        importId: 'i1',
        email: 'A@B.CO',
        name: 'Good',
        customDetails: { tier: 'gold' },
      }),
    ]);
    expect(recordChunk).toHaveBeenCalledWith(tx, 'i1', 1, 2, [
      { name: 'Good', email: 'A@B.CO', phone: null, customDetails: { tier: 'gold' } },
      { name: 'No contact', email: null, phone: null, customDetails: {} },
      { name: 'Bad email', email: 'not-an-email', phone: null, customDetails: {} },
    ]);
  });

  it('rejects a chunk whose import is not in the actor tenant', async () => {
    importExists.mockResolvedValue(false);
    const rows = [{ name: 'Good', email: 'a@b.co' }] as ImportClientRowDto[];

    await expect(service.importChunk(actor, { importId: 'missing', clients: rows })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(createMany).not.toHaveBeenCalled();
    expect(recordChunk).not.toHaveBeenCalled();
  });

  it('rejects an update that would remove the last contact method', async () => {
    find.mockResolvedValue(client({ email: 'a@b.co', phone: null }));

    await expect(service.update(actor, 'c1', { email: '   ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(update).not.toHaveBeenCalled();
  });
});
