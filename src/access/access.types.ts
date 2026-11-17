import type { ACCESS_KINDS } from '../db/schema.js';

export type AccessKind = (typeof ACCESS_KINDS)[number];

/** One grantable thing: a sidebar menu now, an action later. */
export interface AccessItem {
  id: string;
  key: string;
  label: string;
  kind: AccessKind;
  sortOrder: number;
  isActive: boolean;
}

/** What the owner's grant screen needs for one person. */
export interface MemberAccess {
  items: AccessItem[];
  accessKeys: string[];
}
