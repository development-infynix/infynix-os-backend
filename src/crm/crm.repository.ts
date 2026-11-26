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
import { eligibleOwners } from './crm-assignment.repository.js';
import {
  accessItems,
  clients,
  crmDeals,
  crmPipelineStages,
  crmPipelineUsers,
  crmPipelines,
  userAccess,
  users,
  type CrmAssignmentRule,
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
  ownerId: string | null;
}

/**
 * Whose deals a query may see: null for the company Owner (every deal), or a
 * manager's or staff member's own id (only deals they own).
 */
export type DealScope = string | null;

/** Drizzle filter for a deal scope; undefined (no filter) for the Owner. */
const ownedBy = (scope: DealScope) => (scope === null ? undefined : eq(crmDeals.ownerId, scope));

/** Raw-SQL filter for a deal scope, for `alias.owner_id`. */
export const ownedBySql = (alias: string, scope: DealScope): SQL =>
  scope === null ? sql`` : sql`and ${sql.raw(alias)}.owner_id = ${scope}`;

/** Someone who can be given pipeline access: active, not the owner, with the `crm` grant. */
export interface CrmEligibleUser {
  id: string;
  fullName: string;
  email: string;
}

/** What the pipeline picker needs: each pipeline with its stages in board order. */
export interface CrmPipelineSummary {
  id: string;
  name: string;
  position: number;
  stages: { id: string; name: string; position: number }[];
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
  /** The deal's owner, or null when unassigned. */
  ownerId: string | null;
  ownerName: string | null;
  /** How the owner was assigned (rule, tool or a manual pick); null when unassigned. */
  assignmentSource: CrmAssignmentRule | null;
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
  ownerId: crmDeals.ownerId,
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
  ownerId: crmDeals.ownerId,
  ownerName: users.fullName,
  assignmentSource: crmDeals.assignmentSource,
};

/** No query filters by tenant: RLS in TenantDb does that. */
@Injectable()
export class CrmRepository {
  /* ── Pipelines ────────────────────────────────────────────────────────── */

  /** The pipelines this person may see: all of them for `null` (owners), else their memberships. */
  /**
   * The pipelines this person can see (all of them when `userId` is null, i.e.
   * the owner), each with its stages nested, in one round trip.
   */
  async pipelineSummaries(
    tx: TenantTx,
    userId: string | null,
  ): Promise<CrmPipelineSummary[]> {
    const visible =
      userId === null
        ? sql`true`
        : sql`exists (
            select 1 from ${crmPipelineUsers} u
            where u.pipeline_id = p.id and u.user_id = ${userId}
          )`;
    const result = await tx.execute<CrmPipelineSummary>(sql`
      select p.id, p.name, p.position,
             coalesce(
               (select json_agg(
                         json_build_object('id', s.id, 'name', s.name, 'position', s.position)
                         order by s.position, s.id)
                  from ${crmPipelineStages} s
                 where s.pipeline_id = p.id),
               '[]'::json
             ) as stages
      from ${crmPipelines} p
      where ${visible}
      order by p.position asc, p.id asc
    `);
    return result.rows;
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
    data: { tenantId: string; name: string; position: number; createdBy?: string | null },
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

  /** Deals in a stage; with a scope, only that person's. Unscoped for the delete-stage check. */
  countDealsInStage(tx: TenantTx, stageId: string, scope: DealScope = null): Promise<number> {
    return tx
      .select({ total: count() })
      .from(crmDeals)
      .where(and(eq(crmDeals.stageId, stageId), ownedBy(scope)))
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

  /** A stage's deals (every owner) in board order, for re-indexing after a move. */
  dealIdsInStage(tx: TenantTx, stageId: string): Promise<{ id: string; ownerId: string | null }[]> {
    return tx
      .select({ id: crmDeals.id, ownerId: crmDeals.ownerId })
      .from(crmDeals)
      .where(eq(crmDeals.stageId, stageId))
      .orderBy(
        asc(crmDeals.position),
        desc(crmDeals.createdAt),
        desc(crmDeals.id),
      );
  }

  /**
   * Bulk add from the Clients page, in one statement: picks the stage (the given
   * one, or the pipeline's first), keeps the requested clients that exist (RLS
   * hides other companies'), skips those already in the pipeline, and inserts
   * the rest at the end of the stage in request order. A client that gets a
   * deal between the check and the insert is skipped by ON CONFLICT.
   * `stageFound` is false when the stage isn't in this pipeline: nothing is added.
   */
  async addExistingClients(
    tx: TenantTx,
    data: {
      tenantId: string;
      pipelineId: string;
      stageId?: string;
      clientIds: string[];
      createdBy: string;
    },
  ): Promise<{ stageFound: boolean; found: number; existing: number; added: number }> {
    if (!data.clientIds.length) return { stageFound: true, found: 0, existing: 0, added: 0 };
    const list = sql.join(
      data.clientIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const chosenStage = data.stageId ? sql`and s.id = ${data.stageId}` : sql``;
    const result = await tx.execute<{
      stage_found: number;
      found: number;
      existing: number;
      added: number;
    }>(sql`
      with st as (
        select s.id from ${crmPipelineStages} s
         where s.pipeline_id = ${data.pipelineId} ${chosenStage}
         order by s.position asc, s.id asc
         limit 1
      ),
      req as (
        select r.id, r.ord from unnest(array[${list}]::uuid[]) with ordinality as r(id, ord)
      ),
      found as (
        select req.id, req.ord from req join ${clients} c on c.id = req.id
      ),
      existing as (
        select d.client_id from ${crmDeals} d
         where d.pipeline_id = ${data.pipelineId} and d.client_id in (select id from found)
      ),
      start as (
        select coalesce(max(d.position) + 1, 0) as p from ${crmDeals} d where d.stage_id = (select id from st)
      ),
      -- The pipeline's rule picks each new deal's owner (docs/user-deals-assignment.md).
      -- The row lock queues concurrent adds so round robin never hands out the same turn twice.
      pipe as (
        select assignment_rule as rule, single_user_id as single, round_robin_cursor as cursor
          from ${crmPipelines} where id = ${data.pipelineId}
         for no key update
      ),
      elig as (
        select coalesce(array_agg(e.user_id order by e.user_id), '{}'::uuid[]) as ids
          from (${eligibleOwners(sql`${data.pipelineId}`)}) e
      ),
      todo as (
        select f.id, f.ord, (row_number() over (order by f.ord) - 1)::int as i
          from found f
         where f.id not in (select client_id from existing)
      ),
      owned as (
        select t.id, t.i,
               case (select rule from pipe)
                 when 'creator' then case when ${data.createdBy}::uuid = any(e.ids) then ${data.createdBy}::uuid end
                 when 'single_user' then case when (select single from pipe) = any(e.ids) then (select single from pipe) end
                 when 'round_robin' then case when cardinality(e.ids) > 0
                   then e.ids[(((select cursor from pipe) + t.i) % cardinality(e.ids)) + 1] end
               end as owner
          from todo t cross join elig e
      ),
      ins as (
        insert into ${crmDeals} (tenant_id, pipeline_id, stage_id, client_id, position, created_by, owner_id, assignment_source)
        select ${data.tenantId}, ${data.pipelineId}, st.id, o.id,
               (select p from start) + o.i,
               ${data.createdBy},
               o.owner,
               case when o.owner is not null then (select rule from pipe) end
          from owned o cross join st
        on conflict do nothing
        returning 1
      ),
      cursor_moved as (
        update ${crmPipelines}
           set round_robin_cursor = ((select cursor from pipe) + (select count(*) from todo)) % cardinality((select ids from elig))
         where id = ${data.pipelineId}
           and (select rule from pipe) = 'round_robin'
           and cardinality((select ids from elig)) > 0
           and exists (select 1 from st)
        returning 1
      )
      select (select count(*) from st)::int as stage_found,
             (select count(*) from found)::int as found,
             (select count(*) from existing)::int as existing,
             (select count(*) from ins)::int as added
    `);
    const row = result.rows[0];
    return { stageFound: row.stage_found > 0, found: row.found, existing: row.existing, added: row.added };
  }

  /**
   * Holds the pipeline's row until the transaction ends, so deal moves in one
   * pipeline run one after another and each sees the order the last one left.
   * `NO KEY UPDATE` still lets other transactions insert deals and stages that
   * reference the pipeline.
   */
  async lockPipeline(tx: TenantTx, id: string): Promise<boolean> {
    const rows = await tx
      .select({ id: crmPipelines.id })
      .from(crmPipelines)
      .where(eq(crmPipelines.id, id))
      .for('no key update');
    return rows.length > 0;
  }

  /**
   * Reorders every stage of a pipeline in one statement. `invalid` is set when
   * the ids aren't a complete, unique set of that pipeline's stages; in that
   * case nothing is written. The returned stages are in the new board order.
   */
  async reorderStages(
    tx: TenantTx,
    pipelineId: string,
    stageIds: string[],
  ): Promise<{ invalid: boolean; id: string; name: string; position: number }[]> {
    const list = sql.join(
      stageIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const result = await tx.execute<{
      invalid: boolean;
      id: string;
      name: string;
      position: number;
    }>(sql`
      with wanted as (
        select id, ord - 1 as position
        from unnest(array[${list}]::uuid[]) with ordinality as u(id, ord)
      ),
      before as (
        select id, name, position from ${crmPipelineStages} where pipeline_id = ${pipelineId}
      ),
      bad as (
        select
          (select count(*) from wanted) <> (select count(*) from before)
          or (select count(distinct id) from wanted) <> (select count(*) from wanted)
          or exists (select 1 from wanted w where not exists (select 1 from before b where b.id = w.id)) as invalid
      ),
      moved as (
        update ${crmPipelineStages} s
           set position = w.position, updated_at = now()
          from wanted w, bad
         where s.pipeline_id = ${pipelineId}
           and s.id = w.id
           and bad.invalid = false
           and s.position <> w.position
        returning s.id, s.position
      )
      select bad.invalid, b.id, b.name, coalesce(m.position, b.position)::int as position
        from before b
        cross join bad
        left join moved m on m.id = b.id
       order by coalesce(m.position, b.position), b.id
    `);
    return result.rows;
  }

  /**
   * Puts `ids` into the stage in that order (positions 0, 1, 2...) in one
   * statement, writing only the rows whose stage or position changes.
   */
  async placeDeals(tx: TenantTx, stageId: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const list = sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    );
    await tx.execute(sql`
      update ${crmDeals} as d
      set stage_id = ${stageId}, position = v.ord - 1, updated_at = now()
      from unnest(array[${list}]::uuid[]) with ordinality as v(id, ord)
      where d.id = v.id
        and (d.stage_id <> ${stageId} or d.position <> v.ord - 1)
    `);
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

  /**
   * The whole board in one round trip: every stage of the pipeline in order,
   * each with its first `limit` cards (board order) and its true total. One
   * query instead of two per stage matters because they can't overlap: they
   * share the transaction's connection, so each one waits for the last.
   */
  async boardColumns(
    tx: TenantTx,
    pipelineId: string,
    limit: number,
    scope: DealScope = null,
  ): Promise<{
    stages: CrmStage[];
    columns: Record<string, CrmDealCard[]>;
    totals: Record<string, number>;
  }> {
    // Timestamps go out as ISO text: raw queries get Postgres's own format back, not Dates.
    const iso = (column: SQL) => sql`(to_json(${column}) #>> '{}')`;
    const result = await tx.execute<{
      stage_id: string;
      stage_tenant_id: string;
      stage_name: string;
      stage_position: number;
      stage_created_at: string;
      stage_updated_at: string;
      total: number;
      id: string | null;
      client_id: string;
      position: number;
      name: string;
      email: string | null;
      phone: string | null;
      custom_details: Record<string, unknown> | string | null;
      added_at: string;
      owner_id: string | null;
      owner_name: string | null;
      assignment_source: CrmAssignmentRule | null;
    }>(sql`
      select s.id as stage_id, s.tenant_id as stage_tenant_id, s.name as stage_name,
             s.position as stage_position,
             ${iso(sql`s.created_at`)} as stage_created_at,
             ${iso(sql`s.updated_at`)} as stage_updated_at,
             t.total,
             c.id, c.client_id, c.position, c.name, c.email, c.phone, c.custom_details,
             c.owner_id, c.owner_name, c.assignment_source,
             ${iso(sql`c.created_at`)} as added_at
      from ${crmPipelineStages} s
      cross join lateral (
        select count(*)::int as total from ${crmDeals} d where d.stage_id = s.id ${ownedBySql('d', scope)}
      ) t
      left join lateral (
        select d.id, d.client_id, d.position, d.created_at,
               cl.name, cl.email, cl.phone, cl.custom_details,
               d.owner_id, ow.full_name as owner_name, d.assignment_source
        from ${crmDeals} d
        join ${clients} cl on cl.id = d.client_id and cl.tenant_id = d.tenant_id
        left join ${users} ow on ow.id = d.owner_id
        where d.stage_id = s.id ${ownedBySql('d', scope)}
        order by d.position asc, d.created_at desc, d.id desc
        limit ${limit}
      ) c on true
      where s.pipeline_id = ${pipelineId}
      order by s.position asc, s.id asc, c.position asc, c.created_at desc, c.id desc
    `);

    const stages: CrmStage[] = [];
    const columns: Record<string, CrmDealCard[]> = {};
    const totals: Record<string, number> = {};
    for (const row of result.rows) {
      if (!(row.stage_id in columns)) {
        stages.push({
          id: row.stage_id,
          tenantId: row.stage_tenant_id,
          pipelineId,
          name: row.stage_name,
          position: row.stage_position,
          createdAt: new Date(row.stage_created_at),
          updatedAt: new Date(row.stage_updated_at),
        });
        columns[row.stage_id] = [];
        totals[row.stage_id] = row.total;
      }
      if (row.id === null) continue; // a stage with no deals still gets one row
      columns[row.stage_id].push({
        id: row.id,
        pipelineId,
        stageId: row.stage_id,
        clientId: row.client_id,
        position: row.position,
        name: row.name,
        email: row.email,
        phone: row.phone,
        customDetails:
          typeof row.custom_details === 'string'
            ? (JSON.parse(row.custom_details) as Record<string, unknown>)
            : (row.custom_details ?? {}),
        addedAt: new Date(row.added_at),
        ownerId: row.owner_id,
        ownerName: row.owner_name,
        assignmentSource: row.assignment_source,
      });
    }
    return { stages, columns, totals };
  }

  /** Newest-first page of one stage; `position` breaks ties for drag order. */
  dealCardsForStage(
    tx: TenantTx,
    stageId: string,
    limit: number,
    offset = 0,
    scope: DealScope = null,
  ): Promise<CrmDealCard[]> {
    return tx
      .select(dealCardColumns)
      .from(crmDeals)
      .innerJoin(
        clients,
        and(eq(clients.id, crmDeals.clientId), eq(clients.tenantId, crmDeals.tenantId)),
      )
      .leftJoin(users, eq(users.id, crmDeals.ownerId))
      .where(and(eq(crmDeals.stageId, stageId), ownedBy(scope)))
      .orderBy(
        asc(crmDeals.position),
        desc(crmDeals.createdAt),
        desc(crmDeals.id),
      )
      .limit(limit)
      .offset(offset);
  }

  /** The card of `clientId`'s deal in `pipelineId` (a client has at most one per pipeline). */
  async dealCardForClient(tx: TenantTx, pipelineId: string, clientId: string): Promise<CrmDealCard | null> {
    const [row] = await tx
      .select(dealCardColumns)
      .from(crmDeals)
      .innerJoin(
        clients,
        and(eq(clients.id, crmDeals.clientId), eq(clients.tenantId, crmDeals.tenantId)),
      )
      .leftJoin(users, eq(users.id, crmDeals.ownerId))
      .where(and(eq(crmDeals.pipelineId, pipelineId), eq(crmDeals.clientId, clientId)));
    return row ?? null;
  }

  async dealCard(tx: TenantTx, id: string): Promise<CrmDealCard | null> {
    const [row] = await tx
      .select(dealCardColumns)
      .from(crmDeals)
      .innerJoin(
        clients,
        and(eq(clients.id, crmDeals.clientId), eq(clients.tenantId, crmDeals.tenantId)),
      )
      .leftJoin(users, eq(users.id, crmDeals.ownerId))
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
    scope: DealScope = null,
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
      .leftJoin(users, eq(users.id, crmDeals.ownerId))
      .where(and(eq(crmDeals.pipelineId, pipelineId), search, ownedBy(scope)))
      .orderBy(desc(crmDeals.createdAt), desc(crmDeals.id))
      .limit(limit);
  }
}
