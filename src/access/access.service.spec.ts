import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantDb, TenantTx } from '../db/tenant-db.js';
import type { AuthUser } from '../users/user.types.js';
import type { AccessRepository } from './access.repository.js';
import { AccessService } from './access.service.js';
import type { AccessItem } from './access.types.js';

const item = (key: string, id = `id-${key}`): AccessItem => ({
  id,
  key,
  label: key,
  kind: 'menu',
  sortOrder: 10,
  isActive: true,
});

const user = (role: AuthUser['role']): AuthUser => ({
  id: 'u2',
  email: 'a@b.co',
  fullName: 'A',
  tenantId: 't1',
  role,
  isPlatformAdmin: false,
  isActive: true,
  emailVerified: true,
  lastLoginAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('AccessService', () => {
  const tx = {} as TenantTx;
  const listActive = vi.fn<AccessRepository['listActive']>();
  const keysForUser = vi.fn<AccessRepository['keysForUser']>();
  const findActiveMenusByKeys = vi.fn<
    AccessRepository['findActiveMenusByKeys']
  >();
  const replaceForUser = vi.fn<AccessRepository['replaceForUser']>();
  const run = vi.fn(
    (_tenantId: string, fn: (tx: TenantTx) => Promise<unknown>) => fn(tx),
  );
  let service: AccessService;

  beforeEach(() => {
    vi.clearAllMocks();
    const repo = {
      listActive,
      keysForUser,
      findActiveMenusByKeys,
      replaceForUser,
    } as unknown as AccessRepository;
    const tenantDb = { run } as unknown as TenantDb;
    service = new AccessService(repo, tenantDb);
  });

  it('gives owners every active item without reading grants', async () => {
    listActive.mockResolvedValue([item('clients'), item('crm')]);

    await expect(service.keysFor(user('owner'))).resolves.toEqual([
      'clients',
      'crm',
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  it('reads a manager or staff grant inside the tenant transaction', async () => {
    keysForUser.mockResolvedValue(['crm']);

    await expect(service.keysFor(user('staff'))).resolves.toEqual(['crm']);
    expect(run).toHaveBeenCalledWith('t1', expect.any(Function));
    expect(keysForUser).toHaveBeenCalledWith(tx, 'u2');
  });

  it('replaces the whole set with the resolved menu ids', async () => {
    findActiveMenusByKeys.mockResolvedValue([
      item('clients', 'a'),
      item('crm', 'b'),
    ]);

    await service.replace(tx, {
      tenantId: 't1',
      userId: 'u2',
      grantedBy: 'u1',
      keys: ['clients', 'crm'],
    });

    expect(replaceForUser).toHaveBeenCalledWith(tx, {
      tenantId: 't1',
      userId: 'u2',
      grantedBy: 'u1',
      itemIds: ['a', 'b'],
    });
  });

  it('rejects the whole request when any key is unknown or inactive', async () => {
    findActiveMenusByKeys.mockResolvedValue([item('clients')]);

    await expect(
      service.replace(tx, {
        tenantId: 't1',
        userId: 'u2',
        grantedBy: 'u1',
        keys: ['clients', 'bogus'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(replaceForUser).not.toHaveBeenCalled();
  });
});
