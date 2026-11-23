import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import type { TenantTx } from '../db/tenant-db.js';

/** The company's zone when it hasn't saved Reports settings yet. */
export const DEFAULT_REPORTS_TIMEZONE = 'Asia/Kolkata';

/**
 * What a report carries besides its works: a link, or an uploaded file (its
 * storage key stays on the server; the service swaps it for a signed link).
 */
export type ReportAttachment =
  | { type: 'url'; url: string }
  | {
      type: 'file';
      key: string;
      name: string;
      size: number;
      contentType: string;
    };

/** A report as the repository reads it. Timestamps are ISO strings. */
export interface ReportView {
  id: string;
  reportDate: string;
  reports: string[];
  createdBy: string | null;
  createdByName: string | null;
  submittedAt: string;
  updatedAt: string;
  editedAt: string | null;
  attachment: ReportAttachment | null;
  remarks: string | null;
  /** Submitted after the due time on the day it covers (company timezone). */
  late: boolean;
}

/** The company's Reports settings, plus "today" as the caller sees it. */
export interface ReportsContext {
  timezone: string;
  dueTime: string | null;
  skipDays: number[];
  updatedAt: string | null;
  /** Today's `YYYY-MM-DD` in the company's timezone. */
  today: string;
  /** Whether the caller already filed a report for `today`. */
  submittedToday: boolean;
}

export interface ReportContent {
  reportDate: string;
  reportItems: string[];
  attachment: ReportAttachment | null;
}

/** One day of the month view: how many reports were filed, and how many late. */
export interface ReportDaySummary {
  date: string;
  count: number;
  late: number;
  /** Whether `mine` (the caller) filed a report that day. */
  mine: boolean;
}

export interface ReportPerson {
  id: string;
  fullName: string;
  isActive: boolean;
}

interface ReportRow extends Omit<ReportView, 'attachment'> {
  attachmentType: 'url' | 'file' | null;
  attachmentUrl: string | null;
  attachmentKey: string | null;
  attachmentName: string | null;
  attachmentSize: number | null;
  attachmentContentType: string | null;
}

const iso = (column: SQL) => sql`(to_json(${column}) #>> '{}')`;
const zone = sql`coalesce(s.timezone, ${DEFAULT_REPORTS_TIMEZONE})`;

/**
 * One report with its author's name and late flag. `r` is a reports row (the
 * table, or a CTE of rows just written), so writes return this shape in the
 * same statement. RLS limits `report_settings` to the company's one row.
 */
/** Submitted after the due time on the day it covers, in the company's zone. */
const lateExpr = sql`coalesce(
    s.due_time is not null
      and r.submitted_at > ((r.report_date + s.due_time) at time zone ${zone}),
    false
  )`;

const reportColumns = sql`
  r.id,
  r.report_date::text as "reportDate",
  r.report_items as "reports",
  r.created_by as "createdBy",
  u.full_name as "createdByName",
  ${iso(sql`r.submitted_at`)} as "submittedAt",
  ${iso(sql`r.updated_at`)} as "updatedAt",
  ${iso(sql`r.edited_at`)} as "editedAt",
  r.attachment_type as "attachmentType",
  r.attachment_url as "attachmentUrl",
  r.attachment_key as "attachmentKey",
  r.attachment_name as "attachmentName",
  r.attachment_size as "attachmentSize",
  r.attachment_content_type as "attachmentContentType",
  r.remarks,
  ${lateExpr} as late`;

const reportJoins = sql`
  left join users u on u.id = r.created_by
  left join report_settings s on s.tenant_id = r.tenant_id`;

function toView({
  attachmentType,
  attachmentUrl,
  attachmentKey,
  attachmentName,
  attachmentSize,
  attachmentContentType,
  ...row
}: ReportRow): ReportView {
  const attachment: ReportAttachment | null =
    attachmentType === 'url' && attachmentUrl
      ? { type: 'url', url: attachmentUrl }
      : attachmentType === 'file' && attachmentKey
        ? {
            type: 'file',
            key: attachmentKey,
            name: attachmentName ?? 'file',
            size: Number(attachmentSize ?? 0),
            contentType: attachmentContentType ?? 'application/octet-stream',
          }
        : null;
  return { ...row, attachment };
}

/** The six attachment columns for a link, a file, or nothing. */
function attachmentValues(a: ReportAttachment | null) {
  return {
    type: a?.type ?? null,
    url: a?.type === 'url' ? a.url : null,
    key: a?.type === 'file' ? a.key : null,
    name: a?.type === 'file' ? a.name : null,
    size: a?.type === 'file' ? a.size : null,
    contentType: a?.type === 'file' ? a.contentType : null,
  };
}

@Injectable()
export class ReportsRepository {
  /** One page, newest report date first, with the total in the same query. */
  async page(
    tx: TenantTx,
    opts: {
      page: number;
      pageSize: number;
      reportDate?: string;
      createdBy?: string;
    },
  ): Promise<{ items: ReportView[]; total: number }> {
    const conditions: SQL[] = [];
    if (opts.reportDate)
      conditions.push(sql`r.report_date = ${opts.reportDate}::date`);
    if (opts.createdBy)
      conditions.push(sql`r.created_by = ${opts.createdBy}::uuid`);
    const where = conditions.length
      ? sql`where ${sql.join(conditions, sql` and `)}`
      : sql``;

    const result = await tx.execute<ReportRow & { total: number }>(sql`
      select ${reportColumns}, count(*) over ()::int as total
        from reports r ${reportJoins}
        ${where}
       order by r.report_date desc, r.submitted_at desc, r.id desc
       limit ${opts.pageSize} offset ${(opts.page - 1) * opts.pageSize}`);
    if (result.rows.length) {
      const total = result.rows[0].total;
      return {
        items: result.rows.map(({ total: _total, ...row }) => toView(row)),
        total,
      };
    }
    // Past the last page: count only in that rare case.
    if (opts.page === 1) return { items: [], total: 0 };
    const counted = await tx.execute<{ total: number }>(
      sql`select count(*)::int as total from reports r ${where}`,
    );
    return { items: [], total: counted.rows[0]?.total ?? 0 };
  }

  /**
   * Per-day counts between `from` and `to` (inclusive), for the calendar: one
   * grouped query. Days with no reports are left out.
   */
  async daySummaries(
    tx: TenantTx,
    opts: { from: string; to: string; createdBy?: string; me: string },
  ): Promise<ReportDaySummary[]> {
    const byPerson = opts.createdBy
      ? sql`and r.created_by = ${opts.createdBy}::uuid`
      : sql``;
    const result = await tx.execute<ReportDaySummary>(sql`
      select r.report_date::text as date,
             count(*)::int as count,
             (count(*) filter (where ${lateExpr}))::int as late,
             bool_or(r.created_by = ${opts.me}::uuid) as mine
        from reports r
        left join report_settings s on s.tenant_id = r.tenant_id
       where r.report_date between ${opts.from}::date and ${opts.to}::date
             ${byPerson}
       group by r.report_date
       order by r.report_date`);
    return result.rows;
  }

  async find(tx: TenantTx, id: string): Promise<ReportView | null> {
    const result = await tx.execute<ReportRow>(sql`
      select ${reportColumns} from reports r ${reportJoins} where r.id = ${id}::uuid`);
    return result.rows[0] ? toView(result.rows[0]) : null;
  }

  /** Settings (or their defaults) and today's status for `userId`, in one query. */
  async context(tx: TenantTx, userId: string): Promise<ReportsContext> {
    const today = sql`(now() at time zone ${zone})::date`;
    const result = await tx.execute<ReportsContext>(sql`
      select ${zone} as timezone,
             to_char(s.due_time, 'HH24:MI') as "dueTime",
             coalesce(s.skip_days, '{}'::smallint[]) as "skipDays",
             ${iso(sql`s.updated_at`)} as "updatedAt",
             ${today}::text as today,
             exists (
               select 1 from reports r
                where r.created_by = ${userId}::uuid and r.report_date = ${today}
             ) as "submittedToday"
        from (select 1) as one
        left join report_settings s on true`);
    const row = result.rows[0];
    return { ...row, skipDays: (row.skipDays ?? []).map(Number) };
  }

  /** Inserts a report; a second report for the same person and date is a unique violation. */
  async create(
    tx: TenantTx,
    tenantId: string,
    createdBy: string,
    content: ReportContent,
  ): Promise<ReportView> {
    const a = attachmentValues(content.attachment);
    const result = await tx.execute<ReportRow>(sql`
      with r as (
        insert into reports (tenant_id, report_date, report_items, created_by, attachment_type, attachment_url,
                             attachment_key, attachment_name, attachment_size, attachment_content_type)
        values (
          ${tenantId}::uuid,
          ${content.reportDate}::date,
          ${JSON.stringify(content.reportItems)}::jsonb,
          ${createdBy}::uuid,
          ${a.type},
          ${a.url},
          ${a.key},
          ${a.name},
          ${a.size}::int,
          ${a.contentType}
        )
        returning *
      )
      select ${reportColumns} from r ${reportJoins}`);
    return toView(result.rows[0]);
  }

  /** Replaces the content; `edited` stamps edited_at in the same statement. */
  async update(
    tx: TenantTx,
    id: string,
    content: ReportContent,
    edited: boolean,
  ): Promise<ReportView | null> {
    const a = attachmentValues(content.attachment);
    const result = await tx.execute<ReportRow>(sql`
      with r as (
        update reports
           set report_date = ${content.reportDate}::date,
               report_items = ${JSON.stringify(content.reportItems)}::jsonb,
               attachment_type = ${a.type},
               attachment_url = ${a.url},
               attachment_key = ${a.key},
               attachment_name = ${a.name},
               attachment_size = ${a.size}::int,
               attachment_content_type = ${a.contentType},
               updated_at = now(),
               edited_at = case when ${edited} then now() else edited_at end
         where id = ${id}::uuid
        returning *
      )
      select ${reportColumns} from r ${reportJoins}`);
    return result.rows[0] ? toView(result.rows[0]) : null;
  }

  async updateRemarks(
    tx: TenantTx,
    id: string,
    remarks: string | null,
  ): Promise<ReportView | null> {
    const result = await tx.execute<ReportRow>(sql`
      with r as (
        update reports set remarks = ${remarks}, updated_at = now()
         where id = ${id}::uuid
        returning *
      )
      select ${reportColumns} from r ${reportJoins}`);
    return result.rows[0] ? toView(result.rows[0]) : null;
  }

  /**
   * Deletes the report when `onlyIfAuthorWithin` allows it: null deletes any
   * report; otherwise only that author's, while `submitted_at` is newer than
   * the window. Returns the deleted report's file key (to remove from storage),
   * or null when nothing was deleted.
   */
  async remove(
    tx: TenantTx,
    id: string,
    onlyIfAuthorWithin: { userId: string; windowMs: number } | null,
  ): Promise<{ fileKey: string | null } | null> {
    const guard = onlyIfAuthorWithin
      ? sql`and created_by = ${onlyIfAuthorWithin.userId}::uuid
            and submitted_at > now() - make_interval(secs => ${onlyIfAuthorWithin.windowMs / 1000})`
      : sql``;
    const result = await tx.execute<{ fileKey: string | null }>(sql`
      delete from reports where id = ${id}::uuid ${guard} returning attachment_key as "fileKey"`);
    return result.rows[0] ?? null;
  }

  async upsertSettings(
    tx: TenantTx,
    tenantId: string,
    data: { timezone: string; dueTime: string | null; skipDays: number[] },
    updatedBy: string,
  ): Promise<void> {
    const skipDays = sql`${`{${data.skipDays.join(',')}}`}::smallint[]`;
    await tx.execute(sql`
      insert into report_settings (tenant_id, timezone, due_time, skip_days, updated_by, updated_at)
      values (${tenantId}::uuid, ${data.timezone}, ${data.dueTime}::time, ${skipDays}, ${updatedBy}::uuid, now())
      on conflict (tenant_id) do update set
        timezone = excluded.timezone,
        due_time = excluded.due_time,
        skip_days = excluded.skip_days,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at`);
  }

  /**
   * People for the person filter: active people, plus deactivated people who
   * filed reports. `query` matches name or email (literally: % and _ are
   * escaped), names starting with it first. `selected` is always included, so
   * the active filter can show its name. One query.
   */
  async people(
    tx: TenantTx,
    opts: { query: string; limit: number; selected?: string },
  ): Promise<ReportPerson[]> {
    // Escape LIKE's wildcards (and its escape character) so they match literally.
    const term = opts.query.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const match = term
      ? sql`and (u.full_name ilike ${`%${term}%`} or u.email ilike ${`%${term}%`})`
      : sql``;
    const selected = opts.selected
      ? sql`or u.id = ${opts.selected}::uuid`
      : sql``;
    // The selected person sorts first, so the limit never cuts them off.
    const selectedFirst = opts.selected
      ? sql`u.id = ${opts.selected}::uuid desc,`
      : sql``;
    const result = await tx.execute<ReportPerson>(sql`
      select u.id, u.full_name as "fullName", u.is_active as "isActive"
        from users u
       where ((u.is_active or exists (select 1 from reports r where r.created_by = u.id)) ${match})
             ${selected}
       order by ${selectedFirst}
                case when u.full_name ilike ${`${term}%`} then 0 else 1 end,
                u.is_active desc, lower(u.full_name), u.id
       limit ${opts.limit + (opts.selected ? 1 : 0)}`);
    return result.rows;
  }
}
