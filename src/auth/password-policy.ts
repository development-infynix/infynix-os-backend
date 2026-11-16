import { registerDecorator, type ValidationOptions } from 'class-validator';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * The rules a password must meet, as human-readable failures (empty = valid):
 * 8-128 characters with at least one uppercase letter, one lowercase letter,
 * one number and one special character (anything not a letter or digit).
 * Used by the DTOs and by the superadmin seed, so both enforce the same policy.
 */
export function passwordProblems(password: unknown): string[] {
  if (typeof password !== 'string') return ['Password must be a string'];
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH)
    problems.push(`at least ${PASSWORD_MIN_LENGTH} characters`);
  if (password.length > PASSWORD_MAX_LENGTH)
    problems.push(`at most ${PASSWORD_MAX_LENGTH} characters`);
  if (!/[A-Z]/.test(password)) problems.push('an uppercase letter');
  if (!/[a-z]/.test(password)) problems.push('a lowercase letter');
  if (!/[0-9]/.test(password)) problems.push('a number');
  if (!/[^A-Za-z0-9]/.test(password)) problems.push('a special character');
  if (/\s/.test(password)) problems.push('no spaces');
  return problems;
}

export function describePasswordProblems(problems: string[]): string {
  return `Password must contain ${problems.join(', ')}`;
}

/** class-validator decorator for {@link passwordProblems}. */
export function IsStrongPassword(options?: ValidationOptions) {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name: 'isStrongPassword',
      target: target.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => passwordProblems(value).length === 0,
        defaultMessage: (args) =>
          describePasswordProblems(passwordProblems(args?.value)),
      },
    });
}
