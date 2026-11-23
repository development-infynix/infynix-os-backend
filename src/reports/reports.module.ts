import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { ReportsController } from './reports.controller.js';
import { ReportsPolicy } from './reports.policy.js';
import { ReportsRepository } from './reports.repository.js';
import { ReportsService } from './reports.service.js';

@Module({
  imports: [TenancyModule, AccessModule],
  controllers: [ReportsController],
  providers: [ReportsRepository, ReportsService, ReportsPolicy],
  exports: [ReportsRepository, ReportsService],
})
export class ReportsModule {}
