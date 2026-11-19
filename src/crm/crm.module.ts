import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { ClientsModule } from '../clients/clients.module.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { CrmController } from './crm.controller.js';
import { CrmPolicy } from './crm.policy.js';
import { CrmRepository } from './crm.repository.js';
import { CrmService } from './crm.service.js';

@Module({
  imports: [TenancyModule, AccessModule, ClientsModule],
  controllers: [CrmController],
  providers: [CrmRepository, CrmService, CrmPolicy],
})
export class CrmModule {}
