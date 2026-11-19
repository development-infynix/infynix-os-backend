import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { TenantTx } from '../db/tenant-db.js';
import {
  accessItems,
  clients,
  crmDeals,
  crmPipelineStages,
  crmPipelineUsers,
  crmPipelines,
  userAccess,
  users,
} from '../db/schema.js';

export interface CrmPipeline {
  id: string;
  tenantId: string;
  name: string;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CrmStage {
  id: string;
  tenantId: string;
  pipelineId: string;
  name: string;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CrmDeal {
  id: string;
  tenantId: string;
  pipelineId: string;
  stageId: string;
  clientId: string;
  position: number;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Someone who can be given pipeline access: active, not the owner, with the `crm` grant. */
export interface CrmEligibleUser {
  id: string;
  fullName: string;
  email: string;
}

/** A deal plus the client fields a kanban card shows. */
export interface CrmDealCard {
  id: string;
  pipelineId: string;
  stageId: string;
  clientId: string;
  position: number;
  name: string;
  email: string | null;
  phone: string | null;
  customDetails: Record<string, unknown>;
  addedAt: Date;
}

const pipelineColumns = {
  id: crmPipelines.id,
  tenantId: crmPipelines.tenantId,
  name: crmPipelines.name,
  position: crmPipelines.position,
  createdAt: crmPipelines.createdAt,
  updatedAt: crmPipelines.updatedAt,
};

const stageColumns = {
  id: crmPipelineStages.id,
  tenantId: crmPipelineStages.tenantId,
  pipelineId: crmPipelineStages.pipelineId,
  name: crmPipelineStages.name,
  position: crmPipelineStages.position,
  createdAt: crmPipelineStages.createdAt,
  updatedAt: crmPipelineStages.updatedAt,
};

const dealColumns = {
  id: crmDeals.id,
  tenantId: crmDeals.tenantId,
  pipelineId: crmDeals.pipelineId,
  stageId: crmDeals.stageId,
  clientId: crmDeals.clientId,
  position: crmDeals.position,
  createdBy: crmDeals.createdBy,
  createdAt: crmDeals.createdAt,
  updatedAt: crmDeals.updatedAt,
};

const dealCardColumns = {
  id: crmDeals.id,
  pipelineId: crmDeals.pipelineId,
  stageId: crmDeals.stageId,
  clientId: crmDeals.clientId,
  position: crmDeals.position,
  name: clients.name,
  email: clients.email,
  phone: clients.phone,
  customDetails: clients.customDetails,
  addedAt: crmDeals.createdAt,
};

/** No query filters by tenant: RLS in TenantDb does that. */
@Injectable()
export class CrmRepository {
  /* ── Pipelines ────────────────────────────────────────────────────────── */

  listPipelines(tx: TenantTx): Promise<CrmPipeline[]> {
    return tx
      .select(pipelineColumns)
      .from(crmPipelines)
      .orderBy(asc(crmPipelines.position), asc(crmPipelines.id));
  }

  /** The pipelines this person may see: all of them for `null` (owners), else their memberships. */
  listPipelinesFor(tx: TenantTx, userId: string | null): Promise<CrmPipeline[]> {
    if (userId === null) return this.listPipelines(tx);
    return tx
      .select(pipelineColumns)
      .from(crmPipelines)
      .innerJoin(
        crmPipelineUsers,
        and(
          eq(crmPipelineUsers.pipelineId, crmPipelines.id),
          eq(crmPipelineUsers.userId, userId),
        ),
      )
      .orderBy(asc(crmPipelines.position), asc(crmPipelines.id));
  }

  async isPipelineMember(
    tx: TenantTx,
    pipelineId: string,
    userId: string,
  ): Promise<boolean> {
    const [row] = await tx
      .select({ userId: crmPipelineUsers.userId })
      .from(crmPipelineUsers)
      .where(
        and(
          eq(crmPipelineUsers.pipelineId, pipelineId),
          eq(crmPipelineUsers.userId, userId),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  /** Active, non-owner people with the `crm` menu grant, by name. */
  listCrmEligibleUsers(tx: TenantTx): Promise<CrmEligibleUser[]> {
    return tx
      .select({ id: users.id, fullName: users.fullName, email: users.email })
      .from(users)
      .innerJoin(userAccess, eq(userAccess.userId, users.id))
      .innerJoin(
        accessItems,
        and(
          eq(accessItems.id, userAccess.accessItemId),
          eq(accessItems.key, 'crm'),
          eq(accessItems.isActive, true),
        ),
      )
      .where(and(eq(users.isActive, true), ne(users.role, 'owner')))
      .orderBy(asc(users.fullName), asc(users.id));
  }

  async addPipelineUsers(
    tx: TenantTx,
    rows: { tenantId: string; pipelineId: string; userId: string; grantedBy: string | null }[],
  ): Promise<void> {
    if (!rows.length) return;
    await tx.insert(crmPipelineUsers).values(rows).onConflictDoNothing();
  }

  countPipelines(tx: TenantTx): Promise<number> {
    return tx
      .select({ total: count() })
      .from(crmPipelines)
      .then(([{ total }]) => total);
  }

  async findPipeline(tx: TenantTx, id: string): Promise<CrmPipeline | null> {
    const [row] = await tx
      .select(pipelineColumns)
      .from(crmPipelines)
      .where(eq(crmPipelines.id, id));
    return row ?? null;
  }

  async nextPipelinePosition(tx: TenantTx): Promise<number> {
    const [{ next }] = await tx
      .select({
        next: sql<number>`coalesce(max(${crmPipelines.position}) + 1, 0)::int`,
      })
      .from(crmPipelines);
    return next;
  }

  createPipeline(
    tx: TenantTx,
    data: { tenantId: string; name: string; position: number },
  ): Promise<CrmPipeline> {
    return tx
      .insert(crmPipelines)
      .values(data)
      .returning(pipelineColumns)
      .then(([row]) => row);
  }

  /**
   * Inserts a pipeline unless the company already has one with that name.
   * Returns null when another request won the race, so only one caller seeds
   * the default stages.
   */
  async createPipelineIfAbsent(
    tx: TenantTx,
    data: { tenantId: string; name: string; position: number },
  ): Promise<CrmPipeline | null> {
    const [row] = await tx
      .insert(crmPipelines)
      .values(data)
      .onConflictDoNothing()
      .returning(pipelineColumns);
    return row ?? null;
  }

  async updatePipeline(
    tx: TenantTx,
    id: string,
    patch: { name?: string; position?: number },
  ): Promise<CrmPipeline | null> {
    const [row] = await tx
      .update(crmPipelines)
      .set(patch)
      .where(eq(crmPipelines.id, id))
      .returning(pipelineColumns);
    return row ?? null;
  }

  removePipeline(tx: TenantTx, id: string): Promise<void> {
    return tx.delete(crmPipelines).where(eq(crmPipelines.id, id)).then(() => undefined);
  }

  /* ── Stages ───────────────────────────────────────────────────────────── */

  listStages(tx: TenantTx, pipelineIds: string[]): Promise<CrmStage[]> {
    if (!pipelineIds.length) return Promise.resolve([]);
    return tx
      .select(stageColumns)
      .from(crmPipelineStages)
      .where(inArray(crmPipelineStages.pipelineId, pipelineIds))
      .orderBy(
        asc(crmPipelineStages.pipelineId),
        asc(crmPipelineStages.position),
        asc(crmPipelineStages.id),
      );
  }

  async findStage(tx: TenantTx, id: string): Promise<CrmStage | null> {
    const [row] = await tx
      .select(stageColumns)
      .from(crmPipelineStages)
      .where(eq(crmPipelineStages.id, id));
    return row ?? null;
  }

  async findPipelineStages(tx: TenantTx, pipelineId: string): Promise<CrmStage[]> {
    return tx
      .select(stageColumns)
      .from(crmPipelineStages)
      .where(eq(crmPipelineStages.pipelineId, pipelineId))
      .orderBy(
        asc(crmPipelineStages.position),
        asc(crmPipelineStages.id),
      );
  }

  async nextStagePosition(tx: TenantTx, pipelineId: string): Promise<number> {
    const [{ next }] = await tx
      .select({
        next: sql<number>`coalesce(max(${crmPipelineStages.position}) + 1, 0)::int`,
      })
      .from(crmPipelineStages)
      .where(eq(crmPipelineStages.pipelineId, pipelineId));
    return next;
  }

  createStage(
    tx: TenantTx,
    data: {
      tenantId: string;
      pipelineId: string;
      name: string;
      position: number;
    },
  ): Promise<CrmStage> {
    return tx
      .insert(crmPipelineStages)
      .values(data)
      .returning(stageColumns)
      .then(([row]) => row);
  }

  createStages(
    tx: TenantTx,
    data: Array<{
      tenantId: string;
      pipelineId: string;
      name: string;
      position: number;
    }>,
  ): Promise<CrmStage[]> {
    if (!data.length) return Promise.resolve([]);
    return tx
      .insert(crmPipelineStages)
      .values(data)
      .returning(stageColumns);
  }

  async updateStage(
    tx: TenantTx,
    id: string,
    patch: { name?: string; position?: number },
  ): Promise<CrmStage | null> {
    const [row] = await tx
      .update(crmPipelineStages)
      .set(patch)
      .where(eq(crmPipelineStages.id, id))
      .returning(stageColumns);
    return row ?? null;
  }

  removeStage(tx: TenantTx, id: string): Promise<void> {
    return tx
      .delete(crmPipelineStages)
      .where(eq(crmPipelineStages.id, id))
      .then(() => undefined);
  }

  countDealsInStage(tx: TenantTx, stageId: string): Promise<number> {
    return tx
      .select({ total: count() })
      .from(crmDeals)
      .where(eq(crmDeals.stageId, stageId))
      .then(([{ total }]) => total);
  }

  countStagesInPipeline(tx: TenantTx, pipelineId: string): Promise<number> {
    return tx
      .select({ total: count() })
      .from(crmPipelineStages)
      .where(eq(crmPipelineStages.pipelineId, pipelineId))
      .then(([{ total }]) => total);
  }

  /* ── Deals ────────────────────────────────────────────────────────────── */

  async findDeal(tx: TenantTx, id: string): Promise<CrmDeal | null> {
    const [row] = await tx
      .select(dealColumns)
      .from(crmDeals)
      .where(eq(crmDeals.id, id));
    return row ?? null;
  }

  async findDealByClient(
    tx: TenantTx,
    pipelineId: string,
    clientId: string,
  ): Promise<CrmDeal | null> {
    const [row] = await tx
      .select(dealColumns)
      .from(crmDeals)
      .where(
        and(eq(crmDeals.pipelineId, pipelineId), eq(crmDeals.clientId, clientId)),
      );
    return row ?? null;
  }

  /** Which of these clients already have a deal in the pipeline. */
  async clientIdsWithDealIn(
    tx: TenantTx,
    pipelineId: string,
    clientIds: string[],
  ): Promise<Set<string>> {
    if (!clientIds.length) return new Set();
    const rows = await tx
      .select({ clientId: crmDeals.clientId })
      .from(crmDeals)
      .where(and(eq(crmDeals.pipelineId, pipelineId), inArray(crmDeals.clientId, clientIds)));
    return new Set(rows.map((row) => row.clientId));
  }

  /**
   * One multi-row INSERT for a bulk add. A client that got a deal in this
   * pipeline meanwhile is skipped by the unique index, not an error; returns
   * how many deals were actually created.
   */
  async createDeals(
    tx: TenantTx,
    rows: {
      tenantId: string;
      pipelineId: string;
      stageId: string;
      clientId: string;
      position: number;
      createdBy: string;
    }[],
  ): Promise<number> {
    if (!rows.length) return 0;
    const created = await tx
      .insert(crmDeals)
      .values(rows)
      .onConflictDoNothing()
      .returning({ id: crmDeals.id });
    return created.length;
  }

  async nextDealPosition(tx: TenantTx, stageId: string): Promise<number> {
    const [{ next }] = await tx
      .select({
        next: sql<number>`coalesce(max(${crmDeals.position}) + 1, 0)::int`,
      })
      .from(crmDeals)
      .where(eq(crmDeals.stageId, stageId));
    return next;
  }

  async createDeal(
    tx: TenantTx,
    data: {
      tenantId: string;
      pipelineId: string;
      stageId: string;
      clientId: string;
      position: number;
      createdBy: string;
    },
  ): Promise<CrmDeal> {
    const [row] = await tx.insert(crmDeals).values(data).returning(dealColumns);
    return row;
  }

  /** A stage's deal ids in board order, for re-indexing after a move. */
  async dealIdsInStage(tx: TenantTx, stageId: string): Promise<string[]> {
    const rows = await tx
      .select({ id: crmDeals.id })
      .from(crmDeals)
      .where(eq(crmDeals.stageId, stageId))
      .orderBy(
        asc(crmDeals.position),
        desc(crmDeals.createdAt),
        desc(crmDeals.id),
      );
    return rows.map((row) => row.id);
  }

  async moveDeal(
    tx: TenantTx,
    id: string,
    stageId: string,
    position: number,
  ): Promise<CrmDeal | null> {
    const [row] = await tx
      .update(crmDeals)
      .set({ stageId, position })
      .where(eq(crmDeals.id, id))
      .returning(dealColumns);
    return row ?? null;
  }

  removeDeal(tx: TenantTx, id: string): Promise<void> {
    return tx.delete(crmDeals).where(eq(crmDeals.id, id)).then(() => undefined);
  }

  removeDealsForPipeline(tx: TenantTx, pipelineId: string): Promise<void> {
    return tx
      .delete(crmDeals)
      .where(eq(crmDeals.pipelineId, pipelineId))
      .then(() => undefined);
  }

  countDealsInPipeline(tx: TenantTx, pipelineId: string): Promise<number> {
    return tx
      .select({ total: count() })
      .from(crmDeals)
      .where(eq(crmDeals.pipelineId, pipelineId))
      .then(([{ total }]) => total);
  }

  /** Newest-first page of one stage; `position` breaks ties for drag order. */
  dealCardsForStage(
    tx: TenantTx,
    stageId: string,
    limit: number,
    offset = 0,
  ): Promise<CrmDealCard[]> {
    return tx
      .select(dealCardColumns)
      .from(crmDeals)
      .innerJoin(
        clients,
        and(eq(clients.id, crmDeals.clientId), eq(clients.tenantId, crmDeals.tenantId)),
      )
      .where(eq(crmDeals.stageId, stageId))
      .orderBy(
        asc(crmDeals.position),
        desc(crmDeals.createdAt),
        desc(crmDeals.id),
      )
      .limit(limit)
      .offset(offset);
  }

  async dealCard(tx: TenantTx, id: string): Promise<CrmDealCard | null> {
    const [row] = await tx
      .select(dealCardColumns)
      .from(crmDeals)
      .innerJoin(
        clients,
        and(eq(clients.id, crmDeals.clientId), eq(clients.tenantId, crmDeals.tenantId)),
      )
      .where(eq(crmDeals.id, id));
    return row ?? null;
  }

  /**
   * Deals in one pipeline matching a client name, email or phone. `%` and `_`
   * typed by the user match literally, like the Clients search.
   */
  searchDeals(
    tx: TenantTx,
    pipelineId: string,
    q: string,
    limit: number,
  ): Promise<CrmDealCard[]> {
    const term = q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const contains = `%${term}%`;
    const search: SQL = or(
      ilike(clients.name, contains),
      ilike(clients.email, contains),
      ilike(clients.phone, contains),
    )!;
    return tx
      .select(dealCardColumns)
      .from(crmDeals)
      .innerJoin(
        clients,
        and(eq(clients.id, crmDeals.clientId), eq(clients.tenantId, crmDeals.tenantId)),
      )
      .where(and(eq(crmDeals.pipelineId, pipelineId), search))
      .orderBy(desc(crmDeals.createdAt), desc(crmDeals.id))
      .limit(limit);
  }
}
