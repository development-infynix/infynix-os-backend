import type { AuthUser } from '../users/user.types.js';

// Types `@CurrentUser()` and `AuthenticationContext.user` app-wide.
declare module '@nestjs/authentication' {
  interface AuthenticationTypes {
    user: AuthUser;
  }
}
