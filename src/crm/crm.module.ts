import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { ClientsModule } from '../clients/clients.module.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { CrmAssignmentController } from './crm-assignment.controller.js';
import { CrmAssignmentRepository } from './crm-assignment.repository.js';
import { CrmAssignmentService } from './crm-assignment.service.js';
import { CrmTransferController } from './crm-transfer.controller.js';
import { CrmTransferRepository } from './crm-transfer.repository.js';
import { CrmTransferService } from './crm-transfer.service.js';
import { CrmController } from './crm.controller.js';
import { CrmPolicy } from './crm.policy.js';
import { CrmRepository } from './crm.repository.js';
import { CrmService } from './crm.service.js';

@Module({
  imports: [TenancyModule, AccessModule, ClientsModule],
  controllers: [CrmController, CrmAssignmentController, CrmTransferController],
  providers: [CrmRepository, CrmService, CrmPolicy, CrmAssignmentRepository, CrmAssignmentService, CrmTransferRepository, CrmTransferService],
})
export class CrmModule {}
