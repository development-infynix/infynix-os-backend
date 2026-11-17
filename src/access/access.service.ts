import { BadRequestException, Injectable } from '@nestjs/common';
import { TenantDb, type TenantTx } from '../db/tenant-db.js';
import type { AuthUser } from '../users/user.types.js';
import { AccessRepository } from './access.repository.js';
import type { AccessItem } from './access.types.js';

/**
 * The access list and a person's grants.
 *
 * Owners are implicit: they hold every active item without rows in
 * `user_access`, so they can never lock themselves out. Managers and staff
 * start with nothing and receive menus from their owner.
 */
@Injectable()
export class AccessService {
  constructor(
    private readonly access: AccessRepository,
    private readonly tenantDb: TenantDb,
  ) {}

  /** The menus shown on the owner's grant screen. */
  menuItems(): Promise<AccessItem[]> {
    return this.access.listActive('menu');
  }

  /** Every key this person may use, in sidebar order. */
  async keysFor(user: AuthUser): Promise<string[]> {
    if (user.role === 'owner') {
      return (await this.access.listActive()).map((item) => item.key);
    }
    return this.tenantDb.run(user.tenantId, (tx) =>
      this.access.keysForUser(tx, user.id),
    );
  }

  /** Keys already granted to one person (owners are handled by the caller). */
  grantedKeys(tx: TenantTx, userId: string): Promise<string[]> {
    return this.access.keysForUser(tx, userId);
  }

  /**
   * Makes `keys` the person's complete menu access. Throws when a key is not
   * an active menu, so the UI can't invent access items.
   */
  async replace(
    tx: TenantTx,
    data: {
      tenantId: string;
      userId: string;
      grantedBy: string;
      keys: string[];
    },
  ): Promise<void> {
    const items = await this.access.findActiveMenusByKeys(tx, data.keys);
    if (items.length !== data.keys.length) {
      const known = new Set(items.map((item) => item.key));
      const unknown = data.keys.filter((key) => !known.has(key));
      throw new BadRequestException(
        `Unknown menu access: ${unknown.join(', ')}`,
      );
    }
    await this.access.replaceForUser(tx, {
      tenantId: data.tenantId,
      userId: data.userId,
      itemIds: items.map((item) => item.id),
      grantedBy: data.grantedBy,
    });
  }
}
