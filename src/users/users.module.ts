import { Module } from '@nestjs/common';
import { UsersRepository } from './users.repository.js';

/** Accounts. People are managed per company in MembersModule. */
@Module({
  providers: [UsersRepository],
  exports: [UsersRepository],
})
export class UsersModule {}
