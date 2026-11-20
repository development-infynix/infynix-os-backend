import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, gt, ilike, or, sql, type SQL } from 'drizzle-orm';
import type { ClientImportRow } from '../db/schema.js';
import { clientImports, clients } from '../db/schema.js';
import type { TenantTx } from '../db/tenant-db.js';

/** What the import list and the create response expose: never the rows. */
export interface ClientImportSummary {
  id: string;
  name: string;
  fileName: string;
  rowCount: number;
  createdCount: number;
  skippedCount: number;
  createdAt: Date;
}

/** The detail view adds the stored raw payload. */
export interface ClientImport extends ClientImportSummary {
  rows: ClientImportRow[];
}

export interface CreateClientImportData {
  tenantId: string;
  name: string;
  fileName: string;
  rowCount: number;
  createdBy: string;
}

const summaryColumns = {
  id: clientImports.id,
  name: clientImports.name,
  fileName: clientImports.fileName,
  rowCount: clientImports.rowCount,
  createdCount: clientImports.createdCount,
  skippedCount: clientImports.skippedCount,
  createdAt: clientImports.createdAt,
};

/** Imports of the company the transaction is scoped to (RLS does the tenant filtering). */
@Injectable()
export class ClientImportsRepository {
  async create(tx: TenantTx, data: CreateClientImportData): Promise<ClientImportSummary> {
    const [row] = await tx
      .insert(clientImports)
      .values({ ...data, rows: [] })
      .returning(summaryColumns);
    return row;
  }

  /** Newest first; ids break ties so two imports cannot swap order. */
  async list(tx: TenantTx): Promise<ClientImportSummary[]> {
    return tx
      .select(summaryColumns)
      .from(clientImports)
      .orderBy(desc(clientImports.createdAt), desc(clientImports.id));
  }

  /** One page of imports, newest first, matching the name or file name. */
  async search(
    tx: TenantTx,
    options: { q?: string; page: number; pageSize: number; withClients: boolean },
  ): Promise<{ items: ClientImportSummary[]; total: number }> {
    const conditions: SQL[] = [];
    const term = options.q?.trim();
    if (term) {
      // % and _ in the search are literal characters, not wildcards.
      const pattern = `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      conditions.push(or(ilike(clientImports.name, pattern), ilike(clientImports.fileName, pattern))!);
    }
    if (options.withClients) conditions.push(gt(clientImports.createdCount, 0));
    const where = conditions.length ? and(...conditions) : undefined;

    const [items, [{ total }]] = await Promise.all([
      tx
        .select(summaryColumns)
        .from(clientImports)
        .where(where)
        .orderBy(desc(clientImports.createdAt), desc(clientImports.id))
        .limit(options.pageSize)
        .offset((options.page - 1) * options.pageSize),
      tx.select({ total: count() }).from(clientImports).where(where),
    ]);
    return { items, total };
  }

  async find(tx: TenantTx, id: string): Promise<ClientImport | null> {
    const [row] = await tx
      .select({ ...summaryColumns, rows: clientImports.rows })
      .from(clientImports)
      .where(eq(clientImports.id, id));
    return row ?? null;
  }

  async rename(tx: TenantTx, id: string, name: string): Promise<ClientImportSummary | null> {
    const [row] = await tx
      .update(clientImports)
      .set({ name })
      .where(eq(clientImports.id, id))
      .returning(summaryColumns);
    return row ?? null;
  }

  /** Manual client deletes lower the import's created count, never below zero. */
  async decrementCreated(tx: TenantTx, id: string, amount: number): Promise<void> {
    await tx
      .update(clientImports)
      .set({ createdCount: sql`greatest(0, ${clientImports.createdCount} - ${amount})` })
      .where(eq(clientImports.id, id));
  }

  /**
   * One client-driven delete batch, in one statement: up to `limit` of the
   * import's clients go, the import's created count drops to match (so it stays
   * right if the client loop stops partway), and the count left comes back.
   * Null when the import doesn't exist.
   */
  async deleteClientChunk(
    tx: TenantTx,
    id: string,
    limit: number,
  ): Promise<{ deleted: number; remaining: number } | null> {
    // Every part of the statement sees the rows as they were before it, so
    // "remaining" is the count before minus what this batch deleted.
    const result = await tx.execute<{ deleted: number; remaining: number }>(sql`
      with imp as (
        select id from ${clientImports} where id = ${id}
      ),
      gone as (
        delete from ${clients}
         where id in (select id from ${clients} where import_id = (select id from imp) limit ${limit})
        returning 1
      ),
      counts as (
        update ${clientImports}
           set created_count = greatest(0, created_count - (select count(*) from gone))
         where id = (select id from imp)
        returning 1
      )
      select (select count(*) from gone)::int as deleted,
             ((select count(*) from ${clients} where import_id = imp.id) - (select count(*) from gone))::int as remaining
        from imp
    `);
    return result.rows[0] ?? null;
  }

  /**
   * Deletes the import and any clients still linked to it, in one statement
   * (the page clears big imports in chunks first, so few are usually left).
   * Null when the import doesn't exist; otherwise how many clients went.
   */
  async removeWithClients(tx: TenantTx, id: string): Promise<number | null> {
    // The clients -> import foreign key acts at the end of the statement, by
    // which time the linked clients are already gone.
    const result = await tx.execute<{ deleted: number }>(sql`
      with gone as (
        delete from ${clients} where import_id = ${id} returning 1
      ),
      imp as (
        delete from ${clientImports} where id = ${id} returning 1
      )
      select (select count(*) from gone)::int as deleted
       where exists (select 1 from imp)
    `);
    return result.rows[0]?.deleted ?? null;
  }

}
