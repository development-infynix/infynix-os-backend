/**
 * Whether an error from a query is a Postgres unique violation (23505).
 * Drizzle wraps driver errors in DrizzleQueryError, which keeps the
 * original under `cause`, so look there too.
 */
export function isUniqueViolation(error: unknown): boolean {
  for (let e = error as { code?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.code === '23505') return true;
  }
  return false;
}
