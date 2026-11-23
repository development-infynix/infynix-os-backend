/**
 * Reports' raw SQL against the real database (docs/reports-module.md): page +
 * total, who sees what, the company's "today", late, off days, the edit window,
 * and that deleting a person keeps their reports. Needs the `reports`
 * migration applied. Creates throwaway companies and removes them afterwards.
 */
import { randomUUID } from 'node:crypto';
import { inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { loadEnv } from '../src/db/load-env.js';
import { pgPoolConfig } from '../src/db/pg-config.js';
import { reports, tenants, users } from '../src/db/schema.js';
import { TenantDb } from '../src/db/tenant-db.js';
import { ReportsRepository } from '../src/reports/reports.repository.js';
import { ReportsService } from '../src/reports/reports.service.js';
import { InMemoryDisk } from '@nestjs/storage';
import type { Actor } from '../src/tenancy/tenancy.types.js';

loadEnv();

const shift = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

const disk = new InMemoryDisk({
  signedUrls: { baseUrl: 'http://files.test/files', keys: ['k'.repeat(32)] },
});

// Neon round trips: well past vitest's 5s default.
describe('reports queries', { timeout: 60_000 }, () => {
  const pool = new Pool(pgPoolConfig());
  const db = drizzle({ client: pool });
  const service = new ReportsService(
    new TenantDb(db),
    new ReportsRepository(),
    disk,
  );
  const tag = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  let owner: Actor;
  let manager: Actor;
  let staff: Actor;
  let staff2: Actor;
  let outsider: Actor;
  let today: string;

  async function person(
    tenantId: string,
    name: string,
    role: 'owner' | 'manager' | 'staff',
  ): Promise<Actor> {
    const [row] = await db
      .insert(users)
      .values({
        tenantId,
        role,
        fullName: name,
        email: `${name.replace(' ', '.')}-${tag}@example.test`,
        passwordHash: 'x',
      })
      .returning({ id: users.id });
    return {
      user: { id: row.id, role, tenantId, fullName: name },
      tenant: { id: tenantId },
    } as unknown as Actor;
  }

  beforeAll(async () => {
    const [a, b] = await db
      .insert(tenants)
      .values([{ name: `Reports A ${tag}` }, { name: `Reports B ${tag}` }])
      .returning({ id: tenants.id });
    tenantIds.push(a.id, b.id);
    owner = await person(a.id, 'Olive Owner', 'owner');
    manager = await person(a.id, 'Max Manager', 'manager');
    staff = await person(a.id, 'Sam Staff', 'staff');
    staff2 = await person(a.id, 'Tia Staff', 'staff');
    outsider = await person(b.id, 'Otto Outside', 'owner');
    today = (await service.getSettings(staff)).today;
  });

  beforeEach(async () => {
    await db.delete(reports).where(inArray(reports.tenantId, tenantIds));
    await service.updateSettings(
      { timezone: 'Asia/Kolkata', dueTime: null, skipDays: [] },
      owner,
    );
  });

  afterAll(async () => {
    if (tenantIds.length)
      await db.delete(tenants).where(inArray(tenants.id, tenantIds)); // cascades
    await pool.end();
  });

  const file = (actor: Actor, reportDate: string, points = ['did a thing']) =>
    service.create(
      { reportDate, reports: points, attachmentMode: 'none' },
      actor,
    );

  it("reads today in the company's timezone and defaults settings", async () => {
    const tz = (
      await pool.query<{ d: string }>(
        `select (now() at time zone 'Asia/Kolkata')::date::text as d`,
      )
    ).rows[0].d;
    const settings = await service.getSettings(outsider); // company B never saved settings
    expect(settings).toMatchObject({
      timezone: 'Asia/Kolkata',
      dueTime: null,
      skipDays: [],
      today: tz,
    });
  });

  it('files once per day, trims points, and refuses future dates', async () => {
    const report = await service.create(
      {
        reportDate: today,
        reports: ['  a  ', 'b'],
        attachmentMode: 'url',
        attachmentUrl: 'https://example.com/x',
      },
      staff,
    );
    expect(report).toMatchObject({
      reports: ['a', 'b'],
      createdByName: 'Sam Staff',
      editedAt: null,
      late: false,
    });
    expect(report.attachment).toEqual({
      type: 'url',
      url: 'https://example.com/x',
    });
    expect((await service.getSettings(staff)).submittedToday).toBe(true);
    await expect(file(staff, today)).rejects.toMatchObject({ status: 409 });
    await expect(file(staff, shift(today, 1))).rejects.toMatchObject({
      status: 400,
    });
  });

  it('lets owners and managers see everyone, staff only themselves, other companies nothing', async () => {
    await file(staff, today);
    await file(manager, today);
    await file(staff2, shift(today, -1));

    expect((await service.list(manager, { page: 1, pageSize: 50 })).total).toBe(
      3,
    );
    const own = await service.list(staff, {
      page: 1,
      pageSize: 50,
      userId: manager.user.id,
    }); // userId ignored
    expect(own.items.map((r) => r.createdByName)).toEqual(['Sam Staff']);
    const filtered = await service.list(owner, {
      page: 1,
      pageSize: 50,
      userId: staff2.user.id,
    });
    expect(filtered.items.map((r) => r.createdByName)).toEqual(['Tia Staff']);
    expect(
      (await service.list(owner, { page: 1, pageSize: 50, date: today })).total,
    ).toBe(2);
    expect(
      (await service.list(outsider, { page: 1, pageSize: 50 })).total,
    ).toBe(0);

    const page = await service.list(owner, { page: 2, pageSize: 2 });
    expect([page.items.length, page.total, page.totalPages]).toEqual([1, 3, 2]);
    const past = await service.list(owner, { page: 5, pageSize: 2 });
    expect([past.items.length, past.total]).toEqual([0, 3]);
  });

  it('marks reports filed after the due time as late, and blocks off days', async () => {
    const report = await file(staff, today);
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
    await service.updateSettings(
      { timezone: 'Asia/Kolkata', dueTime: '00:00', skipDays: [weekday] },
      owner,
    );

    expect((await service.findOne(report.id, owner)).late).toBe(true);
    expect((await service.getSettings(staff2)).todayIsOffDay).toBe(true);
    await expect(file(staff2, today)).rejects.toMatchObject({ status: 400 });
  });

  it('stamps edited_at only when content changes, in the same statement', async () => {
    const report = await file(staff, today, ['a']);
    const same = await service.update(
      report.id,
      { reportDate: today, reports: ['a'], attachmentMode: 'keep' },
      staff,
    );
    expect(same.editedAt).toBeNull();
    const changed = await service.update(
      report.id,
      {
        reportDate: shift(today, -1),
        reports: ['a', 'b'],
        attachmentMode: 'none',
      },
      staff,
    );
    expect(changed).toMatchObject({
      reportDate: shift(today, -1),
      reports: ['a', 'b'],
      createdByName: 'Sam Staff',
    });
    expect(changed.editedAt).not.toBeNull();
    await expect(
      service.update(
        report.id,
        { reportDate: today, reports: ['x'], attachmentMode: 'none' },
        manager,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('enforces the edit window inside the delete', async () => {
    const report = await file(staff, today);
    await db.execute(
      sql`update reports set submitted_at = now() - interval '20 minutes' where id = ${report.id}`,
    );
    await expect(service.remove(report.id, staff)).rejects.toMatchObject({
      status: 403,
    });
    await expect(service.remove(report.id, staff2)).rejects.toMatchObject({
      status: 404,
    });
    await service.remove(report.id, owner);
    await expect(service.findOne(report.id, owner)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('attaches only your own uploaded files, and removes them with the report', async () => {
    const own = `tenants/${staff.tenant.id}/reports/${staff.user.id}/${tag}.pdf`;
    await disk.put(own, Buffer.from('%PDF-1.7 test'), {
      contentType: 'application/pdf',
    });

    const report = await service.create(
      {
        reportDate: today,
        reports: ['with a file'],
        attachmentMode: 'file',
        fileKey: own,
        fileName: 'C:\\fakepath\\Weekly plan.pdf',
      },
      staff,
    );
    expect(report.attachment).toMatchObject({
      type: 'file',
      name: 'Weekly plan.pdf',
      size: 13,
      contentType: 'application/pdf',
    });
    expect(report.attachment && 'key' in report.attachment).toBe(false); // the key never leaves the server
    expect(report.attachment?.url).toContain('http://files.test/files');

    // Someone else's key, or a missing upload, is refused.
    const theirs = `tenants/${staff.tenant.id}/reports/${staff2.user.id}/${tag}.pdf`;
    await disk.put(theirs, Buffer.from('%PDF-1.7'), {
      contentType: 'application/pdf',
    });
    await expect(
      service.create(
        {
          reportDate: shift(today, -1),
          reports: ['x'],
          attachmentMode: 'file',
          fileKey: theirs,
        },
        staff,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.create(
        {
          reportDate: shift(today, -1),
          reports: ['x'],
          attachmentMode: 'file',
          fileKey: `${own}.missing`,
        },
        staff,
      ),
    ).rejects.toMatchObject({ status: 400 });

    // Keeping it leaves the file; switching to a link deletes it from storage.
    await service.update(
      report.id,
      { reportDate: today, reports: ['with a file'], attachmentMode: 'keep' },
      staff,
    );
    expect(await disk.exists(own)).toBe(true);
    await service.update(
      report.id,
      {
        reportDate: today,
        reports: ['with a link'],
        attachmentMode: 'url',
        attachmentUrl: 'https://example.com',
      },
      staff,
    );
    await vi.waitFor(async () => expect(await disk.exists(own)).toBe(false));

    // Deleting a report deletes its file too.
    const again = `tenants/${staff.tenant.id}/reports/${staff.user.id}/${tag}-2.pdf`;
    await disk.put(again, Buffer.from('%PDF-1.7'), {
      contentType: 'application/pdf',
    });
    const second = await service.create(
      {
        reportDate: shift(today, -1),
        reports: ['x'],
        attachmentMode: 'file',
        fileKey: again,
        fileName: 'a.pdf',
      },
      staff,
    );
    await service.remove(second.id, owner);
    await vi.waitFor(async () => expect(await disk.exists(again)).toBe(false));
    await disk.delete(theirs);
  });

  it('keeps reports when their author is deleted', async () => {
    const leaver = await person(tenantIds[0], `Lee Leaver`, 'staff');
    const report = await file(leaver, today);
    await db.delete(users).where(inArray(users.id, [leaver.user.id]));
    expect(await service.findOne(report.id, owner)).toMatchObject({
      createdBy: null,
      createdByName: null,
    });
  });
});
