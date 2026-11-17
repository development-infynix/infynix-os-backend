import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { ClientPolicy } from './client.policy.js';
import { ClientsController } from './clients.controller.js';
import { ClientsRepository } from './clients.repository.js';
import { ClientsService } from './clients.service.js';

@Module({
  imports: [TenancyModule, AccessModule],
  controllers: [ClientsController],
  providers: [ClientsRepository, ClientsService, ClientPolicy],
})
export class ClientsModule {}
