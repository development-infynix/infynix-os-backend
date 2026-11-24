import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { CalendarController } from './calendar.controller.js';
import { CalendarPolicy } from './calendar.policy.js';
import { CalendarRepository } from './calendar.repository.js';
import { CalendarService } from './calendar.service.js';

@Module({
  imports: [TenancyModule, AccessModule],
  controllers: [CalendarController],
  providers: [CalendarRepository, CalendarService, CalendarPolicy],
})
export class CalendarModule {}
