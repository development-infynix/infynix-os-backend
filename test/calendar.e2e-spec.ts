/**
 * Calendar (docs/calendar-plan.md) against the real database: company
 * isolation, who may post and manage announcements (C1, C2), meeting
 * visibility and management including the uninvited owner (C3), version
 * conflicts, invite rules, and deleted members (C4). Needs the `calendar`
 * migration. Creates throwaway companies and removes them afterwards.
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { CalendarRepository } from '../src/calendar/calendar.repository.js';
import { CalendarService } from '../src/calendar/calendar.service.js';
import { loadEnv } from '../src/db/load-env.js';
import { pgPoolConfig } from '../src/db/pg-config.js';
import { accessItems, tenants, userAccess, users } from '../src/db/schema.js';
import { TenantDb } from '../src/db/tenant-db.js';
import type { Actor } from '../src/tenancy/tenancy.types.js';

loadEnv();

const inHours = (hours: number) =>
  new Date(Date.now() + hours * 3_600_000).toISOString();

// Neon round trips: well past vitest's 5s default.
describe('calendar', { timeout: 60_000 }, () => {
  const pool = new Pool(pgPoolConfig());
  const db = drizzle({ client: pool });
  const service = new CalendarService(
    new TenantDb(db),
    new CalendarRepository(),
  );
  const tag = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  let owner: Actor;
  let manager: Actor;
  let manager2: Actor;
  let staff1: Actor;
  let staff2: Actor;
  let staff3: Actor;
  let noCalendar: Actor;
  let outsider: Actor;

  async function person(
    tenantId: string,
    name: string,
    role: 'owner' | 'manager' | 'staff',
    grant = true,
  ) {
    const [row] = await db
      .insert(users)
      .values({
        tenantId,
        role,
        fullName: name,
        email: `${name.replace(/ /g, '.')}-${tag}@example.test`,
        passwordHash: 'x',
      })
      .returning({ id: users.id });
    if (grant && role !== 'owner') {
      const [item] = await db
        .select({ id: accessItems.id })
        .from(accessItems)
        .where(eq(accessItems.key, 'calendar'));
      await db
        .insert(userAccess)
        .values({ tenantId, userId: row.id, accessItemId: item.id });
    }
    return {
      user: { id: row.id, role, tenantId, fullName: name },
      tenant: { id: tenantId },
    } as unknown as Actor;
  }

  const range = () =>
    [
      new Date(Date.now() - 5 * 86_400_000).toISOString(),
      new Date(Date.now() + 20 * 86_400_000).toISOString(),
    ] as const;
  const visibleIds = async (actor: Actor) =>
    (await service.list(actor, ...range())).items.map((e) => e.id);

  beforeAll(async () => {
    const [a, b] = await db
      .insert(tenants)
      .values([{ name: `Calendar A ${tag}` }, { name: `Calendar B ${tag}` }])
      .returning({ id: tenants.id });
    tenantIds.push(a.id, b.id);
    owner = await person(a.id, 'Olive Owner', 'owner');
    manager = await person(a.id, 'Max Manager', 'manager');
    manager2 = await person(a.id, 'Mia Manager', 'manager');
    staff1 = await person(a.id, 'Sam Staff', 'staff');
    staff2 = await person(a.id, 'Tia Staff', 'staff');
    staff3 = await person(a.id, 'Uma Staff', 'staff');
    noCalendar = await person(a.id, 'Nora NoCalendar', 'staff', false);
    outsider = await person(b.id, 'Otto Outside', 'owner');
  });

  afterAll(async () => {
    if (tenantIds.length)
      await db.delete(tenants).where(inArray(tenants.id, tenantIds)); // cascades
    await pool.end();
  });

  it('lets owners and managers post announcements, and their creator or the owner manage them', async () => {
    await expect(
      service.create(staff1, {
        type: 'announcement',
        title: 'x',
        description: 'y',
        startsAt: inHours(1),
        durationMinutes: 60,
      }),
    ).rejects.toMatchObject({ status: 403 });
    const post = await service.create(manager, {
      type: 'announcement',
      title: ' Office closed ',
      description: 'Diwali break',
      startsAt: inHours(24),
      durationMinutes: 3 * 24 * 60,
    });
    expect(post).toMatchObject({
      title: 'Office closed',
      effectiveStatus: 'upcoming',
      createdByName: 'Max Manager',
    });

    expect((await service.findOne(staff1, post.id)).permissions.canEdit).toBe(
      false,
    );
    expect((await service.findOne(manager2, post.id)).permissions.canEdit).toBe(
      false,
    );
    expect((await service.findOne(owner, post.id)).permissions.canEdit).toBe(
      true,
    );

    const edited = await service.update(owner, post.id, {
      version: 1,
      title: 'Office closed for Diwali',
    });
    expect(edited.version).toBe(2);
    await expect(
      service.update(manager, post.id, { version: 1, title: 'stale' }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(service.findOne(outsider, post.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('hides a private meeting from the uninvited; the owner has the creator’s rights', async () => {
    const meeting = await service.create(staff1, {
      type: 'meeting',
      title: 'Design sync',
      location: 'https://meet.example/abc',
      visibility: 'private',
      memberIds: [staff2.user.id, staff1.user.id],
      startsAt: inHours(3),
      durationMinutes: 45,
    });
    expect(meeting.members.map((m) => m.fullName)).toEqual(['Tia Staff']); // the creator isn't stored

    expect(
      (await service.findOne(staff2, meeting.id)).permissions.canEdit,
    ).toBe(false);
    await expect(service.findOne(staff3, meeting.id)).rejects.toMatchObject({
      status: 404,
    });
    // The owner sees it in full and can do everything its creator can, uninvited.
    const asOwner = await service.findOne(owner, meeting.id);
    expect(asOwner).toMatchObject({
      location: 'https://meet.example/abc',
      isMember: false,
    });
    expect(asOwner.permissions).toEqual({
      canEdit: true,
      canCancel: true,
      canRestore: false,
      actions: [],
      canDelete: true,
    });
    expect(await visibleIds(owner)).toContain(meeting.id);
    const reopened = await service.update(owner, meeting.id, {
      version: 1,
      visibility: 'open',
    });
    expect(reopened.visibility).toBe('open');
    await service.update(owner, meeting.id, {
      version: 2,
      visibility: 'private',
    });
    // Only the creator and the owner change who sees it; an invitee can't.
    await expect(
      service.update(staff2, meeting.id, { version: 3, visibility: 'open' }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(service.findOne(manager, meeting.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('shows open meetings to everyone; a live one can only be cancelled, for good', async () => {
    const live = await service.create(staff2, {
      type: 'meeting',
      title: 'All hands',
      location: 'Main hall',
      visibility: 'open',
      startsAt: inHours(-0.5),
      durationMinutes: 60,
    });
    expect(live.effectiveStatus).toBe('live');
    expect(await visibleIds(staff3)).toContain(live.id);
    // Live: the creator and the owner can cancel it, nothing else.
    for (const who of [staff2, owner]) {
      expect((await service.findOne(who, live.id)).permissions).toEqual({
        canEdit: false,
        canCancel: true,
        canRestore: false,
        actions: [],
      canDelete: false,
      });
    }
    expect(
      (await service.findOne(manager, live.id)).permissions.canCancel,
    ).toBe(false);
    await expect(
      service.update(owner, live.id, { version: 1, title: 'x' }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(service.remove(owner, live.id)).rejects.toMatchObject({
      status: 403,
    });

    // Cancelling a live meeting is final: its start has passed, so no restore; only delete.
    const cancelled = await service.update(owner, live.id, {
      version: 1,
      action: 'cancel',
      reason: 'Fire drill',
    });
    expect(cancelled).toMatchObject({
      effectiveStatus: 'cancelled',
      cancelReason: 'Fire drill',
    });
    expect(cancelled.permissions).toEqual({
      canEdit: false,
      canCancel: false,
      canRestore: false,
      actions: [],
      canDelete: true,
    });
    await expect(
      service.update(staff2, live.id, { version: 2, action: 'restore' }),
    ).rejects.toMatchObject({
      status: 403,
    });
    await service.remove(staff2, live.id);
  });

  it('cancels an upcoming meeting, edits and restores it before it starts, and deletes it', async () => {
    const meeting = await service.create(staff2, {
      type: 'meeting',
      title: 'Planning',
      location: 'Room 4',
      visibility: 'open',
      startsAt: inHours(4),
      durationMinutes: 60,
    });
    expect(
      (await service.findOne(manager, meeting.id)).permissions.canEdit,
    ).toBe(false);

    const cancelled = await service.update(staff2, meeting.id, {
      version: 1,
      action: 'cancel',
      reason: 'Postponed',
    });
    expect(cancelled).toMatchObject({
      effectiveStatus: 'cancelled',
      cancelReason: 'Postponed',
    });
    // Cancelled but not started yet: still editable, and it can come back.
    expect(cancelled.permissions).toEqual({
      canEdit: true,
      canCancel: false,
      canRestore: true,
      actions: [],
      canDelete: true,
    });
    const moved = await service.update(owner, meeting.id, {
      version: 2,
      title: 'Planning (moved)',
    });
    expect(moved).toMatchObject({
      title: 'Planning (moved)',
      effectiveStatus: 'cancelled',
    });
    const restored = await service.update(owner, meeting.id, {
      version: 3,
      action: 'restore',
    });
    expect(restored).toMatchObject({
      effectiveStatus: 'upcoming',
      cancelReason: null,
    });

    // Deleting is for the creator and the owner.
    await expect(service.remove(manager, meeting.id)).rejects.toMatchObject({
      status: 403,
    });
    await service.remove(owner, meeting.id);
    await expect(service.findOne(owner, meeting.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('cannot bring back a cancelled meeting whose start has passed', async () => {
    const meeting = await service.create(staff1, {
      type: 'meeting',
      title: 'Soon',
      location: 'Room 5',
      visibility: 'open',
      startsAt: inHours(1),
      durationMinutes: 30,
    });
    await service.update(staff1, meeting.id, { version: 1, action: 'cancel' });
    // Its start passes while it's cancelled.
    await db.execute(
      sql`update calendar_events set starts_at = now() - interval '10 minutes', ends_at = now() + interval '20 minutes' where id = ${meeting.id}`,
    );
    const later = await service.findOne(staff1, meeting.id);
    expect(later.permissions).toEqual({
      canEdit: false,
      canCancel: false,
      canRestore: false,
      actions: [],
      canDelete: true,
    });
    await expect(
      service.update(staff1, meeting.id, { version: 2, action: 'restore' }),
    ).rejects.toMatchObject({
      status: 403,
    });
    await service.remove(staff1, meeting.id);
  });

  it('only invites people in the company who can open the Calendar', async () => {
    const base = {
      type: 'meeting' as const,
      title: 'm',
      location: 'Room 1',
      visibility: 'private' as const,
    };
    await expect(
      service.create(staff1, {
        ...base,
        memberIds: [noCalendar.user.id],
        startsAt: inHours(2),
        durationMinutes: 30,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.create(staff1, {
        ...base,
        memberIds: [outsider.user.id],
        startsAt: inHours(2),
        durationMinutes: 30,
      }),
    ).rejects.toMatchObject({ status: 400 });
    const names = (await service.people(staff1, '', 50)).items.map(
      (p) => p.fullName,
    );
    expect(names).toContain('Olive Owner');
    expect(names).not.toContain('Nora NoCalendar');
    expect(names).not.toContain('Otto Outside');
  });

  it('keeps a deleted member’s events and drops their invitations', async () => {
    const leaver = await person(tenantIds[0], 'Lee Leaver', 'staff');
    const theirs = await service.create(leaver, {
      type: 'meeting',
      title: 'Leaver’s meeting',
      location: 'Room 2',
      visibility: 'open',
      startsAt: inHours(5),
      durationMinutes: 30,
    });
    const invitedTo = await service.create(staff1, {
      type: 'meeting',
      title: 'With the leaver',
      location: 'Room 3',
      visibility: 'private',
      memberIds: [leaver.user.id],
      startsAt: inHours(6),
      durationMinutes: 30,
    });
    await db.delete(users).where(eq(users.id, leaver.user.id));
    // Nobody is left without a way to manage it: the owner still can.
    expect(
      (await service.findOne(owner, theirs.id)).permissions.canDelete,
    ).toBe(true);
    expect(await service.findOne(owner, theirs.id)).toMatchObject({
      createdBy: null,
      createdByName: null,
    });
    expect((await service.findOne(staff1, invitedTo.id)).members).toEqual([]);
    const logged = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from calendar_event_log where event_id = ${theirs.id}`,
    );
    expect(logged.rows[0].n).toBeGreaterThan(0);
  });
});
