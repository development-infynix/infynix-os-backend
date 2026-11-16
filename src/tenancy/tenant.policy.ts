import { Policy } from '@nestjs/authorization';
import type { Actor, MemberRole } from './tenancy.types.js';

const isOwner = (a: Actor | null) => a?.user.role === 'owner';

/**
 * Who may administer their own company. Only owners: the Admin area (users
 * today, company configuration later) is invisible and refused to managers
 * and staff.
 *
 * Route abilities take `null` for guests (used in @Can()); `assignRole` and
 * `manage` need the target, so MembersService checks them itself.
 */
@Policy()
export class TenantPolicy {
  /** The Admin area: see the company's users and settings. */
  administer(a: Actor | null) {
    return isOwner(a);
  }

  /**
   * Whether the actor may give someone `role`. Employees are managers or staff:
   * the owner is the person who signed the company up, and there is one.
   */
  assignRole(a: Actor, role: MemberRole) {
    return isOwner(a) && role !== 'owner';
  }

  /** Whether the actor may change, deactivate or remove someone with `targetRole`. */
  manage(a: Actor, _targetRole: MemberRole) {
    return isOwner(a);
  }
}
