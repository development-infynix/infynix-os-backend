import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthenticationModule, type Duration } from '@nestjs/authentication';
import { AuthorizationModule } from '@nestjs/authorization';
import { DrizzleModule } from '@nestjs/drizzle';
import { StorageModule } from '@nestjs/storage';
import { drizzle } from 'drizzle-orm/node-postgres';
import { AccessModule } from './access/access.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ClientsModule } from './clients/clients.module.js';
import { CrmModule } from './crm/crm.module.js';
import { allowedOrigins } from './config/origins.js';
import { pgPoolConfig } from './db/pg-config.js';
import { HealthController } from './health/health.controller.js';
import { MembersModule } from './members/members.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { storageOptions } from './storage/storage.options.js';
import { ActorResolver } from './tenancy/actor.resolver.js';
import { TenancyModule } from './tenancy/tenancy.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    DrizzleModule.forRootAsync({
      useFactory: () => ({ drizzle, connection: pgPoolConfig() }),
    }),
    // Uploaded files (S3-compatible bucket); see storage/storage.options.ts.
    StorageModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => storageOptions(config),
    }),
    // Authentication before authorization: the policy guard reads request.user.
    AuthenticationModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        session: {
          absoluteTtl: config.get<Duration>('SESSION_ABSOLUTE_TTL', '7d'),
          idleTtl: config.get<Duration>('SESSION_IDLE_TTL', '1d'),
          // The frontend runs on another origin than the API (see config/origins.ts).
          trustedOrigins: allowedOrigins(config.get<string>('CORS_ORIGINS')),
          metadata: (request) => ({
            userAgent: request.headers['user-agent'],
            ip: request.ip,
          }),
        },
      }),
    }),
    // Policies receive an Actor: the user plus, under /t/:tenant, that
    // company and their membership in it (see ActorResolver).
    AuthorizationModule.forRootAsync({
      imports: [TenancyModule],
      inject: [ActorResolver],
      useFactory: (actors: ActorResolver) => ({
        getUser: (context) => actors.resolve(context),
      }),
    }),
    UsersModule,
    TenancyModule,
    AccessModule,
    MembersModule,
    ReportsModule,
    ClientsModule,
    CrmModule,
    AuthModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
