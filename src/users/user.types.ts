import type { MemberRole } from '../tenancy/tenancy.types.js';

/** A person as the API sees it: never carries the password hash. */
export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  /** The one company this person belongs to. */
  tenantId: string;
  role: MemberRole;
  /** Infynix staff (platform level). */
  isPlatformAdmin: boolean;
  isActive: boolean;
  emailVerified: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
