import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, ilike, inArray, or, type SQL } from 'drizzle-orm';
import type { TenantTx } from '../db/tenant-db.js';
import { clients } from '../db/schema.js';

/** A customer of the company the transaction is scoped to. */
export interface Client {
  id: string;
  tenantId: string;
  name: string;
  email: string | null;
  phone: string | null;
  importId: string | null;
  customDetails: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateClientData {
  tenantId: string;
  name: string;
  email: string | null;
  phone: string | null;
  importId?: string | null;
  customDetails: Record<string, unknown>;
}

export interface UpdateClientData {
  name?: string;
  email?: string | null;
  phone?: string | null;
  customDetails?: Record<string, unknown>;
}

const clientColumns = {
  id: clients.id,
  tenantId: clients.tenantId,
  name: clients.name,
  email: clients.email,
  phone: clients.phone,
  importId: clients.importId,
  customDetails: clients.customDetails,
  createdAt: clients.createdAt,
  updatedAt: clients.updatedAt,
};

/** No query here filters by tenant: RLS in TenantDb does that. */
@Injectable()
export class ClientsRepository {
  /**
   * One page of the company's clients, most recently updated first (then
   * newest added), with the id breaking ties so a row cannot appear on two
   * pages. `q` matches name, email or phone case-insensitively; % and _ typed
   * by the user match literally.
   */
  async page(
    tx: TenantTx,
    page: number,
    pageSize: number,
    q?: string,
    importId?: string,
  ): Promise<{ items: Client[]; total: number }> {
    const conditions: SQL[] = [];
    if (q) {
      const term = q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
      const contains = `%${term}%`;
      conditions.push(
        or(
          ilike(clients.name, contains),
          ilike(clients.email, contains),
          ilike(clients.phone, contains),
        )!,
      );
    }
    if (importId) conditions.push(eq(clients.importId, importId));
    const where = and(...conditions);

    const [items, [{ total }]] = await Promise.all([
      tx
        .select(clientColumns)
        .from(clients)
        .where(where)
        .orderBy(desc(clients.updatedAt), desc(clients.createdAt), desc(clients.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      tx.select({ total: count() }).from(clients).where(where),
    ]);
    return { items, total };
  }

  async find(tx: TenantTx, id: string): Promise<Client | null> {
    const [row] = await tx
      .select(clientColumns)
      .from(clients)
      .where(eq(clients.id, id));
    return row ?? null;
  }

  async findByIds(tx: TenantTx, ids: string[]): Promise<Client[]> {
    if (!ids.length) return [];
    return tx.select(clientColumns).from(clients).where(inArray(clients.id, ids));
  }

  async removeByIds(tx: TenantTx, ids: string[]): Promise<void> {
    if (!ids.length) return;
    await tx.delete(clients).where(inArray(clients.id, ids));
  }

  async create(tx: TenantTx, data: CreateClientData): Promise<Client> {
    const [row] = await tx.insert(clients).values(data).returning(clientColumns);
    return row;
  }

  async update(
    tx: TenantTx,
    id: string,
    patch: UpdateClientData,
  ): Promise<Client | null> {
    const [row] = await tx
      .update(clients)
      .set(patch)
      .where(eq(clients.id, id))
      .returning(clientColumns);
    return row ?? null;
  }

  async remove(tx: TenantTx, id: string): Promise<void> {
    await tx.delete(clients).where(eq(clients.id, id));
  }
}
