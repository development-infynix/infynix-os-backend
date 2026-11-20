import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import {
  accessItems,
  crmDeals,
  crmPipelines,
  crmPipelineUsers,
  userAccess,
  users,
  type CrmAssignmentRule,
} from '../db/schema.js';
import type { TenantTx } from '../db/tenant-db.js';

/** Deals per bulk-tool request (see docs/performance.md). */
export const ASSIGNMENT_CHUNK = 500;

/** Assigned deal counts by how they were assigned. */
export type SourceCounts = Partial<Record<CrmAssignmentRule, number>>;

/** Someone on a pipeline's access list, as the Assign deals drawer shows them. */
export interface AssignmentPerson {
  userId: string;
  fullName: string;
  email: string;
  role: string;
  /** Can receive deals now: active, with the CRM grant, not the Owner. */
  eligible: boolean;
  dealCount: number;
  bySource: SourceCounts;
}

export interface AssignmentOverview {
  rule: CrmAssignmentRule;
  singleUserId: string | null;
  total: number;
  assigned: number;
  bySource: SourceCounts;
  people: AssignmentPerson[];
}

/** Anyone who could be on a pipeline's access list (Access users tab). */
export interface AccessCandidate {
  userId: string;
  fullName: string;
  email: string;
  role: string;
  onList: boolean;
  eligible: boolean;
  /** Deals they own in this pipeline. */
  dealCount: number;
}

/**
 * The people on `pipelineId`'s access list who can own deals: active, with
 * the `crm` grant, never the Owner. Ordered by user id, the stable order
 * round robin walks. The one definition every rule, tool and pick uses.
 */
const eligibleOwners = (pipelineId: SQL) => sql`
  select pu.user_id
    from ${crmPipelineUsers} pu
    join ${users} u on u.id = pu.user_id and u.tenant_id = pu.tenant_id
   where pu.pipeline_id = ${pipelineId}
     and u.is_active
     and u.role <> 'owner'
     and exists (
       select 1 from ${userAccess} ua
         join ${accessItems} ai on ai.id = ua.access_item_id
        where ua.user_id = u.id and ai.key = 'crm' and ai.is_active
     )
`;

/** The same test for one person, by user id (no access-list condition). */
const canUseCrm = (userAlias: SQL) => sql`
  ${userAlias}.is_active
  and ${userAlias}.role <> 'owner'
  and exists (
    select 1 from ${userAccess} ua
      join ${accessItems} ai on ai.id = ua.access_item_id
     where ua.user_id = ${userAlias}.id and ai.key = 'crm' and ai.is_active
  )
`;

const uuidArray = (ids: string[]) =>
  ids.length
    ? sql`array[${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )}]::uuid[]`
    : sql`'{}'::uuid[]`;

/** Who owns which deal, and each pipeline's rule. RLS scopes everything to the company. */
@Injectable()
export class CrmAssignmentRepository {
  /** Totals, the rule and everyone on the access list with their deal counts, in one round trip. */
  async overview(tx: TenantTx, pipelineId: string): Promise<AssignmentOverview | null> {
    const result = await tx.execute<{
      rule: CrmAssignmentRule;
      single_user_id: string | null;
      total: number;
      assigned: number;
      by_source: SourceCounts;
      people: {
        userId: string;
        fullName: string;
        email: string;
        role: string;
        eligible: boolean;
        dealCount: number;
        bySource: SourceCounts | null;
      }[];
    }>(sql`
      select p.assignment_rule as rule,
             p.single_user_id,
             (select count(*) from ${crmDeals} d where d.pipeline_id = p.id)::int as total,
             (select count(*) from ${crmDeals} d where d.pipeline_id = p.id and d.owner_id is not null)::int as assigned,
             (select coalesce(json_object_agg(s.source, s.n), '{}'::json) from (
                select d.assignment_source as source, count(*)::int as n
                  from ${crmDeals} d
                 where d.pipeline_id = p.id and d.owner_id is not null and d.assignment_source is not null
                 group by d.assignment_source
              ) s) as by_source,
             (select coalesce(json_agg(x order by x."fullName", x."userId"), '[]'::json) from (
                select u.id as "userId", u.full_name as "fullName", u.email, u.role::text as role,
                       (${canUseCrm(sql`u`)}) as eligible,
                       (select count(*) from ${crmDeals} d where d.pipeline_id = p.id and d.owner_id = u.id)::int as "dealCount",
                       (select json_object_agg(s.source, s.n) from (
                          select d.assignment_source as source, count(*)::int as n
                            from ${crmDeals} d
                           where d.pipeline_id = p.id and d.owner_id = u.id and d.assignment_source is not null
                           group by d.assignment_source
                        ) s) as "bySource"
                  from ${crmPipelineUsers} pu
                  join ${users} u on u.id = pu.user_id and u.tenant_id = pu.tenant_id
                 where pu.pipeline_id = p.id
              ) x) as people
        from ${crmPipelines} p
       where p.id = ${pipelineId}
    `);
    const row = result.rows[0];
    if (!row) return null;
    return {
      rule: row.rule,
      singleUserId: row.single_user_id,
      total: row.total,
      assigned: row.assigned,
      bySource: row.by_source,
      people: row.people.map((person) => ({ ...person, bySource: person.bySource ?? {} })),
    };
  }

  /** Whether `userId` can own deals in `pipelineId` right now. */
  async isEligibleOwner(tx: TenantTx, pipelineId: string, userId: string): Promise<boolean> {
    const result = await tx.execute<{ ok: boolean }>(sql`
      select exists (select 1 from (${eligibleOwners(sql`${pipelineId}`)}) e where e.user_id = ${userId}) as ok
    `);
    return Boolean(result.rows[0]?.ok);
  }

  /**
   * Sets the rule for new deals. The single-user target is kept only for
   * `single_user`; switching to round robin restarts its cursor.
   */
  async setRule(
    tx: TenantTx,
    pipelineId: string,
    rule: CrmAssignmentRule,
    singleUserId: string | null,
  ): Promise<void> {
    await tx.execute(sql`
      update ${crmPipelines}
         set assignment_rule = ${rule},
             single_user_id = ${rule === 'single_user' ? singleUserId : null},
             round_robin_cursor = case
               when ${rule} = 'round_robin' and assignment_rule <> 'round_robin' then 0
               else round_robin_cursor
             end,
             updated_at = now()
       where id = ${pipelineId}
    `);
  }

  /**
   * Share (round robin) or Give (single user): up to `limit` of the oldest
   * unassigned deals get owners, in one statement under the pipeline lock.
   * Round robin continues from the shared cursor and advances it. Never
   * reads or changes the rule. `targetOk` is false when a Give target can't
   * own deals; `eligibleCount` 0 means nobody can receive them.
   */
  async distribute(
    tx: TenantTx,
    data: { pipelineId: string; method: 'round_robin' | 'single_user'; userId: string | null; limit: number },
  ): Promise<{ assigned: number; remaining: number; eligibleCount: number; targetOk: boolean }> {
    const result = await tx.execute<{ assigned: number; remaining: number; eligible_count: number; target_ok: boolean }>(sql`
      with p as (
        select id, round_robin_cursor as cursor from ${crmPipelines} where id = ${data.pipelineId} for no key update
      ),
      elig as (
        select coalesce(array_agg(e.user_id order by e.user_id), '{}'::uuid[]) as ids
          from (${eligibleOwners(sql`${data.pipelineId}`)}) e
      ),
      target as (
        select ${data.userId}::uuid = any(e.ids) as ok from elig e
      ),
      batch as (
        select d.id, (row_number() over (order by d.created_at, d.id) - 1)::int as i
          from ${crmDeals} d
         where d.pipeline_id = ${data.pipelineId} and d.owner_id is null
         order by d.created_at, d.id
         limit ${data.limit}
      ),
      planned as (
        select b.id,
               case
                 when ${data.method} = 'round_robin' then
                   case when cardinality(e.ids) > 0
                        then e.ids[(((select cursor from p) + b.i) % cardinality(e.ids)) + 1] end
                 else case when (select ok from target) then ${data.userId}::uuid end
               end as owner
          from batch b cross join elig e
      ),
      upd as (
        update ${crmDeals} d
           set owner_id = pl.owner, assignment_source = ${data.method}, updated_at = now()
          from planned pl
         where d.id = pl.id and pl.owner is not null
        returning d.id
      ),
      cur as (
        update ${crmPipelines}
           set round_robin_cursor = ((select cursor from p) + (select count(*) from upd)) % cardinality((select ids from elig))
         where id = ${data.pipelineId}
           and ${data.method} = 'round_robin'
           and cardinality((select ids from elig)) > 0
        returning 1
      )
      select (select count(*) from upd)::int as assigned,
             ((select count(*) from ${crmDeals} d where d.pipeline_id = ${data.pipelineId} and d.owner_id is null)
               - (select count(*) from upd))::int as remaining,
             cardinality((select ids from elig))::int as eligible_count,
             coalesce((select ok from target), false) as target_ok
    `);
    const row = result.rows[0];
    return {
      assigned: row.assigned,
      remaining: row.remaining,
      eligibleCount: row.eligible_count,
      targetOk: row.target_ok,
    };
  }

  /**
   * Unassign (to = null) or Transfer (to = someone): up to `limit` deals that
   * match `from` and/or `source` change owner in one statement. Transfer only
   * changes the owner; each deal keeps its source and the rule is untouched.
   */
  async reassign(
    tx: TenantTx,
    data: {
      pipelineId: string;
      from: string | null;
      source: CrmAssignmentRule | null;
      to: string | null;
      limit: number;
    },
  ): Promise<{ changed: number; remaining: number }> {
    const match = sql`
      d.pipeline_id = ${data.pipelineId}
      and d.owner_id is not null
      ${data.from ? sql`and d.owner_id = ${data.from}` : sql``}
      ${data.source ? sql`and d.assignment_source = ${data.source}` : sql``}
      ${data.to ? sql`and d.owner_id <> ${data.to}` : sql``}
    `;
    const result = await tx.execute<{ changed: number; remaining: number }>(sql`
      with batch as (
        select d.id from ${crmDeals} d
         where ${match}
         order by d.created_at, d.id
         limit ${data.limit}
         for update
      ),
      upd as (
        update ${crmDeals} d
           set owner_id = ${data.to},
               assignment_source = ${data.to ? sql`d.assignment_source` : sql`null`},
               updated_at = now()
          from batch b
         where d.id = b.id
        returning d.id
      )
      select (select count(*) from upd)::int as changed,
             ((select count(*) from ${crmDeals} d where ${match}) - (select count(*) from upd))::int as remaining
    `);
    return result.rows[0];
  }

  /** Sets or clears one deal's owner by hand (source `manual`). The deal's pipeline must match. */
  async setDealOwner(tx: TenantTx, dealId: string, ownerId: string | null): Promise<boolean> {
    const result = await tx.execute<{ id: string }>(sql`
      update ${crmDeals}
         set owner_id = ${ownerId}, assignment_source = ${ownerId ? 'manual' : null}, updated_at = now()
       where id = ${dealId}
      returning id
    `);
    return result.rows.length > 0;
  }

  /** Everyone who could be on the list (eligible company-wide) plus whoever already is. */
  async accessCandidates(tx: TenantTx, pipelineId: string): Promise<AccessCandidate[]> {
    const result = await tx.execute<AccessCandidate>(sql`
      select u.id as "userId", u.full_name as "fullName", u.email, u.role::text as role,
             (pu.user_id is not null) as "onList",
             (${canUseCrm(sql`u`)}) as eligible,
             (select count(*) from ${crmDeals} d where d.pipeline_id = ${pipelineId} and d.owner_id = u.id)::int as "dealCount"
        from ${users} u
        left join ${crmPipelineUsers} pu on pu.user_id = u.id and pu.pipeline_id = ${pipelineId}
       where pu.user_id is not null or (${canUseCrm(sql`u`)})
       order by u.full_name, u.id
    `);
    return result.rows;
  }

  /** Deals owned in this pipeline by people who are about to leave its list. */
  async dealsOwnedBy(tx: TenantTx, pipelineId: string, userIds: string[]): Promise<{ userId: string; n: number }[]> {
    if (!userIds.length) return [];
    const result = await tx.execute<{ userId: string; n: number }>(sql`
      select d.owner_id as "userId", count(*)::int as n
        from ${crmDeals} d
       where d.pipeline_id = ${pipelineId} and d.owner_id = any(${uuidArray(userIds)})
       group by d.owner_id
    `);
    return result.rows;
  }

  /**
   * Hands over the deals of people leaving the list (to `to`, or unassigned),
   * and switches the rule to manual if the single-user target is leaving.
   * Runs before they're removed, so the access-list foreign keys never fire.
   */
  async handOver(tx: TenantTx, pipelineId: string, leaving: string[], to: string | null): Promise<void> {
    if (!leaving.length) return;
    await tx.execute(sql`
      with moved as (
        update ${crmDeals} d
           set owner_id = ${to}, assignment_source = ${to ? sql`d.assignment_source` : sql`null`}, updated_at = now()
         where d.pipeline_id = ${pipelineId} and d.owner_id = any(${uuidArray(leaving)})
        returning 1
      )
      update ${crmPipelines}
         set assignment_rule = 'manual', single_user_id = null, updated_at = now()
       where id = ${pipelineId} and single_user_id = any(${uuidArray(leaving)})
    `);
  }

  /** Takes people off the list (after their deals were handed over). */
  async removeMembers(tx: TenantTx, pipelineId: string, leaving: string[]): Promise<void> {
    if (!leaving.length) return;
    await tx.execute(sql`
      delete from ${crmPipelineUsers}
       where pipeline_id = ${pipelineId} and user_id = any(${uuidArray(leaving)})
    `);
  }

  /** Current members of the list. */
  async members(tx: TenantTx, pipelineId: string): Promise<string[]> {
    const result = await tx.execute<{ user_id: string }>(sql`
      select user_id from ${crmPipelineUsers} where pipeline_id = ${pipelineId}
    `);
    return result.rows.map((row) => row.user_id);
  }

  /** Of `userIds`, those who can use the CRM (active, `crm` grant, not the Owner). */
  async crmUsersAmong(tx: TenantTx, userIds: string[]): Promise<Set<string>> {
    if (!userIds.length) return new Set();
    const result = await tx.execute<{ id: string }>(sql`
      select u.id from ${users} u where u.id = any(${uuidArray(userIds)}) and (${canUseCrm(sql`u`)})
    `);
    return new Set(result.rows.map((row) => row.id));
  }

  /** A deleted person can't stay the single-user target: their pipelines switch to manual. */
  async releaseSingleUser(tx: TenantTx, userId: string): Promise<void> {
    await tx.execute(sql`
      update ${crmPipelines}
         set assignment_rule = 'manual', single_user_id = null, updated_at = now()
       where single_user_id = ${userId}
    `);
  }
}

export { eligibleOwners };
