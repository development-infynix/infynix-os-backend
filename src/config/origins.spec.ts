import { allowedOrigins } from './origins.js';

describe('allowedOrigins', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('reads a comma-separated list of exact origins', () => {
    expect(allowedOrigins('https://infynixos.vercel.app,http://localhost:5173')).toEqual([
      'https://infynixos.vercel.app',
      'http://localhost:5173',
    ]);
  });

  it('tidies spaces and trailing slashes', () => {
    expect(allowedOrigins(' https://infynixos.vercel.app/ , http://localhost:5173 ')).toEqual([
      'https://infynixos.vercel.app',
      'http://localhost:5173',
    ]);
  });

  it('skips * and malformed entries instead of crashing, and says so', () => {
    expect(allowedOrigins('*,https://infynixos.vercel.app,infynixos.vercel.app,https://a.com/path')).toEqual([
      'https://infynixos.vercel.app',
    ]);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('defaults to the local frontend when unset', () => {
    expect(allowedOrigins(undefined)).toEqual(['http://localhost:5173']);
  });

  it('allows nothing when only * is given (cookies are never sent to any website)', () => {
    expect(allowedOrigins('*')).toEqual([]);
  });
});
