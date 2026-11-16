import { TenantPolicy } from './tenant.policy.js';
import type { Actor, MemberRole } from './tenancy.types.js';

const actor = (role: MemberRole): Actor => ({
  user: {
    id: 'u1',
    email: 'a@b.co',
    fullName: 'A',
    tenantId: 't1',
    role,
    isPlatformAdmin: false,
    isActive: true,
    emailVerified: true,
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  tenant: { id: 't1', name: 'Acme', status: 'active', plan: 'free', createdAt: new Date() },
});

describe('TenantPolicy', () => {
  const policy = new TenantPolicy();
  const roles = ['owner', 'manager', 'staff'] as const;

  it('opens the Admin area to owners only', () => {
    expect(policy.administer(actor('owner'))).toBe(true);
    expect(policy.administer(actor('manager'))).toBe(false);
    expect(policy.administer(actor('staff'))).toBe(false);
    expect(policy.administer(null)).toBe(false);
  });

  it('lets owners give the manager and staff roles, never owner', () => {
    expect(policy.assignRole(actor('owner'), 'manager')).toBe(true);
    expect(policy.assignRole(actor('owner'), 'staff')).toBe(true);
    expect(policy.assignRole(actor('owner'), 'owner')).toBe(false);
  });

  it('lets owners manage everyone', () => {
    for (const role of roles) expect(policy.manage(actor('owner'), role)).toBe(true);
  });

  it('gives managers and staff no user management', () => {
    for (const me of ['manager', 'staff'] as const) {
      for (const role of roles) {
        expect(policy.assignRole(actor(me), role)).toBe(false);
        expect(policy.manage(actor(me), role)).toBe(false);
      }
    }
  });
});
