import { Controller } from '@nestjs/common';
import { CrmService } from './crm.service.js';

/**
 * CRM: /api/v1/crm. Every route will be guarded by the crm menu grant with
 * `@Can(CrmPolicy, 'use')`. No routes yet; the frontend runs on dummy data.
 */
@Controller('crm')
export class CrmController {
  constructor(private readonly crm: CrmService) {}
}
