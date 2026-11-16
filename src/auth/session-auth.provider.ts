import { Injectable } from '@nestjs/common';
import {
  AuthenticationRegistry,
  SessionCookieProvider,
  type SessionRecord,
} from '@nestjs/authentication';
import type { AuthUser } from '../users/user.types.js';
import { UsersRepository } from '../users/users.repository.js';

/** Authenticates requests by the session cookie. */
@Injectable()
export class SessionAuthProvider extends SessionCookieProvider<AuthUser> {
  constructor(
    private readonly users: UsersRepository,
    registry: AuthenticationRegistry,
  ) {
    super();
    registry.registerProvider(this);
  }

  /** Deleted or deactivated users get `null`, which ends the session. */
  async validate(session: SessionRecord) {
    const user = await this.users.findById(session.userId);
    return user?.isActive ? user : null;
  }
}
