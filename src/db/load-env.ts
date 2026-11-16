/** Loads backend/.env for the standalone db scripts (Nest's ConfigModule does it for the app). */
export function loadEnv() {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env: rely on the real environment.
  }
}
