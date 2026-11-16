import { Body, Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import {
  CurrentSession,
  CurrentUser,
  Public,
  type SessionRecord,
} from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import type { AuthUser } from '../users/user.types.js';
import { TenantsRepository } from '../tenancy/tenants.repository.js';
import { UsersRepository } from '../users/users.repository.js';
import { AuthService } from './auth.service.js';
import {
  ChangePasswordDto,
  SignInDto,
  SignUpDto,
  UpdateProfileDto,
} from './dto/auth.dto.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersRepository,
    private readonly tenants: TenantsRepository,
  ) {}

  /** The person plus their company. */
  private async session(user: AuthUser) {
    return { user, tenant: await this.tenants.findById(user.tenantId) };
  }

  @Public()
  @Post('sign-in')
  @HttpCode(200)
  async signIn(@Body() dto: SignInDto) {
    return this.session(await this.auth.signIn(dto.email, dto.password));
  }

  /** Self-serve sign-up: creates the company and its owner, and signs in. */
  @Public()
  @Post('sign-up')
  @HttpCode(201)
  async signUp(@Body() dto: SignUpDto) {
    return this.session(await this.auth.signUp(dto));
  }

  /** Public so an expired session can still clear its cookie. */
  @Public()
  @Post('sign-out')
  @HttpCode(204)
  async signOut() {
    await this.auth.signOut();
  }

  @Get('me')
  @Can.Anyone()
  me(@CurrentUser() user: AuthUser) {
    return this.session(user);
  }

  @Patch('me')
  @Can.Anyone()
  async updateProfile(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateProfileDto,
  ) {
    return { user: await this.users.updateProfile(user.id, { fullName: dto.fullName }) };
  }

  @Post('change-password')
  @HttpCode(204)
  @Can.Anyone()
  async changePassword(
    @CurrentUser() user: AuthUser,
    @CurrentSession() session: SessionRecord,
    @Body() dto: ChangePasswordDto,
  ) {
    await this.auth.changePassword(
      user,
      session.id,
      dto.currentPassword,
      dto.newPassword,
    );
  }
}
