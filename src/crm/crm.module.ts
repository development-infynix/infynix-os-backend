import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { CrmController } from './crm.controller.js';
import { CrmPolicy } from './crm.policy.js';
import { CrmService } from './crm.service.js';

@Module({
  imports: [TenancyModule, AccessModule],
  controllers: [CrmController],
  providers: [CrmService, CrmPolicy],
})
export class CrmModule {}
