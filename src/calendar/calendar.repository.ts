import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import type { TenantTx } from '../db/tenant-db.js';
import type { CalendarEventType } from '../db/schema.js';
import { DEFAULT_REPORTS_TIMEZONE } from '../reports/reports.repository.js';

/** An event as the repository reads it. Timestamps are ISO strings. */
export interface CalendarEventView {
  id: string;
  type: CalendarEventType;
  title: string;
  description: string | null;
  status: 'scheduled' | 'cancelled';
  startsAt: string;
  endsAt: string;
  location: string | null;
  visibility: 'open' | 'private' | null;
  cancelReason: string | null;
  version: number;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  /** Meeting invitees (the creator is implicit and not listed). */
  members: { id: string; fullName: string }[];
  /** Whether the viewer is an invitee. */
  isMember: boolean;
}

export interface CalendarPerson {
  id: string;
  fullName: string;
  role: 'owner' | 'manager' | 'staff';
}

export interface NewCalendarEvent {
  type: CalendarEventType;
  title: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date;
  location: string | null;
  visibility: 'open' | 'private' | null;
}

export interface CalendarEventPatch {
  title?: string;
  description?: string | null;
  startsAt?: Date;
  endsAt?: Date;
  location?: string;
  visibility?: 'open' | 'private';
}

const iso = (column: SQL) => sql`(to_json(${column}) #>> '{}')`;
const uuidArray = (ids: readonly string[]) =>
  ids.length
    ? sql`array[${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )}]::uuid[]`
    : sql`'{}'::uuid[]`;

/**
 * Who can be invited, and who the people picker offers: active people in the
 * company who can open the Calendar (the owner, or a `calendar` grant).
 */
const canOpenCalendar = (user: SQL) => sql`(
  ${user}.role = 'owner'
  or exists (
    select 1 from user_access ua
      join access_items ai on ai.id = ua.access_item_id
     where ua.user_id = ${user}.id and ai.key = 'calendar' and ai.is_active
  )
)`;

/**
 * The one visibility rule (decision C3): announcements, and meetings that are
 * open or where the viewer is the creator or a member. The owner sees every
 * meeting in full, private ones included. RLS has already limited rows to the
 * viewer's company.
 */
const visibleTo = (me: string, owner: boolean) => sql`(
  e.deleted_at is null
  and (
    e.type = 'announcement'
    or (e.type = 'meeting' and (
      ${owner}
      or e.visibility = 'open'
      or e.created_by = ${me}::uuid
      or exists (select 1 from calendar_meeting_members m where m.event_id = e.id and m.user_id = ${me}::uuid)
    ))
  )
)`;

/** One event with its creator's name and its members, as seen by `me`. */
const eventColumns = (me: string) => sql`
  e.id,
  e.type,
  e.title,
  e.description,
  e.status,
  ${iso(sql`e.starts_at`)} as "startsAt",
  ${iso(sql`e.ends_at`)} as "endsAt",
  e.location,
  e.visibility,
  e.cancel_reason as "cancelReason",
  e.version,
  e.created_by as "createdBy",
  cu.full_name as "createdByName",
  ${iso(sql`e.created_at`)} as "createdAt",
  ${iso(sql`e.updated_at`)} as "updatedAt",
  coalesce((
    select json_agg(json_build_object('id', mu.id, 'fullName', mu.full_name) order by lower(mu.full_name), mu.id)
      from calendar_meeting_members m join users mu on mu.id = m.user_id
     where m.event_id = e.id
  ), '[]'::json) as members,
  exists (select 1 from calendar_meeting_members m where m.event_id = e.id and m.user_id = ${me}::uuid) as "isMember"`;

@Injectable()
export class CalendarRepository {
  /** Events overlapping [from, to) the viewer can see, earliest first, at most `cap`. */
  async list(
    tx: TenantTx,
    me: string,
    owner: boolean,
    from: Date,
    to: Date,
    cap: number,
  ): Promise<CalendarEventView[]> {
    const result = await tx.execute<CalendarEventView>(sql`
      select ${eventColumns(me)}
        from calendar_events e
        left join users cu on cu.id = e.created_by
       where ${visibleTo(me, owner)}
         and e.starts_at < ${to.toISOString()}::timestamptz
         and e.ends_at > ${from.toISOString()}::timestamptz
       order by e.starts_at, e.id
       limit ${cap}`);
    return result.rows;
  }

  /** One event, or null when it doesn't exist, was deleted, or the viewer can't see it. */
  async find(
    tx: TenantTx,
    me: string,
    owner: boolean,
    id: string,
  ): Promise<CalendarEventView | null> {
    const result = await tx.execute<CalendarEventView>(sql`
      select ${eventColumns(me)}
        from calendar_events e
        left join users cu on cu.id = e.created_by
       where e.id = ${id}::uuid and ${visibleTo(me, owner)}`);
    return result.rows[0] ?? null;
  }

  /**
   * Inserts the event, its members and the `created` log entry in one
   * statement. Members must be active people in the company who can open the
   * Calendar; the creator is never stored as a member. Returns the new id and
   * how many of `memberIds` qualified (the caller rejects a shortfall).
   */
  async create(
    tx: TenantTx,
    tenantId: string,
    me: string,
    event: NewCalendarEvent,
    memberIds: readonly string[],
  ): Promise<{ id: string; validMembers: number }> {
    const result = await tx.execute<{ id: string; validMembers: number }>(sql`
      with e as (
        insert into calendar_events (tenant_id, type, title, description, starts_at, ends_at, location, visibility, created_by)
        values (
          ${tenantId}::uuid, ${event.type}, ${event.title}, ${event.description},
          ${event.startsAt.toISOString()}::timestamptz, ${event.endsAt.toISOString()}::timestamptz,
          ${event.location}, ${event.visibility}, ${me}::uuid
        )
        returning id, tenant_id, status
      ),
      valid as (
        select u.id from users u
         where u.id = any(${uuidArray(memberIds)}) and u.id <> ${me}::uuid and u.is_active and ${canOpenCalendar(sql`u`)}
      ),
      m as (
        insert into calendar_meeting_members (tenant_id, event_id, user_id)
        select e.tenant_id, e.id, valid.id from e, valid
        returning user_id
      ),
      l as (
        insert into calendar_event_log (tenant_id, event_id, actor_id, action, to_status)
        select e.tenant_id, e.id, ${me}::uuid, 'created', e.status from e
      )
      select e.id, (select count(*) from valid)::int as "validMembers", (select count(*) from m)::int as inserted
        from e`);
    return result.rows[0];
  }

  /**
   * Applies an edit against the version that was read, replaces the member
   * list when `memberIds` is given (removing the dropped, adding the new),
   * and logs it, all in one statement. `updated` is 0 when the version was
   * stale or the event is gone.
   */
  async update(
    tx: TenantTx,
    me: string,
    id: string,
    version: number,
    patch: CalendarEventPatch,
    memberIds: readonly string[] | null,
    changed: string[],
  ): Promise<{ updated: number; validMembers: number }> {
    const sets: SQL[] = [sql`version = version + 1`, sql`updated_at = now()`];
    if (patch.title !== undefined) sets.push(sql`title = ${patch.title}`);
    if (patch.description !== undefined)
      sets.push(sql`description = ${patch.description}`);
    if (patch.startsAt)
      sets.push(sql`starts_at = ${patch.startsAt.toISOString()}::timestamptz`);
    if (patch.endsAt)
      sets.push(sql`ends_at = ${patch.endsAt.toISOString()}::timestamptz`);
    if (patch.location !== undefined)
      sets.push(sql`location = ${patch.location}`);
    if (patch.visibility !== undefined)
      sets.push(sql`visibility = ${patch.visibility}`);
    const replace = memberIds !== null;
    const ids = memberIds ?? [];

    const result = await tx.execute<{
      updated: number;
      validMembers: number;
    }>(sql`
      with e as (
        update calendar_events set ${sql.join(sets, sql`, `)}
         where id = ${id}::uuid and version = ${version} and deleted_at is null
        returning id, tenant_id, created_by
      ),
      valid as (
        select u.id from users u, e
         where ${replace} and u.id = any(${uuidArray(ids)}) and u.id is distinct from e.created_by
           and u.is_active and ${canOpenCalendar(sql`u`)}
      ),
      dropped as (
        delete from calendar_meeting_members m using e
         where ${replace} and m.event_id = e.id and m.user_id <> all(${uuidArray(ids)})
        returning m.user_id
      ),
      added as (
        insert into calendar_meeting_members (tenant_id, event_id, user_id)
        select e.tenant_id, e.id, valid.id from e, valid
        on conflict do nothing
        returning user_id
      ),
      l as (
        insert into calendar_event_log (tenant_id, event_id, actor_id, action, meta)
        select e.tenant_id, e.id, ${me}::uuid, 'updated', ${JSON.stringify({ changed })}::jsonb from e
      )
      select (select count(*) from e)::int as updated, (select count(*) from valid)::int as "validMembers"`);
    return result.rows[0];
  }

  /** Cancels a scheduled event against the version that was read, and logs it. */
  async cancel(
    tx: TenantTx,
    me: string,
    id: string,
    version: number,
    reason: string | null,
  ): Promise<boolean> {
    const result = await tx.execute<{ id: string }>(sql`
      with e as (
        update calendar_events
           set status = 'cancelled', cancel_reason = ${reason}, version = version + 1, updated_at = now()
         where id = ${id}::uuid and version = ${version} and status = 'scheduled' and deleted_at is null
        returning id, tenant_id
      ),
      l as (
        insert into calendar_event_log (tenant_id, event_id, actor_id, action, from_status, to_status, reason)
        select e.tenant_id, e.id, ${me}::uuid, 'cancelled', 'scheduled', 'cancelled', ${reason} from e
      )
      select id from e`);
    return result.rows.length > 0;
  }

  /**
   * Brings a cancelled event back (only while its start is still ahead),
   * against the version that was read, and logs it.
   */
  async restore(
    tx: TenantTx,
    me: string,
    id: string,
    version: number,
  ): Promise<boolean> {
    const result = await tx.execute<{ id: string }>(sql`
      with e as (
        update calendar_events
           set status = 'scheduled', cancel_reason = null, version = version + 1, updated_at = now()
         where id = ${id}::uuid and version = ${version} and status = 'cancelled'
           and starts_at > now() and deleted_at is null
        returning id, tenant_id
      ),
      l as (
        insert into calendar_event_log (tenant_id, event_id, actor_id, action, from_status, to_status)
        select e.tenant_id, e.id, ${me}::uuid, 'restored', 'cancelled', 'scheduled' from e
      )
      select id from e`);
    return result.rows.length > 0;
  }

  /** Soft delete (the log keeps the event), and logs it. */
  async remove(tx: TenantTx, me: string, id: string): Promise<boolean> {
    const result = await tx.execute<{ id: string }>(sql`
      with e as (
        update calendar_events
           set deleted_at = now(), deleted_by = ${me}::uuid, version = version + 1, updated_at = now()
         where id = ${id}::uuid and deleted_at is null
        returning id, tenant_id, status
      ),
      l as (
        insert into calendar_event_log (tenant_id, event_id, actor_id, action, from_status)
        select e.tenant_id, e.id, ${me}::uuid, 'deleted', e.status from e
      )
      select id from e`);
    return result.rows.length > 0;
  }

  /** The company's timezone (shared with Reports for now) and today in it. */
  async context(tx: TenantTx): Promise<{ timezone: string; today: string }> {
    const zone = sql`coalesce(s.timezone, ${DEFAULT_REPORTS_TIMEZONE})`;
    const result = await tx.execute<{ timezone: string; today: string }>(sql`
      select ${zone} as timezone, (now() at time zone ${zone})::date::text as today
        from (select 1) as one
        left join report_settings s on true`);
    return result.rows[0];
  }

  /** People who can be invited: name or email matches, prefix matches first, at most `limit`. */
  async people(
    tx: TenantTx,
    query: string,
    limit: number,
  ): Promise<CalendarPerson[]> {
    const term = query.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const match = term
      ? sql`and (u.full_name ilike ${`%${term}%`} or u.email ilike ${`%${term}%`})`
      : sql``;
    const result = await tx.execute<CalendarPerson>(sql`
      select u.id, u.full_name as "fullName", u.role
        from users u
       where u.is_active and ${canOpenCalendar(sql`u`)} ${match}
       order by case when u.full_name ilike ${`${term}%`} then 0 else 1 end, lower(u.full_name), u.id
       limit ${limit}`);
    return result.rows;
  }
}
