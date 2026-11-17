import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { ClientImportsController } from './client-imports.controller.js';
import { ClientImportsRepository } from './client-imports.repository.js';
import { ClientImportsService } from './client-imports.service.js';
import { ClientPolicy } from './client.policy.js';
import { ClientsController } from './clients.controller.js';
import { ClientsRepository } from './clients.repository.js';
import { ClientsService } from './clients.service.js';

@Module({
  imports: [TenancyModule, AccessModule],
  controllers: [ClientsController, ClientImportsController],
  providers: [
    ClientsRepository,
    ClientsService,
    ClientImportsRepository,
    ClientImportsService,
    ClientPolicy,
  ],
})
export class ClientsModule {}
