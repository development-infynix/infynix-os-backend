import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUniqueViolation } from '../db/errors.js';
import { TenantDb, type TenantTx } from '../db/tenant-db.js';
import type { Actor } from '../tenancy/tenancy.types.js';
import {
  ReportsRepository,
  type ReportsContext,
  type ReportView,
} from './reports.repository.js';
import type { CreateReportDto } from './dto/create-report.dto.js';
import type { UpdateReportDto } from './dto/update-report.dto.js';
import type { UpdateReportSettingsDto } from './dto/update-report-settings.dto.js';

/** How long an author may edit or delete their report after submitting it (database clock). */
export const EDIT_WINDOW_MS = 15 * 60 * 1000;

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/** Owners and managers see everyone's reports; staff see their own. */
const seesAll = (actor: Actor) =>
  actor.user.role === 'owner' || actor.user.role === 'manager';
/** Only owners edit others' reports, add remarks and change settings. */
const isOwner = (actor: Actor) => actor.user.role === 'owner';

/**
 * IANA names only ("Region/City" or UTC): Postgres reads abbreviations like
 * "IST" as Israel time. Intl accepts aliases too (Node lists India as the old
 * Asia/Calcutta; Asia/Kolkata must pass), and Postgres knows both spellings.
 */
function isTimezone(value: string): boolean {
  if (value !== 'UTC' && !/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/.test(value))
    return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Weekday of a plain `YYYY-MM-DD` date: 0 = Sunday … 6 = Saturday. */
function weekdayOf(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function isRealDate(date: string): boolean {
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function normalizeItems(items: string[]): string[] {
  return items.map((item) => {
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > 5000) {
      throw new BadRequestException(
        'Each work must be between 1 and 5000 characters.',
      );
    }
    return trimmed;
  });
}

function normalizeUrl(value: string | undefined): string {
  if (!value?.trim()) throw new BadRequestException('Enter the link.');
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new BadRequestException(
      'Enter a valid link, like https://example.com.',
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BadRequestException('Links must start with http:// or https://.');
  }
  return url.toString();
}

/** A date a report may cover: real, not after today, not an off day (company timezone). */
function assertDateAllowed(date: string, ctx: ReportsContext): void {
  if (!isRealDate(date)) throw new BadRequestException('Choose a valid date.');
  if (date > ctx.today)
    throw new BadRequestException("Reports can't be dated in the future.");
  const weekday = weekdayOf(date);
  if (ctx.skipDays.includes(weekday)) {
    throw new BadRequestException(
      `${WEEKDAY_NAMES[weekday]} is an off day. Reports can't be dated on it.`,
    );
  }
}

const DUPLICATE = 'You already submitted a report for this date.';

@Injectable()
export class ReportsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly reports: ReportsRepository,
  ) {}

  async list(
    actor: Actor,
    opts: { page: number; pageSize: number; date?: string; userId?: string },
  ) {
    // Staff always see only their own; a userId they send is ignored.
    const createdBy = seesAll(actor) ? opts.userId : actor.user.id;
    const { items, total } = await this.tenantDb.run(actor.tenant.id, (tx) =>
      this.reports.page(tx, {
        page: opts.page,
        pageSize: opts.pageSize,
        reportDate: opts.date,
        createdBy,
      }),
    );
    return {
      items,
      total,
      page: opts.page,
      pageSize: opts.pageSize,
      totalPages: Math.max(1, Math.ceil(total / opts.pageSize)),
    };
  }

  /** Per-day counts for a calendar range; staff only ever see their own. */
  async calendar(
    actor: Actor,
    opts: { from: string; to: string; userId?: string },
  ) {
    if (!isRealDate(opts.from) || !isRealDate(opts.to) || opts.from > opts.to) {
      throw new BadRequestException('Choose a valid date range.');
    }
    const days =
      (Date.parse(`${opts.to}T00:00:00Z`) -
        Date.parse(`${opts.from}T00:00:00Z`)) /
      86_400_000;
    if (days > 62)
      throw new BadRequestException(
        'A calendar range can cover at most 62 days.',
      );
    const createdBy = seesAll(actor) ? opts.userId : actor.user.id;
    const items = await this.tenantDb.run(actor.tenant.id, (tx) =>
      this.reports.daySummaries(tx, {
        from: opts.from,
        to: opts.to,
        createdBy,
        me: actor.user.id,
      }),
    );
    return { items };
  }

  async findOne(id: string, actor: Actor): Promise<ReportView> {
    const report = await this.tenantDb.run(actor.tenant.id, (tx) =>
      this.reports.find(tx, id),
    );
    return this.visible(report, id, actor);
  }

  async create(dto: CreateReportDto, actor: Actor): Promise<ReportView> {
    const reportItems = normalizeItems(dto.reports);
    const attachmentUrl =
      dto.attachmentMode === 'url' ? normalizeUrl(dto.attachmentUrl) : null;
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      assertDateAllowed(
        dto.reportDate,
        await this.reports.context(tx, actor.user.id),
      );
      try {
        return await this.reports.create(tx, actor.tenant.id, actor.user.id, {
          reportDate: dto.reportDate,
          reportItems,
          attachmentUrl,
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictException(DUPLICATE);
        throw error;
      }
    });
  }

  async update(
    id: string,
    dto: UpdateReportDto,
    actor: Actor,
  ): Promise<ReportView> {
    const reportItems = normalizeItems(dto.reports);
    if (dto.attachmentMode !== 'url' && dto.attachmentUrl) {
      throw new BadRequestException('Remove the unused link before saving.');
    }
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      const existing = this.assertCanChange(
        await this.reports.find(tx, id),
        id,
        actor,
        'edit',
      );
      // Date rules apply when the date moves; a report already on a new off day stays editable.
      if (dto.reportDate !== existing.reportDate) {
        assertDateAllowed(
          dto.reportDate,
          await this.reports.context(tx, actor.user.id),
        );
      }
      const attachmentUrl =
        dto.attachmentMode === 'keep'
          ? (existing.attachment?.url ?? null)
          : dto.attachmentMode === 'url'
            ? normalizeUrl(dto.attachmentUrl)
            : null;
      const edited =
        dto.reportDate !== existing.reportDate ||
        JSON.stringify(reportItems) !== JSON.stringify(existing.reports) ||
        attachmentUrl !== (existing.attachment?.url ?? null);
      try {
        const updated = await this.reports.update(
          tx,
          id,
          { reportDate: dto.reportDate, reportItems, attachmentUrl },
          edited,
        );
        if (!updated) throw new NotFoundException(`Report ${id} not found.`);
        return updated;
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictException(DUPLICATE);
        throw error;
      }
    });
  }

  async updateRemarks(
    id: string,
    remarks: string | null | undefined,
    actor: Actor,
  ): Promise<ReportView> {
    if (!isOwner(actor))
      throw new ForbiddenException('Only the owner can add remarks.');
    const next = remarks?.trim() || null;
    const updated = await this.tenantDb.run(actor.tenant.id, (tx) =>
      this.reports.updateRemarks(tx, id, next),
    );
    if (!updated) throw new NotFoundException(`Report ${id} not found.`);
    return updated;
  }

  async remove(id: string, actor: Actor): Promise<void> {
    await this.tenantDb.run(actor.tenant.id, async (tx) => {
      const guard = isOwner(actor)
        ? null
        : { userId: actor.user.id, windowMs: EDIT_WINDOW_MS };
      if (await this.reports.remove(tx, id, guard)) return;
      // Nothing deleted: look the report up only now, to say why.
      this.assertCanChange(
        await this.reports.find(tx, id),
        id,
        actor,
        'delete',
      );
      throw new ForbiddenException(this.windowMessage());
    });
  }

  async getSettings(actor: Actor) {
    return this.tenantDb.run(actor.tenant.id, (tx) =>
      this.settingsResponse(tx, actor),
    );
  }

  async updateSettings(dto: UpdateReportSettingsDto, actor: Actor) {
    if (!isOwner(actor))
      throw new ForbiddenException(
        'Only the owner can change Reports settings.',
      );
    if (!isTimezone(dto.timezone)) {
      throw new BadRequestException(
        'Choose a timezone from the list, like Asia/Kolkata.',
      );
    }
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      await this.reports.upsertSettings(
        tx,
        actor.tenant.id,
        {
          timezone: dto.timezone,
          dueTime: dto.dueTime,
          skipDays: [...dto.skipDays].sort((a, b) => a - b),
        },
        actor.user.id,
      );
      return this.settingsResponse(tx, actor);
    });
  }

  /** People for the person filter: owners and managers only. */
  async people(
    actor: Actor,
    opts: { query: string; limit: number; selected?: string },
  ) {
    if (!seesAll(actor))
      throw new ForbiddenException(
        'Only owners and managers can filter by person.',
      );
    const items = await this.tenantDb.run(actor.tenant.id, (tx) =>
      this.reports.people(tx, opts),
    );
    return { items };
  }

  private async settingsResponse(tx: TenantTx, actor: Actor) {
    const ctx = await this.reports.context(tx, actor.user.id);
    return {
      ...ctx,
      todayIsOffDay: ctx.skipDays.includes(weekdayOf(ctx.today)),
      editWindowMinutes: EDIT_WINDOW_MS / 60_000,
    };
  }

  /** Staff can't tell someone else's report from a missing one. */
  private visible(
    report: ReportView | null,
    id: string,
    actor: Actor,
  ): ReportView {
    if (!report || (!seesAll(actor) && report.createdBy !== actor.user.id)) {
      throw new NotFoundException(`Report ${id} not found.`);
    }
    return report;
  }

  /** 404 when hidden or missing; 403 for someone else's report or past the window. */
  private assertCanChange(
    report: ReportView | null,
    id: string,
    actor: Actor,
    verb: 'edit' | 'delete',
  ): ReportView {
    const found = this.visible(report, id, actor);
    if (isOwner(actor)) return found;
    if (found.createdBy !== actor.user.id)
      throw new ForbiddenException(`You can only ${verb} your own reports.`);
    if (Date.now() - new Date(found.submittedAt).getTime() > EDIT_WINDOW_MS) {
      throw new ForbiddenException(this.windowMessage());
    }
    return found;
  }

  private windowMessage(): string {
    return `This report can no longer be changed: reports can be edited or deleted for ${EDIT_WINDOW_MS / 60_000} minutes after submitting.`;
  }
}
