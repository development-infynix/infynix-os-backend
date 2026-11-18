import { Injectable } from '@nestjs/common';
import { count, desc, eq, inArray, sql } from 'drizzle-orm';
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

  /** One client-driven delete batch, with the count left for the import. */
  async deleteClientChunk(tx: TenantTx, id: string, limit: number) {
    const batch = await tx
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.importId, id))
      .limit(limit);
    if (batch.length) {
      await tx.delete(clients).where(inArray(clients.id, batch.map((row) => row.id)));
    }
    const [remaining] = await tx
      .select({ value: count() })
      .from(clients)
      .where(eq(clients.importId, id));
    return { deleted: batch.length, remaining: remaining?.value ?? 0 };
  }

  /** Deletes linked clients 100 at a time, then the import itself. */
  async removeWithClients(tx: TenantTx, id: string): Promise<number> {
    let deleted = 0;
    while (true) {
      const batch = await tx
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.importId, id))
        .limit(100);
      if (!batch.length) break;
      await tx.delete(clients).where(inArray(clients.id, batch.map((row) => row.id)));
      deleted += batch.length;
    }
    await tx.delete(clientImports).where(eq(clientImports.id, id));
    return deleted;
  }

  /**
   * One statement per chunk: the counters grow with SQL increments and the
   * normalized payload is appended, so concurrent chunks cannot lose counts.
   */
  async recordChunk(
    tx: TenantTx,
    id: string,
    created: number,
    skipped: number,
    rows: ClientImportRow[],
  ): Promise<void> {
    await tx
      .update(clientImports)
      .set({
        createdCount: sql`${clientImports.createdCount} + ${created}`,
        skippedCount: sql`${clientImports.skippedCount} + ${skipped}`,
        rows: sql`${clientImports.rows} || ${JSON.stringify(rows)}::jsonb`,
      })
      .where(eq(clientImports.id, id));
  }
}
