import type { TaskStatus } from '../db/schema.js';

/*
 * The task workflow as data (decision T1), ported from the ERP
 * (`erp-backend/src/calendar/constants/task-transitions.ts`, owner decisions
 * D4–D9). Actors: A = assignee, C = creator, S = owner. The owner also holds
 * every creator right on every task (T2), so whoever is the owner acts as both
 * C and S. Rows marked `reviewed` apply when creator ≠ assignee, `self` when
 * they're the same person. Anything not listed is not allowed.
 */

export type Actor = 'A' | 'C' | 'S';
export type FieldRule = 'required' | 'optional';
export type TaskAction =
  | 'start'
  | 'submit'
  | 'complete'
  | 'hold'
  | 'resume'
  | 'approve'
  | 'reject'
  | 'request_cancel'
  | 'approve_cancel'
  | 'decline_cancel'
  | 'withdraw_cancel'
  | 'cancel'
  | 'extend'
  | 'reopen'
  | 'request_extension'
  | 'approve_extension'
  | 'decline_extension'
  | 'withdraw_extension';

/** The inputs a step can take. */
export type TaskField =
  | 'holdReason'
  | 'holdUntil'
  | 'cancelReason'
  | 'completionRemarks'
  | 'note'
  | 'deadline'
  | 'extensionUntil'
  | 'extensionReason';

export interface TransitionRule {
  action: TaskAction;
  from: readonly TaskStatus[];
  /** `previous` resolves to the row's previous_status; `same` keeps the status. */
  to: TaskStatus | 'previous' | 'same';
  who: readonly Actor[];
  mode: 'reviewed' | 'self' | 'both';
  fields?: Partial<Record<TaskField, FieldRule>> | ((actor: Actor) => Partial<Record<TaskField, FieldRule>>);
  /** The log entry's action. */
  log: string;
  /** Gate on whether a request for more time is pending. */
  requires?: 'extension_pending' | 'no_extension';
}

const EXTENDABLE: readonly TaskStatus[] = ['assigned', 'progress', 'failed'];
const OPEN_FOR_CANCEL: readonly TaskStatus[] = ['assigned', 'progress', 'on_hold', 'on_review', 'failed'];

/** Statuses the creator / owner may still edit fields in (ERP edit rules). */
export const EDITABLE_TASK_STATUSES: readonly TaskStatus[] = ['assigned', 'progress', 'on_hold', 'failed'];
/** Only these fail when the deadline passes (review and cancel requests wait on the creator). */
export const FAILABLE_TASK_STATUSES: readonly TaskStatus[] = ['assigned', 'progress'];
/** Still open: these go back to the creator when the assignee is deleted (T6). */
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = [
  'assigned',
  'progress',
  'on_review',
  'on_hold',
  'request_cancelation',
  'failed',
];

export const TASK_TRANSITIONS: readonly TransitionRule[] = [
  { action: 'start', from: ['assigned'], to: 'progress', who: ['A', 'S'], mode: 'both', log: 'status_changed' },
  { action: 'submit', from: ['progress'], to: 'on_review', who: ['A', 'S'], mode: 'reviewed', log: 'status_changed' },
  {
    action: 'complete',
    from: ['progress'],
    to: 'completed',
    who: ['C', 'S'],
    mode: 'self',
    fields: { completionRemarks: 'optional' },
    log: 'status_changed',
  },
  {
    action: 'hold',
    from: ['assigned', 'progress'],
    to: 'on_hold',
    who: ['A', 'C', 'S'],
    mode: 'both',
    // The assignee must say why; the creator / owner may.
    fields: (actor) =>
      actor === 'A'
        ? { holdReason: 'required', holdUntil: 'required' }
        : { holdReason: 'optional', holdUntil: 'required' },
    log: 'hold_set',
  },
  { action: 'resume', from: ['on_hold'], to: 'previous', who: ['C', 'S'], mode: 'both', log: 'hold_lifted' },
  {
    action: 'approve',
    from: ['on_review'],
    to: 'completed',
    who: ['C', 'S'],
    mode: 'reviewed',
    fields: { completionRemarks: 'optional' },
    log: 'status_changed',
  },
  {
    action: 'reject',
    from: ['on_review'],
    to: 'assigned',
    who: ['C', 'S'],
    mode: 'reviewed',
    fields: { note: 'optional' },
    log: 'rejected',
  },
  {
    action: 'request_cancel',
    from: ['assigned', 'progress', 'on_hold'],
    to: 'request_cancelation',
    who: ['A'],
    mode: 'reviewed',
    fields: { cancelReason: 'required' },
    log: 'cancel_requested',
  },
  {
    action: 'approve_cancel',
    from: ['request_cancelation'],
    to: 'cancelled',
    who: ['C', 'S'],
    mode: 'reviewed',
    log: 'cancel_approved',
  },
  {
    action: 'decline_cancel',
    from: ['request_cancelation'],
    to: 'previous',
    who: ['C', 'S'],
    mode: 'reviewed',
    fields: { note: 'optional' },
    log: 'cancel_declined',
  },
  {
    action: 'withdraw_cancel',
    from: ['request_cancelation'],
    to: 'previous',
    who: ['A'],
    mode: 'reviewed',
    log: 'cancel_withdrawn',
  },
  {
    action: 'cancel',
    from: OPEN_FOR_CANCEL,
    to: 'cancelled',
    who: ['C', 'S'],
    mode: 'both',
    fields: { cancelReason: 'optional' },
    log: 'cancelled',
  },
  {
    action: 'extend',
    from: ['failed'],
    to: 'assigned',
    who: ['C', 'S'],
    mode: 'both',
    fields: { deadline: 'required' },
    // While the assignee has asked for time, approving that request is the way to extend.
    requires: 'no_extension',
    log: 'deadline_extended',
  },
  {
    action: 'reopen',
    from: ['completed', 'cancelled'],
    to: 'assigned',
    who: ['S'],
    mode: 'both',
    // Required only when the old deadline has passed; enforced in the service.
    fields: { deadline: 'optional' },
    log: 'reopened',
  },
  {
    action: 'request_extension',
    from: EXTENDABLE,
    to: 'same',
    who: ['A'],
    mode: 'reviewed',
    fields: { extensionUntil: 'required', extensionReason: 'required' },
    requires: 'no_extension',
    log: 'extension_requested',
  },
  {
    action: 'approve_extension',
    from: EXTENDABLE,
    to: 'same',
    who: ['C', 'S'],
    mode: 'reviewed',
    // Defaults to the requested date; the approver may pick another.
    fields: { deadline: 'optional', note: 'optional' },
    requires: 'extension_pending',
    log: 'deadline_extended',
  },
  {
    action: 'decline_extension',
    from: EXTENDABLE,
    to: 'same',
    who: ['C', 'S'],
    mode: 'reviewed',
    fields: { note: 'optional' },
    requires: 'extension_pending',
    log: 'extension_declined',
  },
  {
    action: 'withdraw_extension',
    from: EXTENDABLE,
    to: 'same',
    who: ['A'],
    mode: 'reviewed',
    requires: 'extension_pending',
    log: 'extension_withdrawn',
  },
];

export const TASK_ACTIONS = TASK_TRANSITIONS.map((rule) => rule.action);

export const ruleFor = (action: string) => TASK_TRANSITIONS.find((rule) => rule.action === action);

export function fieldsFor(rule: TransitionRule, actor: Actor): Partial<Record<TaskField, FieldRule>> {
  if (!rule.fields) return {};
  return typeof rule.fields === 'function' ? rule.fields(actor) : rule.fields;
}

/** The task fields the status derivation needs. */
export interface TaskClock {
  status: string;
  endsAt: string;
  previousStatus: string | null;
  holdUntil: string | null;
}

/**
 * A task's status right now (decision T8): the stored one, except that a hold
 * whose end has passed is back to its previous status, and an assigned or
 * in-progress task past its deadline is failed. The frontend mirrors this
 * exactly, so the server and the screen never disagree.
 */
export function taskStatusAt(task: TaskClock, now = Date.now()): TaskStatus {
  let status = task.status as TaskStatus;
  if (status === 'on_hold' && task.holdUntil && Date.parse(task.holdUntil) <= now) {
    status = (task.previousStatus as TaskStatus | null) ?? 'assigned';
  }
  if (FAILABLE_TASK_STATUSES.includes(status) && Date.parse(task.endsAt) <= now) return 'failed';
  return status;
}
