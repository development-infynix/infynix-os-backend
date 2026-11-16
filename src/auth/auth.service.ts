import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  PasswordHasher,
  SessionService,
  SignInService,
} from '@nestjs/authentication';
import { isUniqueViolation } from '../db/errors.js';
import { TenantsRepository } from '../tenancy/tenants.repository.js';
import type { AuthUser } from '../users/user.types.js';
import { UsersRepository } from '../users/users.repository.js';

const INVALID_CREDENTIALS = 'Invalid email or password';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersRepository,
    private readonly hasher: PasswordHasher,
    private readonly signIns: SignInService,
    private readonly sessions: SessionService,
    private readonly tenants: TenantsRepository,
  ) {}

  /** Checks the password and starts a cookie session for this browser. */
  async signIn(email: string, password: string): Promise<AuthUser> {
    const credentials = await this.users.findCredentials(email);
    // verify() checks a dummy hash for unknown emails, so timing doesn't reveal them.
    const valid = await this.hasher.verify(password, credentials?.passwordHash);
    if (!credentials || !valid) throw new UnauthorizedException(INVALID_CREDENTIALS);

    const { user, passwordHash } = credentials;
    if (!user.isActive) throw new ForbiddenException('This account is deactivated');
    const tenant = await this.tenants.findById(user.tenantId);
    if (tenant?.status === 'suspended' && !user.isPlatformAdmin) {
      throw new ForbiddenException('Your company’s account is suspended. Contact Infynix support.');
    }

    if (this.hasher.needsRehash(passwordHash)) {
      await this.users.setPassword(user.id, await this.hasher.hash(password));
    }
    await this.signIns.signIn(user.id, { method: 'password' });
    const lastLoginAt = await this.users.touchLastLogin(user.id);
    return { ...user, lastLoginAt };
  }

  /**
   * Self-serve sign-up: creates the company and its owner account together,
   * then signs the owner in on this browser.
   */
  async signUp(data: {
    companyName: string;
    fullName: string;
    email: string;
    password: string;
  }): Promise<AuthUser> {
    if (await this.users.emailTaken(data.email)) {
      throw new ConflictException('An account with this email already exists. Sign in instead.');
    }
    let owner: AuthUser;
    try {
      ({ owner } = await this.tenants.createWithOwner({
        companyName: data.companyName,
        fullName: data.fullName,
        email: data.email,
        passwordHash: await this.hasher.hash(data.password),
      }));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('An account with this email already exists. Sign in instead.');
      }
      throw error;
    }
    await this.signIns.signIn(owner.id, { method: 'sign-up' });
    const lastLoginAt = await this.users.touchLastLogin(owner.id);
    return { ...owner, lastLoginAt };
  }

  signOut() {
    return this.signIns.signOut();
  }

  /**
   * Changes the signed-in user's password, signs out their other sessions and
   * gives this one a new id.
   */
  async changePassword(
    user: AuthUser,
    currentSessionId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const hash = await this.users.findPasswordHash(user.id);
    if (!(await this.hasher.verify(currentPassword, hash))) {
      throw new BadRequestException('Current password is incorrect');
    }
    if (currentPassword === newPassword) {
      throw new BadRequestException(
        'New password must be different from the current one',
      );
    }
    await this.users.setPassword(user.id, await this.hasher.hash(newPassword));
    await this.sessions.revokeAll(user.id, { except: currentSessionId });
    await this.signIns.rotateSession();
  }
}
