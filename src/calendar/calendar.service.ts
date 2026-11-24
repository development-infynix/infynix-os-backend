import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantDb, type TenantTx } from '../db/tenant-db.js';
import type { Actor } from '../tenancy/tenancy.types.js';
import {
  CalendarRepository,
  type CalendarEventPatch,
  type CalendarEventView,
} from './calendar.repository.js';
import {
  MAX_DURATION_MINUTES,
  type CreateCalendarEventDto,
} from './dto/create-calendar-event.dto.js';
import type { UpdateCalendarEventDto } from './dto/update-calendar-event.dto.js';
import type { TaskStatus } from '../db/schema.js';
import {
  allowedActions,
  applyStep,
  buildTaskEdit,
  canDeleteTask,
  canEditTask,
  managesTask,
  type AllowedAction,
  type Viewer,
} from './task-rules.js';
import { taskStatusAt } from './task-workflow.js';

/** The longest range one list request may cover (a month view's six weeks fit). */
export const MAX_RANGE_DAYS = 62;
/** Safety cap on one list response. */
const ROW_CAP = 2000;
const DAY_MS = 86_400_000;

export type DerivedStatus = 'upcoming' | 'live' | 'ended' | 'cancelled';

export interface CalendarPermissions {
  canEdit: boolean;
  canCancel: boolean;
  canRestore: boolean;
  canDelete: boolean;
  /** Task only: the workflow steps the viewer may take now (T7). Empty for other types. */
  actions: AllowedAction[];
}

/** Fields only tasks take; announcements and meetings reject them. */
const TASK_ONLY_FIELDS = [
  'deadline',
  'assigneeId',
  'priority',
  'holdReason',
  'holdUntil',
  'cancelReason',
  'completionRemarks',
  'note',
  'extensionUntil',
  'extensionReason',
] as const;
/** Fields tasks never take. */
const NON_TASK_FIELDS = ['startsAt', 'durationMinutes', 'location', 'visibility', 'memberIds', 'reason'] as const;
/** Inputs of workflow steps (not editable fields). */
const STEP_FIELDS = [
  'holdReason',
  'holdUntil',
  'cancelReason',
  'completionRemarks',
  'note',
  'extensionUntil',
  'extensionReason',
] as const;

const viewerOf = (actor: Actor): Viewer => ({ id: actor.user.id, role: actor.user.role as Viewer['role'] });
const given = (dto: object, keys: readonly string[]) =>
  keys.filter((key) => (dto as Record<string, unknown>)[key] !== undefined);

/** An event as the API returns it: the stored row plus its derived status and the viewer's permissions. */
export type PublicCalendarEvent = Omit<CalendarEventView, 'isMember'> & {
  /**
   * Derived on every read (no background job): announcements and meetings
   * from their time window (C6); tasks from the stored status, with failed and
   * an ended hold worked out from the clock (T8).
   */
  effectiveStatus: DerivedStatus | TaskStatus;
  isMember: boolean;
  permissions: CalendarPermissions;
};

const isOwner = (actor: Actor) => actor.user.role === 'owner';
/** C1: owners and managers post announcements. */
const canAnnounce = (actor: Actor) =>
  actor.user.role === 'owner' || actor.user.role === 'manager';

export function deriveStatus(
  event: Pick<CalendarEventView, 'status' | 'startsAt' | 'endsAt'>,
  now = Date.now(),
): DerivedStatus {
  if (event.status === 'cancelled') return 'cancelled';
  if (now < Date.parse(event.startsAt)) return 'upcoming';
  if (now < Date.parse(event.endsAt)) return 'live';
  return 'ended';
}

/**
 * Who may change an event (decisions C2, C3). The creator, and the owner, who
 * has every right the creator has on every announcement and meeting, private
 * ones included.
 */
export function canManage(event: CalendarEventView, actor: Actor): boolean {
  return event.createdBy === actor.user.id || isOwner(actor);
}

/** A cancelled event can come back while its start time is still ahead. */
const restorable = (
  event: CalendarEventView,
  status: DerivedStatus,
  now = Date.now(),
) => status === 'cancelled' && now < Date.parse(event.startsAt);

/**
 * What the creator and the owner may do, by status (decision C9):
 * upcoming → edit (and cancel) and delete; live → cancel only (final: its
 * start has passed, so it can't be restored), nothing else until it ends;
 * ended → delete; cancelled → delete, and edit (and restore) while its start
 * time is still ahead.
 */
function permissionsFor(
  event: CalendarEventView,
  actor: Actor,
  status: DerivedStatus,
  now = Date.now(),
): CalendarPermissions {
  const manage = canManage(event, actor);
  return {
    canEdit:
      manage && (status === 'upcoming' || restorable(event, status, now)),
    canCancel: manage && (status === 'upcoming' || status === 'live'),
    canRestore: manage && restorable(event, status, now),
    canDelete: manage && status !== 'live',
    actions: [],
  };
}

function taskPermissions(task: CalendarEventView, actor: Actor, now = Date.now()): CalendarPermissions {
  const viewer = viewerOf(actor);
  return {
    canEdit: canEditTask(task, viewer, now),
    canCancel: false,
    canRestore: false,
    canDelete: canDeleteTask(task, viewer, now),
    actions: allowedActions(task, viewer, now),
  };
}

function parseInstant(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new BadRequestException(`${field} must be a valid date and time.`);
  return date;
}

const trimmedOrNull = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

@Injectable()
export class CalendarService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly calendar: CalendarRepository,
  ) {}

  /** The company's timezone and today in it: the grid groups days by this zone (decision C5). */
  context(actor: Actor) {
    return this.tenantDb.run(actor.tenant.id, (tx) =>
      this.calendar.context(tx),
    );
  }

  async list(actor: Actor, fromValue: string, toValue: string) {
    const from = parseInstant(fromValue, 'from');
    const to = parseInstant(toValue, 'to');
    if (to <= from) throw new BadRequestException('to must be after from.');
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
      throw new BadRequestException(
        `A range can cover at most ${MAX_RANGE_DAYS} days.`,
      );
    }
    const rows = await this.tenantDb.run(actor.tenant.id, (tx) =>
      this.calendar.list(
        tx,
        actor.user.id,
        isOwner(actor),
        from,
        to,
        ROW_CAP + 1,
      ),
    );
    const now = Date.now();
    return {
      items: rows.slice(0, ROW_CAP).map((row) => this.present(row, actor, now)),
      truncated: rows.length > ROW_CAP,
    };
  }

  async findOne(actor: Actor, id: string): Promise<PublicCalendarEvent> {
    const row = await this.tenantDb.run(actor.tenant.id, (tx) =>
      this.calendar.find(tx, actor.user.id, isOwner(actor), id),
    );
    if (!row) throw new NotFoundException('Calendar event not found.');
    return this.present(row, actor);
  }

  async create(
    actor: Actor,
    dto: CreateCalendarEventDto,
  ): Promise<PublicCalendarEvent> {
    const title = dto.title.trim();
    if (!title) throw new BadRequestException('Give it a title.');
    if (dto.type === 'task') return this.createTask(actor, dto, title);
    const wrong = given(dto, ['deadline', 'assigneeId', 'priority']);
    if (wrong.length) throw new BadRequestException(`Only tasks take ${wrong.join(', ')}.`);
    if (dto.startsAt === undefined || dto.durationMinutes === undefined) {
      throw new BadRequestException('Give it a start and a length.');
    }
    const startsAt = parseInstant(dto.startsAt, 'startsAt');
    const endsAt = new Date(startsAt.getTime() + dto.durationMinutes * 60_000);
    const description = trimmedOrNull(dto.description);

    let location: string | null = null;
    let visibility: 'open' | 'private' | null = null;
    let memberIds: string[] = [];
    if (dto.type === 'announcement') {
      if (!canAnnounce(actor))
        throw new ForbiddenException(
          'Only the owner and managers can post announcements.',
        );
      if (!description)
        throw new BadRequestException('An announcement needs its text.');
      if (
        dto.location !== undefined ||
        dto.visibility !== undefined ||
        dto.memberIds !== undefined
      ) {
        throw new BadRequestException(
          'Announcements have no place, visibility or invitees.',
        );
      }
    } else {
      location = trimmedOrNull(dto.location);
      if (!location)
        throw new BadRequestException(
          'A meeting needs a room, address or link.',
        );
      if (!dto.visibility)
        throw new BadRequestException(
          'Choose whether the meeting is open or private.',
        );
      visibility = dto.visibility;
      // The creator is always part of their meeting; they're never stored as a member.
      memberIds = (dto.memberIds ?? []).filter((id) => id !== actor.user.id);
    }

    const created = await this.tenantDb.run(actor.tenant.id, async (tx) => {
      const { id, validMembers } = await this.calendar.create(
        tx,
        actor.tenant.id,
        actor.user.id,
        {
          type: dto.type,
          title,
          description,
          startsAt,
          endsAt,
          location,
          visibility,
        },
        memberIds,
      );
      this.assertMembers(validMembers, memberIds.length);
      return this.mustFind(tx, actor, id);
    });
    return this.present(created, actor);
  }

  /** T1, T3, T4: a task starts now, is due at its deadline, and goes to someone the creator may assign. */
  private async createTask(actor: Actor, dto: CreateCalendarEventDto, title: string) {
    const wrong = given(dto, ['startsAt', 'durationMinutes', 'location', 'visibility', 'memberIds']);
    if (wrong.length) throw new BadRequestException(`Tasks don't take ${wrong.join(', ')}.`);
    if (!dto.deadline) throw new BadRequestException('Set a deadline.');
    const deadline = parseInstant(dto.deadline, 'deadline');
    const startsAt = new Date();
    if (deadline.getTime() <= startsAt.getTime() + 1000) {
      throw new BadRequestException('The deadline must be in the future.');
    }
    const assigneeId = dto.assigneeId ?? actor.user.id;
    const created = await this.tenantDb.run(actor.tenant.id, async (tx) => {
      await this.assertAssignable(tx, actor, assigneeId);
      const { id } = await this.calendar.create(
        tx,
        actor.tenant.id,
        actor.user.id,
        {
          type: 'task',
          title,
          description: trimmedOrNull(dto.description),
          startsAt,
          endsAt: deadline,
          location: null,
          visibility: null,
          assigneeId,
          priority: dto.priority ?? 'medium',
        },
        [],
      );
      return this.mustFind(tx, actor, id);
    });
    return this.present(created, actor);
  }

  /**
   * T3, T4: staff assign only to themselves; managers to staff or themselves;
   * the owner to anyone. Everyone assigned must be active and able to open
   * the Calendar.
   */
  private async assertAssignable(tx: TenantTx, actor: Actor, assigneeId: string) {
    const role = actor.user.role;
    if (assigneeId !== actor.user.id && role === 'staff') {
      throw new ForbiddenException('You can only assign tasks to yourself.');
    }
    const person = await this.calendar.assignable(tx, assigneeId);
    if (!person) throw new BadRequestException('That person is inactive or can’t open the Calendar.');
    if (assigneeId !== actor.user.id && role === 'manager' && person.role !== 'staff') {
      throw new ForbiddenException('Managers can assign tasks to staff or themselves.');
    }
  }

  /** A task change: one workflow step (`action`), or an edit of its fields. */
  private async updateTask(tx: TenantTx, actor: Actor, task: CalendarEventView, dto: UpdateCalendarEventDto) {
    const wrong = given(dto, NON_TASK_FIELDS);
    if (wrong.length) throw new BadRequestException(`Tasks don't take ${wrong.join(', ')}.`);
    const viewer = viewerOf(actor);
    let change;
    if (dto.action !== undefined) {
      const extra = given(dto, ['title', 'description', 'assigneeId', 'priority']);
      if (extra.length) throw new BadRequestException('A step can’t also edit the task.');
      change = applyStep(task, viewer, dto.action, dto);
    } else {
      const steps = given(dto, STEP_FIELDS);
      if (steps.length) throw new BadRequestException(`${steps.join(', ')} only go with a step.`);
      if (!canEditTask(task, viewer)) {
        throw new ForbiddenException(
          managesTask(task, viewer)
            ? `This task is ${taskStatusAt(task).replace('_', ' ')}, so it can't be edited.`
            : "You can't edit this task.",
        );
      }
      if (dto.assigneeId !== undefined && dto.assigneeId !== task.assigneeId) {
        await this.assertAssignable(tx, actor, dto.assigneeId);
      }
      change = buildTaskEdit(task, dto);
    }
    if (!(await this.calendar.updateTask(tx, actor.user.id, task.id, dto.version, change.patch, change.log))) {
      this.conflict(await this.mustFind(tx, actor, task.id), actor);
    }
    return this.mustFind(tx, actor, task.id);
  }

  async update(
    actor: Actor,
    id: string,
    dto: UpdateCalendarEventDto,
  ): Promise<PublicCalendarEvent> {
    const saved = await this.tenantDb.run(actor.tenant.id, async (tx) => {
      const event = await this.calendar.find(
        tx,
        actor.user.id,
        isOwner(actor),
        id,
      );
      if (!event) throw new NotFoundException('Calendar event not found.');
      if (event.version !== dto.version) this.conflict(event, actor);
      if (event.type === 'task') return this.updateTask(tx, actor, event, dto);
      const taskOnly = given(dto, TASK_ONLY_FIELDS);
      if (taskOnly.length) throw new BadRequestException(`Only tasks take ${taskOnly.join(', ')}.`);
      if (dto.action !== undefined && dto.action !== 'cancel' && dto.action !== 'restore') {
        throw new BadRequestException(`${dto.action} is a task step.`);
      }
      const status = deriveStatus(event);
      const permissions = permissionsFor(event, actor, status);

      if (dto.action === 'cancel') {
        const extra = Object.entries(dto).filter(
          ([key, value]) =>
            value !== undefined &&
            !['version', 'action', 'reason'].includes(key),
        );
        if (extra.length)
          throw new BadRequestException('Cancelling takes only a reason.');
        if (!permissions.canCancel) {
          throw new ForbiddenException(
            !canManage(event, actor)
              ? `You can't cancel this ${event.type}.`
              : `This ${event.type} has already ${status === 'ended' ? 'ended' : 'been cancelled'}.`,
          );
        }
        if (
          !(await this.calendar.cancel(
            tx,
            actor.user.id,
            id,
            dto.version,
            trimmedOrNull(dto.reason),
          ))
        ) {
          this.conflict(await this.mustFind(tx, actor, id), actor);
        }
        return this.mustFind(tx, actor, id);
      }

      if (dto.action === 'restore') {
        const extra = Object.entries(dto).filter(
          ([key, value]) =>
            value !== undefined && !['version', 'action'].includes(key),
        );
        if (extra.length)
          throw new BadRequestException('Restoring takes nothing else.');
        if (!permissions.canRestore) {
          throw new ForbiddenException(
            !canManage(event, actor)
              ? `You can't restore this ${event.type}.`
              : status !== 'cancelled'
                ? `This ${event.type} isn't cancelled.`
                : `This ${event.type}'s start time has passed, so it can't be brought back.`,
          );
        }
        if (
          !(await this.calendar.restore(tx, actor.user.id, id, dto.version))
        ) {
          this.conflict(await this.mustFind(tx, actor, id), actor);
        }
        return this.mustFind(tx, actor, id);
      }

      if (dto.reason !== undefined)
        throw new BadRequestException('A reason only goes with cancelling.');
      if (!permissions.canEdit) {
        throw new ForbiddenException(
          !canManage(event, actor)
            ? `You can't edit this ${event.type}.`
            : status === 'live'
              ? `This ${event.type} is live; it can be changed again once it ends.`
              : status === 'ended'
                ? `This ${event.type} has ended, so it can't be edited.`
                : `This ${event.type}'s start time has passed, so it can't be edited.`,
        );
      }
      const { patch, memberIds, changed } = this.buildPatch(event, dto, actor);
      if (!changed.length) throw new BadRequestException('Nothing to change.');

      const { updated, validMembers } = await this.calendar.update(
        tx,
        actor.user.id,
        id,
        dto.version,
        patch,
        memberIds,
        changed,
      );
      if (!updated) this.conflict(await this.mustFind(tx, actor, id), actor);
      if (memberIds) this.assertMembers(validMembers, memberIds.length);
      return this.mustFind(tx, actor, id);
    });
    return this.present(saved, actor);
  }

  async remove(actor: Actor, id: string): Promise<void> {
    await this.tenantDb.run(actor.tenant.id, async (tx) => {
      const event = await this.calendar.find(
        tx,
        actor.user.id,
        isOwner(actor),
        id,
      );
      if (!event) throw new NotFoundException('Calendar event not found.');
      if (event.type === 'task') {
        if (!canDeleteTask(event, viewerOf(actor))) {
          throw new ForbiddenException(
            event.createdBy === actor.user.id
              ? 'A task can be deleted while it’s assigned or cancelled. Cancel it first.'
              : 'Only the person who created this task, or the owner, can delete it.',
          );
        }
        await this.calendar.remove(tx, actor.user.id, id);
        return;
      }
      if (!permissionsFor(event, actor, deriveStatus(event)).canDelete) {
        throw new ForbiddenException(
          !canManage(event, actor)
            ? event.type === 'meeting'
              ? 'Only the person who created this meeting, or the owner, can delete it.'
              : `You can't delete this ${event.type}.`
            : `This ${event.type} is live; it can be deleted once it ends.`,
        );
      }
      await this.calendar.remove(tx, actor.user.id, id);
    });
  }

  /** People who can be invited to a meeting (they can open the Calendar). */
  async people(actor: Actor, query: string, limit: number, assign = false) {
    const items = await this.tenantDb.run(actor.tenant.id, (tx) =>
      this.calendar.people(
        tx,
        query,
        limit,
        assign ? { me: actor.user.id, role: viewerOf(actor).role } : undefined,
      ),
    );
    return { items };
  }

  /** The fields an edit may change, per type; anything else is a 400. */
  private buildPatch(
    event: CalendarEventView,
    dto: UpdateCalendarEventDto,
    actor: Actor,
  ) {
    const patch: CalendarEventPatch = {};
    const changed: string[] = [];
    if (dto.title !== undefined) {
      const title = dto.title.trim();
      if (!title) throw new BadRequestException('Give it a title.');
      patch.title = title;
      changed.push('title');
    }
    if (dto.description !== undefined) {
      const description = trimmedOrNull(dto.description);
      if (event.type === 'announcement' && !description) {
        throw new BadRequestException('An announcement needs its text.');
      }
      patch.description = description;
      changed.push('description');
    }
    if (dto.startsAt !== undefined || dto.durationMinutes !== undefined) {
      const startsAt = dto.startsAt
        ? parseInstant(dto.startsAt, 'startsAt')
        : new Date(event.startsAt);
      const minutes =
        dto.durationMinutes ??
        Math.round(
          (Date.parse(event.endsAt) - Date.parse(event.startsAt)) / 60_000,
        );
      if (minutes > MAX_DURATION_MINUTES)
        throw new BadRequestException('An event can last at most 62 days.');
      patch.startsAt = startsAt;
      patch.endsAt = new Date(startsAt.getTime() + minutes * 60_000);
      changed.push('time');
    }

    let memberIds: string[] | null = null;
    if (event.type === 'announcement') {
      if (
        dto.location !== undefined ||
        dto.visibility !== undefined ||
        dto.memberIds !== undefined
      ) {
        throw new BadRequestException(
          'Announcements have no place, visibility or invitees.',
        );
      }
    } else {
      if (dto.location !== undefined) {
        const location = trimmedOrNull(dto.location);
        if (!location)
          throw new BadRequestException(
            'A meeting needs a room, address or link.',
          );
        patch.location = location;
        changed.push('location');
      }
      if (dto.visibility !== undefined) {
        // Only the creator, or the owner, decides who can see a meeting.
        if (!canManage(event, actor) && dto.visibility !== event.visibility) {
          throw new ForbiddenException(
            'Only the person who created the meeting, or the owner, can change who sees it.',
          );
        }
        patch.visibility = dto.visibility;
        changed.push('visibility');
      }
      if (dto.memberIds !== undefined) {
        memberIds = dto.memberIds.filter((id) => id !== event.createdBy);
        changed.push('members');
      }
    }
    return { patch, memberIds, changed };
  }

  private async mustFind(
    tx: TenantTx,
    actor: Actor,
    id: string,
  ): Promise<CalendarEventView> {
    const row = await this.calendar.find(tx, actor.user.id, isOwner(actor), id);
    if (!row) throw new NotFoundException('Calendar event not found.');
    return row;
  }

  /** Every invitee must be an active person in the company who can open the Calendar. */
  private assertMembers(valid: number, requested: number) {
    if (valid !== requested) {
      throw new BadRequestException(
        'Some invited people are inactive or can’t open the Calendar.',
      );
    }
  }

  /** Someone else changed the event first: 409 with the latest copy. */
  private conflict(latest: CalendarEventView, actor: Actor): never {
    throw new ConflictException({
      statusCode: 409,
      errorCode: 'version_conflict',
      message:
        'Someone else changed this event. Review the latest version and try again.',
      current: this.present(latest, actor),
    });
  }

  private present(
    row: CalendarEventView,
    actor: Actor,
    now = Date.now(),
  ): PublicCalendarEvent {
    if (row.type === 'task') {
      return { ...row, effectiveStatus: taskStatusAt(row, now), permissions: taskPermissions(row, actor, now) };
    }
    const effectiveStatus = deriveStatus(row, now);
    return {
      ...row,
      effectiveStatus,
      permissions: permissionsFor(row, actor, effectiveStatus, now),
    };
  }
}
