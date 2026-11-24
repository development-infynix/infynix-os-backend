import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { TaskStatus } from '../db/schema.js';
import type { CalendarEventView, LogEntry, TaskPatch } from './calendar.repository.js';
import {
  EDITABLE_TASK_STATUSES,
  TASK_TRANSITIONS,
  fieldsFor,
  ruleFor,
  taskStatusAt,
  type Actor,
  type FieldRule,
  type TaskAction,
  type TaskField,
  type TransitionRule,
} from './task-workflow.js';

/*
 * Task rules (decisions T1–T8) as pure functions over a task row: which steps
 * a viewer may take, what a step writes, and what an edit writes. The service
 * wraps them in a transaction; nothing here touches the database.
 */

export interface Viewer {
  id: string;
  role: 'owner' | 'manager' | 'staff';
}

/** One step the viewer may take, with the inputs it takes. */
export interface AllowedAction {
  action: TaskAction;
  to: TaskStatus;
  fields: Partial<Record<TaskField, FieldRule>>;
}

export interface StepInput {
  holdReason?: string;
  holdUntil?: string;
  cancelReason?: string;
  completionRemarks?: string;
  note?: string;
  deadline?: string;
  extensionUntil?: string;
  extensionReason?: string;
}

const STEP_INPUTS: readonly TaskField[] = [
  'holdReason',
  'holdUntil',
  'cancelReason',
  'completionRemarks',
  'note',
  'deadline',
  'extensionUntil',
  'extensionReason',
];

/** The roles this viewer plays on this task. The owner is S and, by T2, also C. */
export function actorsOn(task: CalendarEventView, viewer: Viewer): Set<Actor> {
  const actors = new Set<Actor>();
  if (task.assigneeId === viewer.id) actors.add('A');
  if (task.createdBy === viewer.id) actors.add('C');
  if (viewer.role === 'owner') {
    actors.add('S');
    actors.add('C');
  }
  return actors;
}

/** Self-assigned tasks skip review and cancel requests (ERP D4). */
const modeOf = (task: CalendarEventView) =>
  task.createdBy !== null && task.createdBy === task.assigneeId ? 'self' : 'reviewed';

/** Creator or owner: edits, approvals, deletes. */
export const managesTask = (task: CalendarEventView, viewer: Viewer) =>
  task.createdBy === viewer.id || viewer.role === 'owner';

function resolveTo(rule: TransitionRule, task: CalendarEventView, status: TaskStatus): TaskStatus {
  if (rule.to === 'same') return status;
  if (rule.to === 'previous') return task.previousStatus ?? 'assigned';
  return rule.to;
}

/** Which actor's field rules apply: the creator/owner side when the viewer has it, else the assignee's. */
function actingAs(rule: TransitionRule, actors: Set<Actor>): Actor | null {
  const order: Actor[] = ['C', 'S', 'A'];
  return order.find((a) => actors.has(a) && rule.who.includes(a)) ?? null;
}

function ruleApplies(rule: TransitionRule, task: CalendarEventView, status: TaskStatus) {
  if (!rule.from.includes(status)) return false;
  if (rule.mode !== 'both' && rule.mode !== modeOf(task)) return false;
  if (rule.requires === 'extension_pending' && !task.extensionUntil) return false;
  if (rule.requires === 'no_extension' && task.extensionUntil) return false;
  return true;
}

/** The steps this viewer may take on this task right now. */
export function allowedActions(task: CalendarEventView, viewer: Viewer, now = Date.now()): AllowedAction[] {
  const status = taskStatusAt(task, now);
  const actors = actorsOn(task, viewer);
  const out: AllowedAction[] = [];
  for (const rule of TASK_TRANSITIONS) {
    if (!ruleApplies(rule, task, status)) continue;
    const actor = actingAs(rule, actors);
    if (!actor) continue;
    out.push({ action: rule.action, to: resolveTo(rule, task, status), fields: fieldsFor(rule, actor) });
  }
  return out;
}

/** T5: the creator while assigned or cancelled; the owner at any time. */
export function canDeleteTask(task: CalendarEventView, viewer: Viewer, now = Date.now()) {
  if (viewer.role === 'owner') return true;
  const status = taskStatusAt(task, now);
  return task.createdBy === viewer.id && (status === 'assigned' || status === 'cancelled');
}

/** T7: fields can be edited by the creator / owner while assigned, in progress, on hold or failed. */
export function canEditTask(task: CalendarEventView, viewer: Viewer, now = Date.now()) {
  return managesTask(task, viewer) && EDITABLE_TASK_STATUSES.includes(taskStatusAt(task, now));
}

const trimmed = (value: string | undefined) => {
  const t = value?.trim();
  return t ? t : null;
};

function instant(value: string, label: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new BadRequestException(`${label} must be a valid date and time.`);
  return date;
}

/**
 * The columns that bring the stored row up to its derived status (T8): an
 * ended hold clears its fields; a passed deadline stores failed. Every write
 * starts from this, so the stored status catches up on the next change.
 */
function catchUp(task: CalendarEventView, status: TaskStatus): TaskPatch {
  const patch: TaskPatch = {};
  if (status !== task.status) patch.status = status;
  if (task.status === 'on_hold' && status !== 'on_hold') {
    patch.previous_status = null;
    patch.hold_reason = null;
    patch.hold_until = null;
  }
  return patch;
}

/** Clears everything a fresh assignment shouldn't carry. */
const FRESH: TaskPatch = {
  previous_status: null,
  hold_reason: null,
  hold_until: null,
  extension_until: null,
  extension_reason: null,
};

/**
 * What one workflow step writes, after checking that the viewer may take it
 * and that its inputs are complete and sensible. Throws 403 / 400 otherwise.
 */
export function applyStep(
  task: CalendarEventView,
  viewer: Viewer,
  action: string,
  input: StepInput,
  now = Date.now(),
): { patch: TaskPatch; log: LogEntry } {
  const rule = ruleFor(action);
  if (!rule) throw new BadRequestException(`Unknown step: ${action}.`);
  const status = taskStatusAt(task, now);
  const allowed = allowedActions(task, viewer, now).find((a) => a.action === action);
  if (!allowed) {
    throw new ForbiddenException(
      ruleApplies(rule, task, status)
        ? "You can't take this step on this task."
        : `This step isn't available while the task is ${status.replace('_', ' ')}.`,
    );
  }

  // Only the inputs this step lists; required ones must be present.
  for (const name of STEP_INPUTS) {
    const value = input[name];
    if (value === undefined) continue;
    if (!(name in allowed.fields)) throw new BadRequestException(`This step doesn't take ${name}.`);
  }
  for (const [name, need] of Object.entries(allowed.fields)) {
    if (need === 'required' && !trimmed(input[name as TaskField])) {
      throw new BadRequestException(`This step needs ${name}.`);
    }
  }

  const deadline = Date.parse(task.endsAt);
  const patch: TaskPatch = catchUp(task, status);
  const to = allowed.to;
  let reason: string | null = trimmed(input.note);

  switch (rule.action) {
    case 'start':
    case 'submit':
      patch.status = to;
      break;
    case 'complete':
    case 'approve':
      patch.status = 'completed';
      patch.completion_remarks = trimmed(input.completionRemarks);
      patch.extension_until = null;
      patch.extension_reason = null;
      break;
    case 'hold': {
      const until = instant(input.holdUntil!, 'holdUntil');
      if (until.getTime() <= now) throw new BadRequestException('The hold must end in the future.');
      if (until.getTime() > deadline) throw new BadRequestException('The hold must end on or before the deadline.');
      patch.status = 'on_hold';
      patch.previous_status = status;
      patch.hold_reason = trimmed(input.holdReason);
      patch.hold_until = until;
      reason = patch.hold_reason as string | null;
      break;
    }
    case 'resume':
      Object.assign(patch, { status: to, previous_status: null, hold_reason: null, hold_until: null });
      break;
    case 'reject':
      Object.assign(patch, { status: 'assigned', reject_count: task.rejectCount + 1, previous_status: null });
      break;
    case 'request_cancel':
      // From a hold, the hold ends: a declined request returns to the work's status.
      patch.status = 'request_cancelation';
      patch.previous_status = status === 'on_hold' ? (task.previousStatus ?? 'assigned') : status;
      patch.hold_reason = null;
      patch.hold_until = null;
      patch.cancel_reason = trimmed(input.cancelReason);
      reason = patch.cancel_reason as string | null;
      break;
    case 'approve_cancel':
    case 'cancel':
      Object.assign(patch, FRESH, { status: 'cancelled' });
      if (rule.action === 'cancel') patch.cancel_reason = trimmed(input.cancelReason);
      reason = rule.action === 'cancel' ? (patch.cancel_reason as string | null) : task.cancelReason;
      break;
    case 'decline_cancel':
    case 'withdraw_cancel':
      Object.assign(patch, { status: to, previous_status: null, cancel_reason: null });
      break;
    case 'extend': {
      const next = instant(input.deadline!, 'deadline');
      if (next.getTime() <= now) throw new BadRequestException('The new deadline must be in the future.');
      Object.assign(patch, FRESH, { status: 'assigned', ends_at: next });
      break;
    }
    case 'reopen': {
      const given = trimmed(input.deadline);
      if (!given && deadline <= now) {
        throw new BadRequestException('The deadline has passed; set a new one to reopen the task.');
      }
      if (given) {
        const next = instant(given, 'deadline');
        if (next.getTime() <= now) throw new BadRequestException('The new deadline must be in the future.');
        patch.ends_at = next;
      }
      Object.assign(patch, FRESH, { status: 'assigned', completion_remarks: null, cancel_reason: null });
      break;
    }
    case 'request_extension': {
      const until = instant(input.extensionUntil!, 'extensionUntil');
      if (until.getTime() <= Math.max(deadline, now)) {
        throw new BadRequestException('Ask for a date after the current deadline.');
      }
      patch.extension_until = until;
      patch.extension_reason = trimmed(input.extensionReason);
      reason = patch.extension_reason as string | null;
      break;
    }
    case 'approve_extension': {
      const next = trimmed(input.deadline)
        ? instant(input.deadline!, 'deadline')
        : new Date(task.extensionUntil!);
      if (next.getTime() <= now) throw new BadRequestException('The new deadline must be in the future.');
      Object.assign(patch, { ends_at: next, extension_until: null, extension_reason: null });
      // A failed task comes back to life with its new deadline.
      if (status === 'failed') patch.status = 'assigned';
      break;
    }
    case 'decline_extension':
    case 'withdraw_extension':
      Object.assign(patch, { extension_until: null, extension_reason: null });
      break;
  }

  const toStatus = (patch.status as TaskStatus | undefined) ?? status;
  return {
    patch,
    log: {
      action: rule.log,
      fromStatus: status,
      toStatus,
      reason,
      meta: {
        step: rule.action,
        ...(patch.ends_at ? { deadline: (patch.ends_at as Date).toISOString() } : {}),
        ...(patch.hold_until ? { holdUntil: (patch.hold_until as Date).toISOString() } : {}),
        ...(patch.extension_until ? { extensionUntil: (patch.extension_until as Date).toISOString() } : {}),
      },
    },
  };
}

export interface TaskEditInput {
  title?: string;
  description?: string | null;
  deadline?: string;
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  assigneeId?: string;
}

/**
 * What an edit writes (T7). The caller has already checked the viewer may
 * edit and that a new assignee is allowed. Reassigning starts the task over;
 * moving a failed task's deadline brings it back.
 */
export function buildTaskEdit(
  task: CalendarEventView,
  input: TaskEditInput,
  now = Date.now(),
): { patch: TaskPatch; log: LogEntry } {
  const status = taskStatusAt(task, now);
  const patch: TaskPatch = catchUp(task, status);
  const changed: string[] = [];

  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) throw new BadRequestException('Give the task a title.');
    if (title !== task.title) {
      patch.title = title;
      changed.push('title');
    }
  }
  if (input.description !== undefined) {
    const description = trimmed(input.description ?? undefined);
    if (description !== task.description) {
      patch.description = description;
      changed.push('description');
    }
  }
  if (input.priority !== undefined && input.priority !== task.priority) {
    patch.priority = input.priority;
    changed.push('priority');
  }
  let toStatus = status;
  if (input.deadline !== undefined) {
    const next = instant(input.deadline, 'deadline');
    if (next.getTime() !== Date.parse(task.endsAt)) {
      if (next.getTime() <= now) throw new BadRequestException('The deadline must be in the future.');
      if (status === 'on_hold' && task.holdUntil && Date.parse(task.holdUntil) > next.getTime()) {
        throw new BadRequestException('The hold ends after that deadline. Lift the hold or pick a later date.');
      }
      patch.ends_at = next;
      changed.push('deadline');
      if (status === 'failed') {
        patch.status = 'assigned';
        toStatus = 'assigned';
      }
    }
  }
  if (input.assigneeId !== undefined && input.assigneeId !== task.assigneeId) {
    Object.assign(patch, FRESH, { assignee_id: input.assigneeId, status: 'assigned', reject_count: 0 });
    toStatus = 'assigned';
    changed.push('assignee');
  }
  if (!changed.length) throw new BadRequestException('Nothing to change.');
  return {
    patch,
    log: {
      action: changed.includes('assignee') ? 'reassigned' : 'updated',
      fromStatus: status,
      toStatus,
      meta: { changed, ...(changed.includes('assignee') ? { assigneeId: input.assigneeId } : {}) },
    },
  };
}
