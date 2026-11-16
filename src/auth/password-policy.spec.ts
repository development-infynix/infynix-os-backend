import { passwordProblems } from './password-policy.js';

describe('passwordProblems', () => {
  it('accepts a password that meets every rule', () => {
    expect(passwordProblems('Sample@2026x')).toEqual([]);
  });

  it.each([
    ['Ad@1', 'at least 8 characters'],
    ['admin@12345', 'an uppercase letter'],
    ['ADMIN@12345', 'a lowercase letter'],
    ['Admin@abcde', 'a number'],
    ['Admin12345', 'a special character'],
    ['Admin@ 12345', 'no spaces'],
  ])('rejects %s (%s)', (password, problem) => {
    expect(passwordProblems(password)).toContain(problem);
  });

  it('rejects non-strings', () => {
    expect(passwordProblems(undefined)).not.toEqual([]);
  });
});
