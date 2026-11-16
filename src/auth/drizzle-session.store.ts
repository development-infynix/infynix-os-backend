import { Injectable } from '@nestjs/common';
import {
  AuthenticationStorage,
  type MfaState,
  type SessionRecord,
  type SessionStore,
} from '@nestjs/authentication';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, lt } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import { sessions } from '../db/schema.js';

type SessionRow = typeof sessions.$inferSelect;

/** Optional fields come back `undefined`, never `null` (the store contract). */
function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastActiveAt: row.lastActiveAt,
    ...(row.mfa && { mfa: row.mfa as MfaState }),
    ...(row.metadata && { metadata: row.metadata }),
  };
}

/** Keeps @nestjs/authentication sessions in Postgres (`sessions` table). */
@Injectable()
export class DrizzleSessionStore implements SessionStore {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    storage: AuthenticationStorage,
  ) {
    storage.registerSource({ sessions: this });
  }

  async getSession(id: string) {
    const [row] = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, id));
    return row ? toRecord(row) : undefined;
  }

  async createSession(record: SessionRecord) {
    // Prune expired sessions on each sign-in so the table stays bounded.
    await this.db
      .delete(sessions)
      .where(lt(sessions.expiresAt, record.createdAt));
    await this.db.insert(sessions).values({
      id: record.id,
      userId: record.userId,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      lastActiveAt: record.lastActiveAt,
      mfa: record.mfa ?? null,
      metadata: record.metadata ?? null,
    });
  }

  async touchSession(id: string, lastActiveAt: Date) {
    // One conditional write: never revives a deleted session, only moves forward.
    await this.db
      .update(sessions)
      .set({ lastActiveAt })
      .where(and(eq(sessions.id, id), lt(sessions.lastActiveAt, lastActiveAt)));
  }

  async deleteSession(id: string) {
    const deleted = await this.db
      .delete(sessions)
      .where(eq(sessions.id, id))
      .returning({ id: sessions.id });
    return deleted.length > 0;
  }

  async listUserSessions(userId: string) {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, userId));
    return rows.map(toRecord);
  }

  async deleteUserSessions(userId: string) {
    await this.db.delete(sessions).where(eq(sessions.userId, userId));
  }
}
