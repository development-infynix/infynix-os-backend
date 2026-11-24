/**
 * Calendar tasks (docs/calendar-plan.md, T1–T8) against the real database:
 * who may assign to whom, who sees what, the reviewed and self-assigned
 * workflows, holds, failed and more time (derived from the clock, no job),
 * cancel requests, deleting, and a deleted assignee's tasks going back to
 * their creator. Needs the `calendar_tasks` migration. Creates throwaway
 * companies and removes them afterwards.
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { CalendarRepository } from '../src/calendar/calendar.repository.js';
import { CalendarService, type PublicCalendarEvent } from '../src/calendar/calendar.service.js';
import { loadEnv } from '../src/db/load-env.js';
import { pgPoolConfig } from '../src/db/pg-config.js';
import { accessItems, tenants, userAccess, users } from '../src/db/schema.js';
import { TenantDb } from '../src/db/tenant-db.js';
import type { Actor } from '../src/tenancy/tenancy.types.js';

loadEnv();

const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
const steps = (event: PublicCalendarEvent) => event.permissions.actions.map((a) => a.action).sort();

describe('calendar tasks', { timeout: 90_000 }, () => {
  const pool = new Pool(pgPoolConfig());
  const db = drizzle({ client: pool });
  const service = new CalendarService(new TenantDb(db), new CalendarRepository());
  const tag = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  let owner: Actor;
  let manager: Actor;
  let manager2: Actor;
  let staff1: Actor;
  let staff2: Actor;
  let noCalendar: Actor;
  let outsider: Actor;

  async function person(tenantId: string, name: string, role: 'owner' | 'manager' | 'staff', grant = true) {
    const [row] = await db
      .insert(users)
      .values({ tenantId, role, fullName: name, email: `${name.replace(/ /g, '.')}-${tag}@example.test`, passwordHash: 'x' })
      .returning({ id: users.id });
    if (grant && role !== 'owner') {
      const [item] = await db.select({ id: accessItems.id }).from(accessItems).where(eq(accessItems.key, 'calendar'));
      await db.insert(userAccess).values({ tenantId, userId: row.id, accessItemId: item.id });
    }
    return { user: { id: row.id, role, tenantId, fullName: name }, tenant: { id: tenantId } } as unknown as Actor;
  }

  const task = (actor: Actor, assignee: Actor | null, extra: Record<string, unknown> = {}) =>
    service.create(actor, {
      type: 'task',
      title: 'Write the brief',
      deadline: inHours(48),
      ...(assignee ? { assigneeId: assignee.user.id } : {}),
      ...extra,
    });
  const step = (actor: Actor, event: PublicCalendarEvent, action: string, input: Record<string, unknown> = {}) =>
    service.update(actor, event.id, { version: event.version, action, ...input });
  /** Moves a task's deadline into the past, as if time had passed. */
  const expire = (id: string) =>
    db.execute(sql`update calendar_events
                      set starts_at = now() - interval '3 hours', ends_at = now() - interval '1 hour'
                    where id = ${id}::uuid`);

  beforeAll(async () => {
    const [a, b] = await db
      .insert(tenants)
      .values([{ name: `Tasks A ${tag}` }, { name: `Tasks B ${tag}` }])
      .returning({ id: tenants.id });
    tenantIds.push(a.id, b.id);
    owner = await person(a.id, 'Olive Owner', 'owner');
    manager = await person(a.id, 'Max Manager', 'manager');
    manager2 = await person(a.id, 'Mia Manager', 'manager');
    staff1 = await person(a.id, 'Sam Staff', 'staff');
    staff2 = await person(a.id, 'Tia Staff', 'staff');
    noCalendar = await person(a.id, 'Nora NoCalendar', 'staff', false);
    outsider = await person(b.id, 'Otto Outside', 'owner');
  });

  afterAll(async () => {
    if (tenantIds.length) await db.delete(tenants).where(inArray(tenants.id, tenantIds));
    await pool.end();
  });

  it('assigns only as T3/T4 allow, and the picker offers the same people', async () => {
    await expect(task(staff1, staff2)).rejects.toMatchObject({ status: 403 });
    const mine = await task(staff1, null);
    expect(mine).toMatchObject({ assigneeId: staff1.user.id, status: 'assigned', priority: 'medium' });
    await expect(task(manager, manager2)).rejects.toMatchObject({ status: 403 });
    await expect(task(manager, noCalendar)).rejects.toMatchObject({ status: 400 });
    await expect(task(manager, outsider)).rejects.toMatchObject({ status: 400 });
    expect((await task(owner, manager)).assigneeName).toBe('Max Manager');
    await expect(task(manager, staff1, { deadline: inHours(-1) })).rejects.toMatchObject({ status: 400 });
    await expect(task(manager, staff1, { location: 'Room 1' })).rejects.toMatchObject({ status: 400 });

    const names = async (actor: Actor) =>
      (await service.people(actor, '', 50, true)).items.map((p) => p.fullName).sort();
    expect(await names(staff1)).toEqual(['Sam Staff']);
    expect(await names(manager)).toEqual(['Max Manager', 'Sam Staff', 'Tia Staff']);
    expect(await names(owner)).toEqual(['Max Manager', 'Mia Manager', 'Olive Owner', 'Sam Staff', 'Tia Staff']);
  });

  it('shows a task to its creator, its assignee and the owner only', async () => {
    const t = await task(manager, staff1);
    for (const actor of [manager, staff1, owner]) expect((await service.findOne(actor, t.id)).id).toBe(t.id);
    for (const actor of [manager2, staff2, outsider]) {
      await expect(service.findOne(actor, t.id)).rejects.toMatchObject({ status: 404 });
    }
    // It sits on its deadline day only.
    const day = new Date(t.endsAt);
    const listed = await service.list(
      staff1,
      new Date(day.getTime() - 3_600_000).toISOString(),
      new Date(day.getTime() + 3_600_000).toISOString(),
    );
    expect(listed.items.map((e) => e.id)).toContain(t.id);
    const before = await service.list(staff1, new Date().toISOString(), new Date(day.getTime() - 3_600_000).toISOString());
    expect(before.items.map((e) => e.id)).not.toContain(t.id);
  });

  it('runs the reviewed workflow: start, submit, send back, approve; only the owner reopens', async () => {
    let t = await task(manager, staff1);
    expect(steps(await service.findOne(staff1, t.id))).toEqual(['hold', 'request_cancel', 'request_extension', 'start']);
    expect(steps(await service.findOne(manager, t.id))).toEqual(['cancel', 'hold']);
    await expect(step(manager, t, 'start')).rejects.toMatchObject({ status: 403 });

    t = await step(staff1, t, 'start');
    expect(t.effectiveStatus).toBe('progress');
    await expect(step(staff1, { ...t, version: t.version - 1 }, 'submit')).rejects.toMatchObject({ status: 409 });
    t = await step(staff1, t, 'submit');
    expect(t.effectiveStatus).toBe('on_review');
    expect((await service.findOne(manager, t.id)).permissions.canEdit).toBe(false);
    await expect(service.update(manager, t.id, { version: t.version, title: 'New' })).rejects.toMatchObject({ status: 403 });

    t = await step(manager, t, 'reject', { note: 'Needs numbers' });
    expect(t).toMatchObject({ effectiveStatus: 'assigned', rejectCount: 1 });
    t = await step(staff1, t, 'start');
    t = await step(staff1, t, 'submit');
    await expect(step(staff1, t, 'approve')).rejects.toMatchObject({ status: 403 });
    t = await step(manager, t, 'approve', { completionRemarks: 'Great' });
    expect(t).toMatchObject({ effectiveStatus: 'completed', completionRemarks: 'Great' });

    expect(steps(await service.findOne(manager, t.id))).toEqual([]);
    expect(steps(await service.findOne(owner, t.id))).toEqual(['reopen']);
    t = await step(owner, t, 'reopen');
    expect(t).toMatchObject({ effectiveStatus: 'assigned', completionRemarks: null });
  });

  it('lets a self-assigned task complete without review', async () => {
    let t = await task(staff1, null);
    expect(steps(t)).toEqual(['cancel', 'hold', 'start']);
    t = await step(staff1, t, 'start');
    expect(steps(t)).toEqual(['cancel', 'complete', 'hold']);
    t = await step(staff1, t, 'complete');
    expect(t.effectiveStatus).toBe('completed');
  });

  it('holds until a date on or before the deadline, and the hold ends by itself', async () => {
    let t = await task(manager, staff1, { deadline: inHours(10) });
    await expect(step(staff1, t, 'hold', { holdUntil: inHours(2) })).rejects.toMatchObject({ status: 400 });
    await expect(step(staff1, t, 'hold', { holdReason: 'Waiting', holdUntil: inHours(12) })).rejects.toMatchObject({
      status: 400,
    });
    t = await step(staff1, t, 'start');
    t = await step(staff1, t, 'hold', { holdReason: 'Waiting on client', holdUntil: inHours(2) });
    expect(t).toMatchObject({ effectiveStatus: 'on_hold', previousStatus: 'progress' });
    expect(steps(await service.findOne(manager, t.id))).toEqual(['cancel', 'resume']);

    // The hold's end passes: back to in progress, on read, with no job.
    await db.execute(sql`update calendar_events set hold_until = now() - interval '1 minute' where id = ${t.id}::uuid`);
    t = await service.findOne(staff1, t.id);
    expect(t).toMatchObject({ status: 'on_hold', effectiveStatus: 'progress' });
    // The next change stores it.
    t = await step(staff1, t, 'submit');
    expect(t).toMatchObject({ status: 'on_review', holdUntil: null, holdReason: null });
  });

  it('fails a task past its deadline; more time and extend bring it back', async () => {
    let t = await task(manager, staff1);
    await expire(t.id);
    t = await service.findOne(staff1, t.id);
    expect(t).toMatchObject({ status: 'assigned', effectiveStatus: 'failed' });
    expect(steps(t)).toEqual(['request_extension']);
    expect(steps(await service.findOne(manager, t.id))).toEqual(['cancel', 'extend']);

    await expect(step(staff1, t, 'request_extension', { extensionUntil: inHours(24) })).rejects.toMatchObject({
      status: 400,
    });
    t = await step(staff1, t, 'request_extension', { extensionUntil: inHours(24), extensionReason: 'Client late' });
    expect(t).toMatchObject({ status: 'failed', effectiveStatus: 'failed' });
    const asManager = await service.findOne(manager, t.id);
    expect(steps(asManager)).toEqual(['approve_extension', 'cancel', 'decline_extension']);
    t = await step(manager, asManager, 'approve_extension');
    expect(t).toMatchObject({ effectiveStatus: 'assigned', extensionUntil: null });
    expect(Date.parse(t.endsAt)).toBeGreaterThan(Date.now() + 23 * 3_600_000);

    await expire(t.id);
    t = await service.findOne(manager, t.id);
    await expect(step(manager, t, 'extend', {})).rejects.toMatchObject({ status: 400 });
    t = await step(manager, t, 'extend', { deadline: inHours(5) });
    expect(t).toMatchObject({ status: 'assigned', effectiveStatus: 'assigned' });
  });

  it('handles cancel requests, and deletes only while assigned or cancelled', async () => {
    let t = await task(manager, staff1);
    await expect(step(staff1, t, 'request_cancel')).rejects.toMatchObject({ status: 400 });
    t = await step(staff1, t, 'start');
    t = await step(staff1, t, 'request_cancel', { cancelReason: 'Out of scope' });
    expect(t).toMatchObject({ effectiveStatus: 'request_cancelation', previousStatus: 'progress' });
    t = await step(manager, await service.findOne(manager, t.id), 'decline_cancel');
    expect(t).toMatchObject({ effectiveStatus: 'progress', cancelReason: null });

    await expect(service.remove(manager, t.id)).rejects.toMatchObject({ status: 403 });
    await expect(service.remove(staff1, t.id)).rejects.toMatchObject({ status: 403 });

    t = await step(staff1, t, 'request_cancel', { cancelReason: 'Really out of scope' });
    t = await step(staff1, t, 'withdraw_cancel');
    t = await step(staff1, t, 'request_cancel', { cancelReason: 'Out of scope' });
    t = await step(manager, await service.findOne(manager, t.id), 'approve_cancel');
    expect(t).toMatchObject({ effectiveStatus: 'cancelled', cancelReason: 'Out of scope' });
    await service.remove(manager, t.id);
    await expect(service.findOne(manager, t.id)).rejects.toMatchObject({ status: 404 });

    // The owner may delete at any stage.
    let busy = await task(manager, staff1);
    busy = await step(staff1, busy, 'start');
    await service.remove(owner, busy.id);
  });

  it('reassigning starts over; edits follow T7', async () => {
    let t = await task(manager, staff1, { priority: 'high' });
    t = await step(staff1, t, 'start');
    await expect(service.update(staff1, t.id, { version: t.version, title: 'Mine now' })).rejects.toMatchObject({
      status: 403,
    });
    await expect(service.update(manager, t.id, { version: t.version, assigneeId: manager2.user.id })).rejects.toMatchObject(
      { status: 403 },
    );
    t = await service.update(manager, t.id, { version: t.version, assigneeId: staff2.user.id, priority: 'urgent' });
    expect(t).toMatchObject({ assigneeName: 'Tia Staff', effectiveStatus: 'assigned', rejectCount: 0, priority: 'urgent' });
    await expect(service.findOne(staff1, t.id)).rejects.toMatchObject({ status: 404 });

    await expire(t.id);
    t = await service.findOne(manager, t.id);
    expect(t.effectiveStatus).toBe('failed');
    t = await service.update(manager, t.id, { version: t.version, deadline: inHours(6) });
    expect(t).toMatchObject({ status: 'assigned', effectiveStatus: 'assigned' });
  });

  it('hands a deleted assignee’s open tasks back to their creator (T6)', async () => {
    const leaver = await person(tenantIds[0], 'Lee Leaving', 'staff');
    let open = await task(manager, leaver);
    open = await step(leaver, open, 'start');
    let done = await task(manager, leaver);
    done = await step(leaver, done, 'start');
    done = await step(leaver, done, 'submit');
    done = await step(manager, done, 'approve');

    await db.delete(users).where(eq(users.id, leaver.user.id));

    const back = await service.findOne(manager, open.id);
    expect(back).toMatchObject({ assigneeId: manager.user.id, effectiveStatus: 'assigned', rejectCount: 0 });
    const kept = await service.findOne(manager, done.id);
    expect(kept).toMatchObject({ assigneeId: null, assigneeName: null, effectiveStatus: 'completed' });
    const log = await db.execute<{ action: string }>(
      sql`select action from calendar_event_log where event_id = ${open.id}::uuid order by created_at desc limit 1`,
    );
    expect(log.rows[0].action).toBe('reassigned');
  });

  it('keeps meetings and announcements free of task fields and steps', async () => {
    const meeting = await service.create(owner, {
      type: 'meeting',
      title: 'Sync',
      startsAt: inHours(3),
      durationMinutes: 30,
      location: 'Room 1',
      visibility: 'open',
    });
    expect(meeting.permissions.actions).toEqual([]);
    await expect(
      service.update(owner, meeting.id, { version: meeting.version, action: 'start' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.update(owner, meeting.id, { version: meeting.version, priority: 'high' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.create(owner, { type: 'meeting', title: 'x', startsAt: inHours(3), durationMinutes: 30, location: 'R', visibility: 'open', deadline: inHours(4) }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
