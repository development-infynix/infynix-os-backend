import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import { accessItems, userAccess } from '../db/schema.js';
import type { TenantTx } from '../db/tenant-db.js';
import type { AccessItem, AccessKind } from './access.types.js';

const itemColumns = {
  id: accessItems.id,
  key: accessItems.key,
  label: accessItems.label,
  kind: accessItems.kind,
  sortOrder: accessItems.sortOrder,
  isActive: accessItems.isActive,
};

/**
 * SQL for the access list. Global definitions are read on the owner
 * connection; grants are read and written inside a TenantDb transaction so
 * row-level security keeps one company's grants away from another's.
 */
@Injectable()
export class AccessRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /** The active access list, in sidebar order. Omit `kind` for everything. */
  listActive(kind?: AccessKind): Promise<AccessItem[]> {
    return this.db
      .select(itemColumns)
      .from(accessItems)
      .where(
        kind
          ? and(eq(accessItems.kind, kind), eq(accessItems.isActive, true))
          : eq(accessItems.isActive, true),
      )
      .orderBy(asc(accessItems.sortOrder), asc(accessItems.label));
  }

  /** Keys granted to a person, in sidebar order. */
  keysForUser(tx: TenantTx, userId: string): Promise<string[]> {
    return tx
      .select({ key: accessItems.key })
      .from(userAccess)
      .innerJoin(accessItems, eq(userAccess.accessItemId, accessItems.id))
      .where(and(eq(userAccess.userId, userId), eq(accessItems.isActive, true)))
      .orderBy(asc(accessItems.sortOrder), asc(accessItems.label))
      .then((rows) => rows.map((row) => row.key));
  }

  /** Resolves keys to active menu items; unknown or inactive keys are absent. */
  findActiveMenusByKeys(tx: TenantTx, keys: string[]): Promise<AccessItem[]> {
    if (keys.length === 0) return Promise.resolve([]);
    return tx
      .select(itemColumns)
      .from(accessItems)
      .where(
        and(
          inArray(accessItems.key, keys),
          eq(accessItems.kind, 'menu'),
          eq(accessItems.isActive, true),
        ),
      );
  }

  /** Replaces every grant for a person in one transaction. */
  async replaceForUser(
    tx: TenantTx,
    data: {
      tenantId: string;
      userId: string;
      itemIds: string[];
      grantedBy: string;
    },
  ): Promise<void> {
    await tx.delete(userAccess).where(eq(userAccess.userId, data.userId));
    if (data.itemIds.length === 0) return;
    await tx.insert(userAccess).values(
      data.itemIds.map((accessItemId) => ({
        tenantId: data.tenantId,
        userId: data.userId,
        accessItemId,
        grantedBy: data.grantedBy,
      })),
    );
  }
}
