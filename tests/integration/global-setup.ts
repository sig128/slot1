import { createPool, runMigrations } from "@slot1/db";
import { createRedis } from "@slot1/platform";
import { TEST_DATABASE_URL, TEST_REDIS_URL } from "./env";

/**
 * Integration tests run against real Postgres and Redis (scripts/local-services.sh or
 * `docker compose --profile infra up`). The test database is wiped and migrated once per run.
 */
export default async function setup() {
  const db = createPool(TEST_DATABASE_URL, 2);
  try {
    await db.query("SELECT 1");
  } catch (err) {
    throw new Error(`Integration tests need Postgres at ${TEST_DATABASE_URL.replace(/:[^:@/]+@/, ":***@")} (${(err as Error).message}). Start it with: bash scripts/local-services.sh start`);
  }
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await runMigrations(db);
  await db.end();
  const redis = createRedis(TEST_REDIS_URL);
  await redis.flushdb();
  await redis.quit();
}
