import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { UsersModule } from '../users/users.module.js';
import './authentication.types.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { DrizzleSessionStore } from './drizzle-session.store.js';
import { SessionAuthProvider } from './session-auth.provider.js';

@Module({
  imports: [UsersModule, TenancyModule, AccessModule],
  controllers: [AuthController],
  providers: [DrizzleSessionStore, SessionAuthProvider, AuthService],
})
export class AuthModule {}
