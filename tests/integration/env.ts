export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://slot1:slot1@127.0.0.1:5433/slot1_test";
/** A separate Redis database index so tests never touch development queues. */
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6380/1";
