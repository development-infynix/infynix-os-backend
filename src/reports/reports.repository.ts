import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { TenantTx } from '../db/tenant-db.js';
import { isUniqueViolation as _isUniqueViolation } from '../db/errors.js';
import { reportSettings, reports, users } from '../db/schema.js';

export interface Report {
  id: string;
  tenantId: string;
  reportDate: string;
  reportItems: string[];
  createdBy: string | null;
  submittedAt: Date;
  updatedAt: Date;
  editedAt: Date | null;
  attachmentType: string | null;
  attachmentUrl: string | null;
  remarks: string | null;
}

export interface ReportSettings {
  tenantId: string;
  dueTime: string | null;
  skipDays: number[];
  updatedBy: string | null;
  updatedAt: Date;
}

export interface CreateReportData {
  tenantId: string;
  reportDate: string;
  reportItems: string[];
  createdBy: string;
  attachmentType: string | null;
  attachmentUrl: string | null;
}

export interface UpdateReportData {
  reportDate: string;
  reportItems: string[];
  attachmentType: string | null;
  attachmentUrl: string | null;
}

const reportColumns = {
  id: reports.id,
  tenantId: reports.tenantId,
  reportDate: reports.reportDate,
  reportItems: reports.reportItems,
  createdBy: reports.createdBy,
  submittedAt: reports.submittedAt,
  updatedAt: reports.updatedAt,
  editedAt: reports.editedAt,
  attachmentType: reports.attachmentType,
  attachmentUrl: reports.attachmentUrl,
  remarks: reports.remarks,
};

@Injectable()
export class ReportsRepository {
  async page(
    tx: TenantTx,
    page: number,
    pageSize: number,
    reportDate?: string,
    createdById?: string,
  ): Promise<{ items: (Report & { createdByUsername: string | null })[]; total: number }> {
    const conditions: SQL[] = [];
    if (reportDate) conditions.push(eq(reports.reportDate, reportDate));
    if (createdById) conditions.push(eq(reports.createdBy, createdById));
    const where = conditions.length ? and(...conditions) : undefined;
    const rows = await tx
      .select({ ...reportColumns, total: sql<number>`count(*) over ()`.mapWith(Number), createdByUsername: users.fullName })
      .from(reports)
      .leftJoin(users, eq(users.id, reports.createdBy))
      .where(where)
      .orderBy(desc(reports.submittedAt), desc(reports.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    if (rows.length) {
      const total = rows[0].total;
      return { items: rows.map(({ total: _t, ...r }) => r as Report & { createdByUsername: string | null }), total };
    }
    if (page === 1) return { items: [], total: 0 };
    const [{ total }] = await tx.select({ total: count() }).from(reports).where(where);
    return { items: [], total };
  }

  async find(tx: TenantTx, id: string): Promise<(Report & { createdByUsername: string | null }) | null> {
    const [row] = await tx
      .select({ ...reportColumns, createdByUsername: users.fullName })
      .from(reports)
      .leftJoin(users, eq(users.id, reports.createdBy))
      .where(eq(reports.id, id));
    return (row as (Report & { createdByUsername: string | null })) ?? null;
  }

  async create(tx: TenantTx, data: CreateReportData): Promise<Report> {
    const [row] = await tx
      .insert(reports)
      .values({
        tenantId: data.tenantId,
        reportDate: data.reportDate,
        reportItems: data.reportItems,
        createdBy: data.createdBy,
        attachmentType: data.attachmentType,
        attachmentUrl: data.attachmentUrl,
      })
      .returning(reportColumns);
    return row as Report;
  }

  async update(tx: TenantTx, id: string, patch: UpdateReportData): Promise<Report | null> {
    const [row] = await tx
      .update(reports)
      .set({
        reportDate: patch.reportDate,
        reportItems: patch.reportItems,
        attachmentType: patch.attachmentType,
        attachmentUrl: patch.attachmentUrl,
        updatedAt: new Date(),
      })
      .where(eq(reports.id, id))
      .returning(reportColumns);
    return (row as Report) ?? null;
  }

  async setEditedAt(tx: TenantTx, id: string, editedAt: Date | null): Promise<void> {
    await tx.update(reports).set({ editedAt }).where(eq(reports.id, id));
  }

  async updateRemarks(tx: TenantTx, id: string, remarks: string | null): Promise<Report | null> {
    const [row] = await tx
      .update(reports)
      .set({ remarks, updatedAt: new Date() })
      .where(eq(reports.id, id))
      .returning(reportColumns);
    return (row as Report) ?? null;
  }

  async remove(tx: TenantTx, id: string): Promise<void> {
    await tx.delete(reports).where(eq(reports.id, id));
  }

  async findExistingForDate(tx: TenantTx, userId: string, reportDate: string): Promise<{ id: string } | null> {
    const [row] = await tx
      .select({ id: reports.id })
      .from(reports)
      .where(and(eq(reports.createdBy, userId), eq(reports.reportDate, reportDate)));
    return row ?? null;
  }

  async getSettings(tx: TenantTx, tenantId: string): Promise<ReportSettings | null> {
    const [row] = await tx
      .select({
        tenantId: reportSettings.tenantId,
        dueTime: reportSettings.dueTime,
        skipDays: reportSettings.skipDays,
        updatedBy: reportSettings.updatedBy,
        updatedAt: reportSettings.updatedAt,
      })
      .from(reportSettings)
      .where(eq(reportSettings.tenantId, tenantId));
    return (row as ReportSettings) ?? null;
  }

  async upsertSettings(
    tx: TenantTx,
    tenantId: string,
    dueTime: string | null,
    skipDays: number[],
    updatedBy: string,
  ): Promise<ReportSettings> {
    const [row] = await tx
      .insert(reportSettings)
      .values({ tenantId, dueTime, skipDays, updatedBy, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: reportSettings.tenantId,
        set: { dueTime, skipDays, updatedBy, updatedAt: new Date() },
      })
      .returning({
        tenantId: reportSettings.tenantId,
        dueTime: reportSettings.dueTime,
        skipDays: reportSettings.skipDays,
        updatedBy: reportSettings.updatedBy,
        updatedAt: reportSettings.updatedAt,
      });
    return row as ReportSettings;
  }
}

export { _isUniqueViolation as isUniqueViolation };
