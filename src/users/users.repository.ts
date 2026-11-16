import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import { users } from '../db/schema.js';
import type { AuthUser } from './user.types.js';

/** Every column but the password hash: what leaves the data layer. */
export const publicUserColumns = {
  id: users.id,
  email: users.email,
  fullName: users.fullName,
  tenantId: users.tenantId,
  role: users.role,
  isPlatformAdmin: users.isPlatformAdmin,
  isActive: users.isActive,
  emailVerified: users.emailVerified,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
};

export const emailMatches = (email: string) =>
  eq(sql`lower(${users.email})`, email.trim().toLowerCase());

/**
 * Account lookups that have to work before a company is known (sign-in,
 * session validation, the signed-in person's own profile). These run on the
 * owner connection; managing a company's people goes through MembersRepository
 * inside TenantDb instead.
 */
@Injectable()
export class UsersRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  async findById(id: string): Promise<AuthUser | null> {
    const [row] = await this.db.select(publicUserColumns).from(users).where(eq(users.id, id));
    return row ?? null;
  }

  async emailTaken(email: string): Promise<boolean> {
    const [row] = await this.db.select({ id: users.id }).from(users).where(emailMatches(email));
    return !!row;
  }

  /** The only read that returns a password hash: for sign-in. */
  async findCredentials(email: string): Promise<{ user: AuthUser; passwordHash: string } | null> {
    const [row] = await this.db
      .select({ ...publicUserColumns, passwordHash: users.passwordHash })
      .from(users)
      .where(emailMatches(email));
    if (!row) return null;
    const { passwordHash, ...user } = row;
    return { user, passwordHash };
  }

  async findPasswordHash(id: string): Promise<string | null> {
    const [row] = await this.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, id));
    return row?.passwordHash ?? null;
  }

  async updateProfile(id: string, patch: { fullName: string }): Promise<AuthUser | null> {
    const [row] = await this.db
      .update(users)
      .set(patch)
      .where(eq(users.id, id))
      .returning(publicUserColumns);
    return row ?? null;
  }

  async setPassword(id: string, passwordHash: string): Promise<void> {
    await this.db
      .update(users)
      .set({ passwordHash, passwordChangedAt: new Date() })
      .where(eq(users.id, id));
  }

  async touchLastLogin(id: string): Promise<Date> {
    const lastLoginAt = new Date();
    await this.db.update(users).set({ lastLoginAt }).where(eq(users.id, id));
    return lastLoginAt;
  }
}
