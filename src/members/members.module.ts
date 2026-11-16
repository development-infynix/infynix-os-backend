import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { MembersController } from './members.controller.js';
import { MembersRepository } from './members.repository.js';
import { MembersService } from './members.service.js';

@Module({
  imports: [TenancyModule],
  controllers: [MembersController],
  providers: [MembersRepository, MembersService],
})
export class MembersModule {}
