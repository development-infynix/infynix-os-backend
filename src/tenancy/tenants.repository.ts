import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import { tenants, users } from '../db/schema.js';
import type { AuthUser } from '../users/user.types.js';
import { publicUserColumns } from '../users/users.repository.js';
import type { Tenant } from './tenancy.types.js';

const tenantColumns = {
  id: tenants.id,
  name: tenants.name,
  status: tenants.status,
  plan: tenants.plan,
  createdAt: tenants.createdAt,
};

/** Companies. Runs on the owner connection: a company is looked up before its scope exists. */
@Injectable()
export class TenantsRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  async findById(id: string): Promise<Tenant | null> {
    const [row] = await this.db.select(tenantColumns).from(tenants).where(eq(tenants.id, id));
    return row ?? null;
  }

  /** Sign-up: the company and its owner account, atomically. */
  async createWithOwner(data: {
    companyName: string;
    fullName: string;
    email: string;
    passwordHash: string;
  }): Promise<{ tenant: Tenant; owner: AuthUser }> {
    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(tenants)
        .values({ name: data.companyName })
        .returning({ id: tenants.id });
      const [owner] = await tx
        .insert(users)
        .values({
          email: data.email.trim().toLowerCase(),
          fullName: data.fullName,
          passwordHash: data.passwordHash,
          tenantId: created.id,
          role: 'owner',
        })
        .returning(publicUserColumns);
      const [tenant] = await tx
        .update(tenants)
        .set({ createdBy: owner.id })
        .where(eq(tenants.id, created.id))
        .returning(tenantColumns);
      return { tenant, owner };
    });
  }
}
