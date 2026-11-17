import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { MembersController } from './members.controller.js';
import { MembersRepository } from './members.repository.js';
import { MembersService } from './members.service.js';

@Module({
  imports: [TenancyModule, AccessModule],
  controllers: [MembersController],
  providers: [MembersRepository, MembersService],
})
export class MembersModule {}
