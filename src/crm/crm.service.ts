import { Injectable } from '@nestjs/common';
import { TenantDb } from '../db/tenant-db.js';

/**
 * CRM: pipelines, stages and deals inside the actor's own company (all
 * through TenantDb). Empty for now; the plan is in crm-plan.md.
 */
@Injectable()
export class CrmService {
  constructor(private readonly tenantDb: TenantDb) {}
}
