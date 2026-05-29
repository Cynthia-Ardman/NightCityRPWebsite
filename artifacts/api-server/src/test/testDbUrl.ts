// Derives a dedicated test-database URL from DATABASE_URL by appending a
// `_test` suffix to the database name. Kept dependency-free so it can be
// imported from both vitest.config.ts and globalSetup without pulling in the
// app/db singletons.
export function testDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required to derive the test database URL");
  const u = new URL(raw);
  const name = u.pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) u.pathname = `/${name}_test`;
  return u.toString();
}
