/**
 * Whether an error from a query is a Postgres unique violation (23505).
 * Drizzle wraps driver errors in DrizzleQueryError, which keeps the
 * original under `cause`, so look there too.
 */
export function isUniqueViolation(error: unknown): boolean {
  return hasPgCode(error, '23505');
}

/** Whether an error is a Postgres foreign key violation (23503), e.g. a row still referenced. */
export function isForeignKeyViolation(error: unknown): boolean {
  return hasPgCode(error, '23503');
}

function hasPgCode(error: unknown, code: string): boolean {
  for (let e = error as { code?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.code === code) return true;
  }
  return false;
}
