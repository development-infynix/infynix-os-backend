import { Policy } from '@nestjs/authorization';
import { AccessService } from '../access/access.service.js';
import type { Actor } from '../tenancy/tenancy.types.js';

/**
 * Who may use the CRM API. Owners always can; everyone else needs the `crm`
 * menu grant, so hiding the menu also closes the endpoints.
 */
@Policy()
export class CrmPolicy {
  constructor(private readonly access: AccessService) {}

  async use(a: Actor | null): Promise<boolean> {
    if (a?.user.role === 'owner') return true;
    if (!a) return false;
    return (await this.access.keysFor(a.user)).includes('crm');
  }
}
