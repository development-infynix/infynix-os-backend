import type { MEMBER_ROLES, TENANT_STATUSES } from '../db/schema.js';
import type { AuthUser } from '../users/user.types.js';

export type MemberRole = (typeof MEMBER_ROLES)[number];
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export interface Tenant {
  id: string;
  name: string;
  status: TenantStatus;
  plan: string;
  createdAt: Date;
}

/** Who is acting and their company: what every policy receives. */
export interface Actor {
  user: AuthUser;
  tenant: Tenant;
}
