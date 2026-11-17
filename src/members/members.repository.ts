import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { TenantTx } from '../db/tenant-db.js';
import { users } from '../db/schema.js';
import type { MemberRole } from '../tenancy/tenancy.types.js';

/** A person in the company, as owners and managers see them. */
export interface Member {
  id: string;
  email: string;
  fullName: string;
  role: MemberRole;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

/** Optional server-side filters for the people list. */
export interface MemberFilters {
  status?: 'active' | 'deactivated';
  role?: 'staff' | 'admin';
}

const memberColumns = {
  id: users.id,
  email: users.email,
  fullName: users.fullName,
  role: users.role,
  isActive: users.isActive,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
};

/**
 * The people of the company the transaction is scoped to. Every method takes
 * a TenantDb transaction: row-level security limits it to that company, so
 * no query here filters by tenant itself.
 */
@Injectable()
export class MembersRepository {
  /**
   * One page of the company's users, oldest first. The id breaks ties so a
   * row can't appear on two pages (several users can share a timestamp).
   */
  async page(
    tx: TenantTx,
    page: number,
    pageSize: number,
    filters: MemberFilters = {},
  ): Promise<{ items: Member[]; total: number }> {
    const conditions: SQL[] = [];
    if (filters.status) conditions.push(eq(users.isActive, filters.status === 'active'));
    if (filters.role === 'staff') conditions.push(eq(users.role, 'staff'));
    if (filters.role === 'admin') {
      conditions.push(inArray(users.role, ['owner', 'manager']));
    }
    const where = and(...conditions);

    const [items, [{ total }]] = await Promise.all([
      tx
        .select(memberColumns)
        .from(users)
        .where(where)
        .orderBy(asc(users.createdAt), asc(users.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      tx.select({ total: count() }).from(users).where(where),
    ]);
    return { items, total };
  }

  async find(tx: TenantTx, id: string): Promise<Member | null> {
    const [row] = await tx.select(memberColumns).from(users).where(eq(users.id, id));
    return row ?? null;
  }

  async create(
    tx: TenantTx,
    data: { tenantId: string; email: string; fullName: string; role: MemberRole; passwordHash: string },
  ): Promise<Member> {
    const [row] = await tx
      .insert(users)
      .values({ ...data, email: data.email.trim().toLowerCase() })
      .returning(memberColumns);
    return row;
  }

  async update(
    tx: TenantTx,
    id: string,
    patch: { fullName?: string; email?: string; role?: MemberRole; isActive?: boolean },
  ): Promise<Member | null> {
    const values = patch.email ? { ...patch, email: patch.email.trim().toLowerCase() } : patch;
    const [row] = await tx.update(users).set(values).where(eq(users.id, id)).returning(memberColumns);
    return row ?? null;
  }

  async setPassword(tx: TenantTx, id: string, passwordHash: string): Promise<void> {
    await tx
      .update(users)
      .set({ passwordHash, passwordChangedAt: new Date() })
      .where(eq(users.id, id));
  }

  async remove(tx: TenantTx, id: string): Promise<void> {
    await tx.delete(users).where(eq(users.id, id));
  }

  /**
   * Users whose name or email contains `query` (case-insensitive). Names that
   * start with it come first, then alphabetical. % and _ typed by the user are
   * matched literally.
   */
  search(tx: TenantTx, query: string, limit: number): Promise<Member[]> {
    // Escape LIKE's wildcards (and its escape character) so they match literally.
    const term = query.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const contains = `%${term}%`;
    return tx
      .select(memberColumns)
      .from(users)
      .where(or(ilike(users.fullName, contains), ilike(users.email, contains)))
      .orderBy(
        sql`case when ${users.fullName} ilike ${term + '%'} then 0 else 1 end`,
        asc(users.fullName),
        asc(users.id),
      )
      .limit(limit);
  }

  async countActiveOwners(tx: TenantTx): Promise<number> {
    const [{ total }] = await tx
      .select({ total: count() })
      .from(users)
      .where(and(eq(users.role, 'owner'), eq(users.isActive, true)));
    return total;
  }
}
