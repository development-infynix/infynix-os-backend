/**
 * The frontend origins allowed to call the API with the session cookie
 * (CORS and the sign-in/CSRF origin check), from CORS_ORIGINS:
 * a comma-separated list such as
 *   https://app.example.com,http://localhost:5173
 *
 * Entries are trimmed and a trailing slash is dropped. `*` and anything that
 * isn't scheme://host[:port] are skipped with a warning instead of crashing
 * the app: the API uses cookies, so "any website" is never allowed. The final
 * list is logged at startup so a deployment shows what it actually received.
 */
export function allowedOrigins(raw: string | undefined): string[] {
  const entries = (raw ?? 'http://localhost:5173')
    .split(',')
    .map((entry) => entry.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  const valid: string[] = [];
  const skipped: string[] = [];
  for (const entry of entries) {
    if (isOrigin(entry)) valid.push(entry);
    else skipped.push(entry);
  }

  if (skipped.length) {
    console.warn(
      `[config] CORS_ORIGINS: skipped ${skipped.map((s) => JSON.stringify(s)).join(', ')}. ` +
        "List exact origins like https://app.example.com ('*' isn't allowed because the API uses sign-in cookies).",
    );
  }
  console.log(`[config] allowed origins: ${valid.length ? valid.join(', ') : '(none)'}`);
  return [...new Set(valid)];
}

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
  } catch {
    return false;
  }
}
