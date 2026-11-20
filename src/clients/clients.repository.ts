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

/**
 * The keys two clients are compared on, matching the database's unique
 * indexes exactly: email ignoring case and surrounding spaces, phone as digits
 * only. Anything that looks a client up by contact must use these.
 */
const emailKey = (column: SQL) => sql`lower(btrim(${column}))`;
// Written '\\D' so Postgres receives '\D' (non-digit): a template literal drops a lone backslash.
const phoneKey = (column: SQL) => sql`regexp_replace(${column}, '\\D', '', 'g')`;

/** The same keys in code, for spotting duplicates inside one batch. */
export const contactKeys = (email: string | null, phone: string | null) => ({
  email: email ? email.trim().toLowerCase() : null,
  phone: phone && phone.replace(/\D/g, '') ? phone.replace(/\D/g, '') : null,
});

/** An existing client that already has this email or phone. */
export interface DuplicateClient {
  id: string;
  name: string;
  /** Which contact matched: the message names it. */
  matchedOn: 'email' | 'phone';
}

/** One spreadsheet row that passed validation, in file order. */
export interface ImportRowData {
  name: string;
  email: string | null;
  phone: string | null;
  customDetails: Record<string, unknown>;
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
  /**
   * The client (other than `excludeId`) that already has this email or phone,
   * if any; an email match wins over a phone match. The explicit tenant filter
   * lets Postgres use the (tenant, contact) unique indexes.
   */
  async findDuplicate(
    tx: TenantTx,
    tenantId: string,
    contact: { email: string | null; phone: string | null },
    excludeId?: string,
  ): Promise<DuplicateClient | null> {
    const keys = contactKeys(contact.email, contact.phone);
    if (!keys.email && !keys.phone) return null;
    const matches: SQL[] = [];
    if (keys.email) matches.push(sql`(c.email is not null and ${emailKey(sql`c.email`)} = ${keys.email})`);
    if (keys.phone) matches.push(sql`${phoneKey(sql`c.phone`)} = ${keys.phone}`);
    const result = await tx.execute<{ id: string; name: string; on_email: boolean }>(sql`
      select c.id, c.name, ${keys.email ? sql`coalesce(${emailKey(sql`c.email`)} = ${keys.email}, false)` : sql`false`} as on_email
        from ${clients} c
       where c.tenant_id = ${tenantId}
         and (${sql.join(matches, sql` or `)})
         ${excludeId ? sql`and c.id <> ${excludeId}` : sql``}
       order by 3 desc, c.created_at asc, c.id asc
       limit 1
    `);
    const row = result.rows[0];
    return row ? { id: row.id, name: row.name, matchedOn: row.on_email ? 'email' : 'phone' } : null;
  }

  /**
   * One import chunk in one statement: each row is matched against the
   * company's existing clients (by email or phone); rows that match are not
   * created, the rest are inserted with `importId`, and the import's counters
   * and stored rows are updated. Duplicates count towards the import's skipped
   * count. Returns null when the import doesn't exist (nothing is written).
   * `existingIds` are the clients the duplicate rows matched, so a caller can
   * still act on them (e.g. add them to a pipeline).
   */
  async importRows(
    tx: TenantTx,
    data: {
      tenantId: string;
      importId: string;
      rows: ImportRowData[];
      /** Invalid rows (no name, no contact, bad email), already left out of `rows`. */
      invalid: number;
      /** Rows dropped because an earlier row in this chunk had the same email or phone. */
      repeatedInChunk: number;
      /** Every row as received, for the import's stored copy. */
      storedRows: unknown[];
    },
  ): Promise<{ created: number; duplicates: number; existingIds: string[] } | null> {
    const incoming = JSON.stringify(
      data.rows.map((row, ord) => ({
        ord,
        name: row.name,
        email: row.email,
        phone: row.phone,
        custom_details: row.customDetails,
      })),
    );
    const result = await tx.execute<{ found: number; created: number; matched: number; existing_ids: string[] }>(sql`
      with incoming as (
        select r.ord, r.name, r.email, r.phone, coalesce(r.custom_details, '{}'::jsonb) as custom_details
          from jsonb_to_recordset(${incoming}::jsonb)
            as r(ord int, name text, email text, phone text, custom_details jsonb)
      ),
      imp as (
        select id from ${clientImports} where id = ${data.importId}
      ),
      matched as (
        select i.ord, (
          select c.id from ${clients} c
           where c.tenant_id = ${data.tenantId}
             and (
               (i.email is not null and c.email is not null and ${emailKey(sql`c.email`)} = ${emailKey(sql`i.email`)})
               or (${phoneKey(sql`i.phone`)} <> '' and ${phoneKey(sql`c.phone`)} = ${phoneKey(sql`i.phone`)})
             )
           order by c.created_at asc, c.id asc
           limit 1
        ) as existing_id
        from incoming i
      ),
      ins as (
        insert into ${clients} (tenant_id, import_id, name, email, phone, custom_details)
        select ${data.tenantId}, imp.id, i.name, i.email, i.phone, i.custom_details
          from incoming i
          join matched m on m.ord = i.ord
          cross join imp
         where m.existing_id is null
         order by i.ord
        -- Another import creating the same person at the same moment: the
        -- unique indexes turn it into a skip rather than an error.
        on conflict do nothing
        returning 1
      ),
      counts as (
        update ${clientImports}
           set created_count = created_count + (select count(*) from ins),
               skipped_count = skipped_count + ${data.invalid + data.repeatedInChunk}
                 + ((select count(*) from incoming) - (select count(*) from ins)),
               rows = rows || ${JSON.stringify(data.storedRows)}::jsonb
         where id = (select id from imp)
        returning 1
      )
      select (select count(*) from imp)::int as found,
             (select count(*) from ins)::int as created,
             (select count(*) from incoming)::int as matched,
             coalesce(
               (select json_agg(distinct existing_id) from matched where existing_id is not null),
               '[]'::json
             ) as existing_ids
    `);
    const row = result.rows[0];
    if (!row?.found) return null;
    return {
      created: row.created,
      duplicates: row.matched - row.created + data.repeatedInChunk,
      existingIds: row.existing_ids,
    };
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
