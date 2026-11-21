import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { clients, crmDeals, crmPipelineStages, crmPipelineUsers, crmPipelines } from '../db/schema.js';
import type { TenantTx } from '../db/tenant-db.js';
import { eligibleOwners } from './crm-assignment.repository.js';

/** Deals per transfer request (see docs/performance.md). */
export const TRANSFER_CHUNK = 500;

const uuidArray = (ids: string[]) =>
  ids.length
    ? sql`array[${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )}]::uuid[]`
    : sql`'{}'::uuid[]`;

export interface MoveResult {
  /** False when the landing stage isn't in the target pipeline (nothing moved). */
  stageFound: boolean;
  /** Requested deals that still exist in the source pipeline. */
  found: number;
  moved: number;
  /** Moved deals that arrived without an owner. */
  unassigned: number;
  /** Deals left behind because their client already has a deal in the target. */
  skipped: { dealId: string; clientName: string }[];
}

/** Moving deals between pipelines (docs/deal-transfer.md). RLS scopes everything to the company. */
@Injectable()
export class CrmTransferRepository {
  /**
   * Every deal in the given stages of one pipeline, in board order (stage,
   * then position), not only the cards loaded on the board.
   */
  async dealIdsByStages(tx: TenantTx, pipelineId: string, stageIds: string[]): Promise<string[]> {
    if (!stageIds.length) return [];
    const result = await tx.execute<{ id: string }>(sql`
      select d.id
        from ${crmDeals} d
        join ${crmPipelineStages} s on s.id = d.stage_id
       where d.pipeline_id = ${pipelineId}
         and d.stage_id = any(${uuidArray(stageIds)})
       order by s.position asc, s.id asc, d.position asc, d.created_at desc, d.id desc
    `);
    return result.rows.map((row) => row.id);
  }

  /** The distinct pipelines the given deals are in (a transfer takes deals from one). */
  async pipelinesOf(tx: TenantTx, dealIds: string[]): Promise<string[]> {
    if (!dealIds.length) return [];
    const result = await tx.execute<{ pipeline_id: string }>(sql`
      select distinct pipeline_id from ${crmDeals} where id = any(${uuidArray(dealIds)})
    `);
    return result.rows.map((row) => row.pipeline_id);
  }

  /**
   * Locks both pipelines in ascending id order, so two transfers between the
   * same pipelines (in either direction) can't deadlock. Same lock as deal
   * moves and bulk adds.
   */
  async lockPipelines(tx: TenantTx, pipelineIds: string[]): Promise<void> {
    await tx.execute(sql`
      select id from ${crmPipelines}
       where id = any(${uuidArray([...new Set(pipelineIds)])})
       order by id
       for no key update
    `);
  }

  /**
   * One Move chunk, in one statement (run after `lockPipelines`): the deals
   * that still exist in the source are locked; those whose client already has
   * a deal in the target are skipped; the rest get the target pipeline, the
   * landing stage (the given one, or the target's first), positions at the end
   * of that stage in their source order, and owners by the target's rule: only
   * Round robin and Single user assign (the cursor advances), Creator and
   * Manual leave them unassigned. `created_by` stays.
   */
  async move(
    tx: TenantTx,
    data: { sourcePipelineId: string; targetPipelineId: string; targetStageId?: string; dealIds: string[] },
  ): Promise<MoveResult> {
    const chosenStage = data.targetStageId ? sql`and s.id = ${data.targetStageId}` : sql``;
    const result = await tx.execute<{
      stage_found: number;
      found: number;
      moved: number;
      unassigned: number;
      skipped: { dealId: string; clientName: string }[];
    }>(sql`
      with tgt as (
        select assignment_rule as rule, single_user_id as single, round_robin_cursor as cursor
          from ${crmPipelines} where id = ${data.targetPipelineId}
      ),
      st as (
        select s.id from ${crmPipelineStages} s
         where s.pipeline_id = ${data.targetPipelineId} ${chosenStage}
         order by s.position asc, s.id asc
         limit 1
      ),
      req as (
        select d.id, d.client_id, d.stage_id, d.position, d.created_at
          from ${crmDeals} d
         where d.id = any(${uuidArray(data.dealIds)}) and d.pipeline_id = ${data.sourcePipelineId}
         for update
      ),
      ordered as (
        select r.id, r.client_id,
               row_number() over (order by ss.position, ss.id, r.position, r.created_at desc, r.id desc) as ord
          from req r join ${crmPipelineStages} ss on ss.id = r.stage_id
      ),
      dup as (
        select o.id, o.client_id from ordered o
         where exists (
           select 1 from ${crmDeals} x
            where x.pipeline_id = ${data.targetPipelineId} and x.client_id = o.client_id
         )
      ),
      todo as (
        select o.id, (row_number() over (order by o.ord) - 1)::int as i
          from ordered o
         where o.id not in (select id from dup)
      ),
      start as (
        select coalesce(max(d.position) + 1, 0) as p from ${crmDeals} d where d.stage_id = (select id from st)
      ),
      elig as (
        select coalesce(array_agg(e.user_id order by e.user_id), '{}'::uuid[]) as ids
          from (${eligibleOwners(sql`${data.targetPipelineId}`)}) e
      ),
      owned as (
        select t.id, t.i,
               case (select rule from tgt)
                 when 'single_user' then case when (select single from tgt) = any(e.ids) then (select single from tgt) end
                 when 'round_robin' then case when cardinality(e.ids) > 0
                   then e.ids[(((select cursor from tgt) + t.i) % cardinality(e.ids)) + 1] end
               end as owner
          from todo t cross join elig e
      ),
      upd as (
        update ${crmDeals} d
           set pipeline_id = ${data.targetPipelineId},
               stage_id = (select id from st),
               position = (select p from start) + o.i,
               owner_id = o.owner,
               assignment_source = case when o.owner is not null then (select rule from tgt) end,
               updated_at = now()
          from owned o
         where d.id = o.id and exists (select 1 from st)
        returning d.id, d.owner_id
      ),
      cursor_moved as (
        update ${crmPipelines}
           set round_robin_cursor = ((select cursor from tgt) + (select count(*) from upd)) % cardinality((select ids from elig))
         where id = ${data.targetPipelineId}
           and (select rule from tgt) = 'round_robin'
           and cardinality((select ids from elig)) > 0
        returning 1
      )
      select (select count(*) from st)::int as stage_found,
             (select count(*) from req)::int as found,
             (select count(*) from upd)::int as moved,
             (select count(*) from upd where owner_id is null)::int as unassigned,
             coalesce(
               (select json_agg(json_build_object('dealId', dp.id, 'clientName', c.name) order by c.name)
                  from dup dp join ${clients} c on c.id = dp.client_id),
               '[]'::json
             ) as skipped
    `);
    const row = result.rows[0];
    return {
      stageFound: row.stage_found > 0,
      found: row.found,
      moved: row.moved,
      unassigned: row.unassigned,
      skipped: row.skipped,
    };
  }

  /**
   * One Add-to-another-pipeline chunk, in one statement (run after
   * `lockPipelines`): the source deals stay as they are; each one whose client
   * isn't in the target yet gets a **new** deal there, at the end of the
   * landing stage in source order, with `created_by` = whoever adds them and
   * owners by the target's rule (only Round robin and Single user assign).
   */
  async copy(
    tx: TenantTx,
    data: {
      tenantId: string;
      sourcePipelineId: string;
      targetPipelineId: string;
      targetStageId?: string;
      dealIds: string[];
      createdBy: string;
    },
  ): Promise<{ stageFound: boolean; found: number; added: number; unassigned: number; skipped: MoveResult['skipped'] }> {
    const chosenStage = data.targetStageId ? sql`and s.id = ${data.targetStageId}` : sql``;
    const result = await tx.execute<{
      stage_found: number;
      found: number;
      added: number;
      unassigned: number;
      skipped: MoveResult['skipped'];
    }>(sql`
      with tgt as (
        select assignment_rule as rule, single_user_id as single, round_robin_cursor as cursor
          from ${crmPipelines} where id = ${data.targetPipelineId}
      ),
      st as (
        select s.id from ${crmPipelineStages} s
         where s.pipeline_id = ${data.targetPipelineId} ${chosenStage}
         order by s.position asc, s.id asc
         limit 1
      ),
      req as (
        select d.id, d.client_id, d.stage_id, d.position, d.created_at
          from ${crmDeals} d
         where d.id = any(${uuidArray(data.dealIds)}) and d.pipeline_id = ${data.sourcePipelineId}
      ),
      ordered as (
        select r.id, r.client_id,
               row_number() over (order by ss.position, ss.id, r.position, r.created_at desc, r.id desc) as ord
          from req r join ${crmPipelineStages} ss on ss.id = r.stage_id
      ),
      dup as (
        select o.id, o.client_id from ordered o
         where exists (
           select 1 from ${crmDeals} x
            where x.pipeline_id = ${data.targetPipelineId} and x.client_id = o.client_id
         )
      ),
      todo as (
        select o.client_id, (row_number() over (order by o.ord) - 1)::int as i
          from ordered o
         where o.id not in (select id from dup)
      ),
      start as (
        select coalesce(max(d.position) + 1, 0) as p from ${crmDeals} d where d.stage_id = (select id from st)
      ),
      elig as (
        select coalesce(array_agg(e.user_id order by e.user_id), '{}'::uuid[]) as ids
          from (${eligibleOwners(sql`${data.targetPipelineId}`)}) e
      ),
      owned as (
        select t.client_id, t.i,
               case (select rule from tgt)
                 when 'single_user' then case when (select single from tgt) = any(e.ids) then (select single from tgt) end
                 when 'round_robin' then case when cardinality(e.ids) > 0
                   then e.ids[(((select cursor from tgt) + t.i) % cardinality(e.ids)) + 1] end
               end as owner
          from todo t cross join elig e
      ),
      ins as (
        insert into ${crmDeals} (tenant_id, pipeline_id, stage_id, client_id, position, created_by, owner_id, assignment_source)
        select ${data.tenantId}, ${data.targetPipelineId}, st.id, o.client_id,
               (select p from start) + o.i,
               ${data.createdBy},
               o.owner,
               case when o.owner is not null then (select rule from tgt) end
          from owned o cross join st
        -- A client added to the target a moment ago: skipped, not an error.
        on conflict do nothing
        returning owner_id
      ),
      cursor_moved as (
        update ${crmPipelines}
           set round_robin_cursor = ((select cursor from tgt) + (select count(*) from ins)) % cardinality((select ids from elig))
         where id = ${data.targetPipelineId}
           and (select rule from tgt) = 'round_robin'
           and cardinality((select ids from elig)) > 0
        returning 1
      )
      select (select count(*) from st)::int as stage_found,
             (select count(*) from req)::int as found,
             (select count(*) from ins)::int as added,
             (select count(*) from ins where owner_id is null)::int as unassigned,
             coalesce(
               (select json_agg(json_build_object('dealId', dp.id, 'clientName', c.name) order by c.name)
                  from dup dp join ${clients} c on c.id = dp.client_id),
               '[]'::json
             ) as skipped
    `);
    const row = result.rows[0];
    return {
      stageFound: row.stage_found > 0,
      found: row.found,
      added: row.added,
      unassigned: row.unassigned,
      skipped: row.skipped,
    };
  }

  /**
   * Deletes the given deals in one statement, only those in pipelines the
   * person can see (the Owner sees every pipeline; anyone else, the ones
   * they're on). Returns how many went.
   */
  async deleteMany(tx: TenantTx, data: { dealIds: string[]; userId: string; isOwner: boolean }): Promise<number> {
    const visible = data.isOwner
      ? sql`true`
      : sql`exists (
          select 1 from ${crmPipelineUsers} u where u.pipeline_id = d.pipeline_id and u.user_id = ${data.userId}
        )`;
    const result = await tx.execute<{ deleted: number }>(sql`
      with gone as (
        delete from ${crmDeals} d
         where d.id = any(${uuidArray(data.dealIds)}) and ${visible}
        returning 1
      )
      select count(*)::int as deleted from gone
    `);
    return result.rows[0].deleted;
  }
}
