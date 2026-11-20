import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
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
  const idsForImport = vi.fn<ClientsRepository['idsForImport']>();
  const findImport = vi.fn<ClientImportsRepository['find']>();
  const findDuplicate = vi.fn<ClientsRepository['findDuplicate']>();
  const importRows = vi.fn<ClientsRepository['importRows']>();
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
    findDuplicate.mockResolvedValue(null);
    importRows.mockImplementation(async (_tx, data) => ({
      created: data.rows.length,
      duplicates: data.repeatedInChunk,
      existingIds: [],
    }));
    service = new ClientsService(
      { run } as unknown as TenantDb,
      { find, create, update, remove, idsForImport, findDuplicate, importRows } as unknown as ClientsRepository,
      { find: findImport } as unknown as ClientImportsRepository,
    );
  });

  it('lists the client ids of one import inside the actor tenant', async () => {
    idsForImport.mockResolvedValue(['c1', 'c2']);

    await expect(service.idsForImport(actor, 'i1')).resolves.toEqual(['c1', 'c2']);
    expect(run).toHaveBeenCalledWith('t1', expect.any(Function));
    expect(idsForImport).toHaveBeenCalledWith(tx, 'i1');
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

  it('refuses to add a client whose email or phone is already in the directory', async () => {
    findDuplicate.mockResolvedValue({ id: 'c9', name: 'Vishnu Nair', matchedOn: 'email' });

    await expect(service.create(actor, { name: 'Vishnu', email: 'VISHNU@x.com' })).rejects.toThrow(
      'A client with this email already exists: Vishnu Nair.',
    );
    expect(findDuplicate).toHaveBeenCalledWith(tx, 't1', { email: 'VISHNU@x.com', phone: null });
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses an edit that would copy another client\'s phone, ignoring the client itself', async () => {
    find.mockResolvedValue(client({ email: 'a@b.co', phone: null }));
    findDuplicate.mockResolvedValue({ id: 'c9', name: 'Ben', matchedOn: 'phone' });

    await expect(service.update(actor, 'c1', { phone: '+91 1111' })).rejects.toBeInstanceOf(ConflictException);
    expect(findDuplicate).toHaveBeenCalledWith(tx, 't1', { email: 'a@b.co', phone: '+91 1111' }, 'c1');
    expect(update).not.toHaveBeenCalled();
  });

  it('imports a chunk in one statement: invalid rows skipped, repeats inside the chunk dropped', async () => {
    importRows.mockResolvedValue({ created: 1, duplicates: 2, existingIds: ['c7'] });
    const rows = [
      { name: 'Good', email: 'A@B.CO', customDetails: { tier: 'gold' } },
      { name: 'No contact' },
      { name: 'Bad email', email: 'not-an-email' },
      // Same person as row 1 (email differs only in case): never sent to the database.
      { name: 'Good again', email: ' a@b.co ' },
      { name: 'Known', phone: '+91 80035 09196' },
    ] as ImportClientRowDto[];

    await expect(service.importChunk(actor, { importId: 'i1', clients: rows })).resolves.toEqual({
      created: 1,
      skipped: 2,
      duplicates: 2,
      existingClientIds: ['c7'],
    });
    expect(create).not.toHaveBeenCalled();
    expect(importRows).toHaveBeenCalledWith(tx, {
      tenantId: 't1',
      importId: 'i1',
      rows: [
        { name: 'Good', email: 'A@B.CO', phone: null, customDetails: { tier: 'gold' } },
        { name: 'Known', email: null, phone: '+91 80035 09196', customDetails: {} },
      ],
      invalid: 2,
      repeatedInChunk: 1,
      storedRows: [
        { name: 'Good', email: 'A@B.CO', phone: null, customDetails: { tier: 'gold' } },
        { name: 'No contact', email: null, phone: null, customDetails: {} },
        { name: 'Bad email', email: 'not-an-email', phone: null, customDetails: {} },
        { name: 'Good again', email: 'a@b.co', phone: null, customDetails: {} },
        { name: 'Known', email: null, phone: '+91 80035 09196', customDetails: {} },
      ],
    });
  });

  it('rejects a chunk whose import is not in the actor tenant', async () => {
    importRows.mockResolvedValue(null);
    const rows = [{ name: 'Good', email: 'a@b.co' }] as ImportClientRowDto[];

    await expect(service.importChunk(actor, { importId: 'missing', clients: rows })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects an update that would remove the last contact method', async () => {
    find.mockResolvedValue(client({ email: 'a@b.co', phone: null }));

    await expect(service.update(actor, 'c1', { email: '   ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(update).not.toHaveBeenCalled();
  });
});
