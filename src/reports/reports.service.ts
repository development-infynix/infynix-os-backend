import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { isUniqueViolation } from '../db/errors.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Actor } from '../tenancy/tenancy.types.js';
import { AccessService } from '../access/access.service.js';
import { users } from '../db/schema.js';
import {
  type Report,
  ReportsRepository,
} from './reports.repository.js';
import { CreateReportDto } from './dto/create-report.dto.js';
import { UpdateReportDto } from './dto/update-report.dto.js';
import { UpdateReportSettingsDto } from './dto/update-report-settings.dto.js';

const EDIT_WINDOW_MS = 15 * 60 * 1000;

function isElevated(role: string | undefined): boolean {
  return role === 'owner';
}

function normalizeReportItems(items: unknown): string[] {
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) {
    throw new BadRequestException('Add between 1 and 100 report points.');
  }
  return items.map((item) => {
    if (typeof item !== 'string') throw new BadRequestException('Report points must be text.');
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > 5000) {
      throw new BadRequestException('Each report point must be between 1 and 5000 characters.');
    }
    return trimmed;
  });
}

function normalizeUrl(value?: string): string {
  if (!value?.trim()) throw new BadRequestException('Enter a URL.');
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new BadRequestException('Enter a valid attachment URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BadRequestException('Attachment URLs must use HTTP or HTTPS.');
  }
  return url.toString();
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly reports: ReportsRepository,
    private readonly access: AccessService,
  ) {}

  private async assertCanUseReports(actor: Actor): Promise<void> {
    const user = actor.user;
    if (!user.id || !['staff', 'manager', 'owner'].includes(user.role ?? '')) {
      throw new ForbiddenException('You do not have permission to use Reports.');
    }
    if (isElevated(user.role)) return;
    const keys = await this.access.keysFor(user);
    if (!keys.includes('reports')) {
      throw new ForbiddenException('You do not have access to the Reports menu.');
    }
  }

  async health(actor: Actor) {
    return this.tenantDb.run(actor.tenant.id, async () => ({ ok: true }));
  }

  async list(actor: Actor, page = 1, pageSize = 100, reportDate?: string, createdById?: string) {
    await this.assertCanUseReports(actor);
    const elevated = isElevated(actor.user.role);
    const effectiveCreatedById = elevated ? createdById : actor.user.id;
    const { items, total } = await this.tenantDb.run(actor.tenant.id, (tx) =>
      this.reports.page(tx, page, pageSize, reportDate, effectiveCreatedById),
    );
    return {
      items: await Promise.all(items.map((row) => this.toResponse(row))),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize) || 1,
      date: reportDate ?? null,
      userId: (elevated ? createdById : actor.user.id) ?? null,
    };
  }

  async findOne(id: string, actor: Actor) {
    await this.assertCanUseReports(actor);
    const row = await this.tenantDb.run(actor.tenant.id, (tx) => this.reports.find(tx, id));
    if (!row) throw new NotFoundException(`Report ${id} not found.`);
    const elevated = isElevated(actor.user.role);
    if (!elevated && row.createdBy !== actor.user.id) {
      throw new NotFoundException(`Report ${id} not found.`);
    }
    return this.toResponse(row);
  }

  async create(dto: CreateReportDto, actor: Actor) {
    await this.assertCanUseReports(actor);
    const reportItems = normalizeReportItems(dto.reports);
    const reportDate = dto.reportDate;
    let attachmentType: string | null = null;
    let attachmentUrl: string | null = null;
    if (dto.attachmentMode === 'url') {
      attachmentType = 'url';
      attachmentUrl = normalizeUrl(dto.attachmentUrl);
    } else if (dto.attachmentMode === 'none') {
      if (dto.attachmentUrl) throw new BadRequestException('Remove the unused attachment before submitting.');
    }

    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      // off-day check
      const settings = await this.reports.getSettings(tx, actor.tenant.id);
      const weekday = new Date(reportDate + 'T00:00:00Z').getUTCDay();
      if (settings?.skipDays?.includes(weekday)) {
        const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        throw new BadRequestException(`${names[weekday]} is an off day. Reports can't be dated on it.`);
      }
      const existing = await this.reports.findExistingForDate(tx, actor.user.id, reportDate);
      if (existing) throw new ConflictException('You already submitted a report for this date.');
      let created: Report;
      try {
        created = await this.reports.create(tx, {
          tenantId: actor.tenant.id,
          reportDate,
          reportItems,
          createdBy: actor.user.id,
          attachmentType,
          attachmentUrl,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictException('You already submitted a report for this date.');
        }
        throw error;
      }
      const [creator] = await tx.select({ username: users.fullName }).from(users).where(eq(users.id, actor.user.id)).limit(1);
      return this.toResponse({ ...created, createdByUsername: creator?.username ?? null });
    });
  }

  async update(id: string, dto: UpdateReportDto, actor: Actor) {
    await this.assertCanUseReports(actor);
    const reportItems = normalizeReportItems(dto.reports);
    const elevated = isElevated(actor.user.role);

    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      const existing = await this.reports.find(tx, id);
      if (!existing) throw new NotFoundException(`Report ${id} not found.`);
      if (!elevated) {
        if (existing.createdBy !== actor.user.id) throw new ForbiddenException('You can only edit your own reports.');
        if (Date.now() - new Date(existing.submittedAt).getTime() > EDIT_WINDOW_MS) {
          throw new ForbiddenException('This report can no longer be edited or deleted: it is past the 15-minute window after submission.');
        }
      }
      if (dto.reportDate !== existing.reportDate) {
        const settings = await this.reports.getSettings(tx, actor.tenant.id);
        const weekday = new Date(dto.reportDate + 'T00:00:00Z').getUTCDay();
        if (settings?.skipDays?.includes(weekday)) {
          const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
          throw new BadRequestException(`${names[weekday]} is an off day. Reports can't be dated on it.`);
        }
        const dup = await this.reports.findExistingForDate(tx, existing.createdBy!, dto.reportDate);
        if (dup && dup.id !== id) throw new ConflictException('You already submitted a report for this date.');
      }

      let attachmentType: string | null = existing.attachmentType;
      let attachmentUrl: string | null = existing.attachmentUrl;
      if (dto.attachmentMode === 'none') {
        attachmentType = null;
        attachmentUrl = null;
        if (dto.attachmentUrl) throw new BadRequestException('Remove the unused attachment before submitting.');
      } else if (dto.attachmentMode === 'url') {
        attachmentType = 'url';
        attachmentUrl = normalizeUrl(dto.attachmentUrl);
      } else if (dto.attachmentMode === 'keep') {
        if (dto.attachmentUrl) throw new BadRequestException('Remove the unused attachment before keeping the current one.');
      }

      const contentChanged =
        dto.reportDate !== existing.reportDate ||
        JSON.stringify(reportItems) !== JSON.stringify(existing.reportItems) ||
        attachmentType !== existing.attachmentType ||
        attachmentUrl !== existing.attachmentUrl;

      const updated = await this.reports.update(tx, id, {
        reportDate: dto.reportDate,
        reportItems,
        attachmentType,
        attachmentUrl,
      });
      if (!updated) throw new NotFoundException(`Report ${id} not found.`);
      if (contentChanged) {
        await this.reports.setEditedAt(tx, id, new Date());
        updated.editedAt = new Date();
      } else {
        updated.editedAt = existing.editedAt;
      }
      const [creator] = updated.createdBy
        ? await tx.select({ username: users.fullName }).from(users).where(eq(users.id, updated.createdBy)).limit(1)
        : [];
      return this.toResponse({ ...updated, createdByUsername: creator?.username ?? null });
    });
  }

  async updateRemarks(id: string, remarks: string | null | undefined, actor: Actor) {
    await this.assertCanUseReports(actor);
    if (!isElevated(actor.user.role)) throw new ForbiddenException('Only owner can add remarks.');
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      const existing = await this.reports.find(tx, id);
      if (!existing) throw new NotFoundException(`Report ${id} not found.`);
      const next = remarks?.trim() || null;
      const updated = await this.reports.updateRemarks(tx, id, next);
      if (!updated) throw new NotFoundException(`Report ${id} not found.`);
      const [creator] = updated.createdBy
        ? await tx.select({ username: users.fullName }).from(users).where(eq(users.id, updated.createdBy)).limit(1)
        : [];
      return this.toResponse({ ...updated, createdByUsername: creator?.username ?? null });
    });
  }

  async getSettings(actor: Actor) {
    await this.assertCanUseReports(actor);
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      const row = await this.reports.getSettings(tx, actor.tenant.id);
      return {
        dueTime: row?.dueTime ? String(row.dueTime).slice(0, 5) : null,
        skipDays: row?.skipDays ?? [],
        timezone: 'UTC',
        updatedAt: row?.updatedAt ?? null,
      };
    });
  }

  async updateSettings(dto: UpdateReportSettingsDto, actor: Actor) {
    await this.assertCanUseReports(actor);
    if (!isElevated(actor.user.role)) throw new ForbiddenException('Only owner can change Reports settings.');
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      const row = await this.reports.upsertSettings(tx, actor.tenant.id, dto.dueTime, dto.skipDays, actor.user.id);
      return {
        dueTime: row.dueTime ? String(row.dueTime).slice(0, 5) : null,
        skipDays: row.skipDays,
        timezone: 'UTC',
        updatedAt: row.updatedAt,
      };
    });
  }

  async remove(id: string, actor: Actor) {
    await this.assertCanUseReports(actor);
    const elevated = isElevated(actor.user.role);
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      const existing = await this.reports.find(tx, id);
      if (!existing) throw new NotFoundException(`Report ${id} not found.`);
      if (!elevated) {
        if (existing.createdBy !== actor.user.id) throw new ForbiddenException('You can only delete your own reports.');
        if (Date.now() - new Date(existing.submittedAt).getTime() > EDIT_WINDOW_MS) {
          throw new ForbiddenException('This report can no longer be edited or deleted: it is past the 15-minute window after submission.');
        }
      }
      await this.reports.remove(tx, id);
      return { id };
    });
  }

  private async toResponse(row: Report & { createdByUsername: string | null }) {
    return {
      id: row.id,
      reportDate: row.reportDate,
      reports: row.reportItems,
      createdBy: row.createdBy,
      createdByUsername: row.createdByUsername,
      submittedAt: row.submittedAt,
      updatedAt: row.updatedAt,
      editedAt: row.editedAt,
      attachment: row.attachmentType === 'url' && row.attachmentUrl
        ? { type: 'url', url: row.attachmentUrl }
        : null,
      remarks: row.remarks,
    };
  }
}
