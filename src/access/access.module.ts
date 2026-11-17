import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { AccessController } from './access.controller.js';
import { AccessRepository } from './access.repository.js';
import { AccessService } from './access.service.js';

@Module({
  imports: [TenancyModule],
  controllers: [AccessController],
  providers: [AccessRepository, AccessService],
  exports: [AccessService],
})
export class AccessModule {}
