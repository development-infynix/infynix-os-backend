import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { sql } from 'drizzle-orm';
import type { Database } from './database.js';

/** The transaction handle a company-scoped callback receives. */
export type TenantTx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * The only way to touch company-owned tables (memberships and every future
 * table with a tenant_id).
 *
 * `run()` opens a transaction, records the company in `app.tenant_id` and
 * switches to the restricted `infynix_tenant` role. From then on Postgres
 * row-level security hides every other company's rows and refuses writes
 * into them, even if a query forgets its WHERE clause. Both settings are
 * `LOCAL`, so they end with the transaction and are safe behind Neon's
 * pgbouncer pooler.
 *
 * Queries made outside `run()` use the owner connection, which bypasses RLS:
 * keep those to global tables (users, tenants, sessions).
 */
@Injectable()
export class TenantDb {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  run<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      await tx.execute(sql`set local role infynix_tenant`);
      return fn(tx);
    });
  }
}
