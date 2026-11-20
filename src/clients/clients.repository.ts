import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { TenantTx } from '../db/tenant-db.js';
import { clientImports, clients } from '../db/schema.js';

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

    // The total rides along on every row (a window count runs before LIMIT), so
    // the page and its total are one round trip instead of two.
    const rows = await tx
      .select({ ...clientColumns, total: sql<number>`count(*) over ()`.mapWith(Number) })
      .from(clients)
      .where(where)
      .orderBy(desc(clients.updatedAt), desc(clients.createdAt), desc(clients.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    if (rows.length) {
      const total = rows[0].total;
      return { items: rows.map(({ total: _total, ...client }) => client), total };
    }
    // An empty page carries no total. Page 1 empty means none match; past the
    // end (e.g. after a delete) still needs the count for the footer.
    if (page === 1) return { items: [], total: 0 };
    const [{ total }] = await tx.select({ total: count() }).from(clients).where(where);
    return { items: [], total };
  }

  async find(tx: TenantTx, id: string): Promise<Client | null> {
    const [row] = await tx
      .select(clientColumns)
      .from(clients)
      .where(eq(clients.id, id));
    return row ?? null;
  }

  /** Every client id that came from one import (selection by import). */
  async idsForImport(tx: TenantTx, importId: string): Promise<string[]> {
    const rows = await tx
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.importId, importId))
      .orderBy(desc(clients.createdAt), desc(clients.id));
    return rows.map((row) => row.id);
  }

  async findByIds(tx: TenantTx, ids: string[]): Promise<Client[]> {
    if (!ids.length) return [];
    return tx.select(clientColumns).from(clients).where(inArray(clients.id, ids));
  }

  /**
   * Deletes these clients and lowers each affected import's created count, in
   * one statement. Ids that don't exist (or belong to another company: RLS
   * hides them) are skipped. Returns how many were deleted.
   */
  async removeMany(tx: TenantTx, ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    const list = sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    );
    const result = await tx.execute<{ deleted: number }>(sql`
      with gone as (
        delete from ${clients} where id = any(array[${list}]::uuid[]) returning import_id
      ),
      per_import as (
        select import_id, count(*)::int as n from gone where import_id is not null group by import_id
      ),
      counts as (
        update ${clientImports} ci
           set created_count = greatest(0, ci.created_count - per_import.n)
          from per_import
         where ci.id = per_import.import_id
        returning ci.id
      )
      select (select count(*) from gone)::int as deleted
    `);
    return result.rows[0]?.deleted ?? 0;
  }

  async create(tx: TenantTx, data: CreateClientData): Promise<Client> {
    const [row] = await tx.insert(clients).values(data).returning(clientColumns);
    return row;
  }

  /** One multi-row INSERT for an import chunk; returns how many were written. */
  async createMany(tx: TenantTx, data: CreateClientData[]): Promise<number> {
    if (!data.length) return 0;
    await tx.insert(clients).values(data);
    return data.length;
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
