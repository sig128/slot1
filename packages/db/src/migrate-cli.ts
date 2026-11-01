import { createPool } from "./client";
import { runMigrations } from "./migrate";

const url = process.env.DATABASE_URL ?? "postgres://slot1:slot1@127.0.0.1:5432/slot1";
const pool = createPool(url, 2);
runMigrations(pool)
  .then((applied) => {
    console.warn(applied.length ? `Applied migrations: ${applied.join(", ")}` : "Database is up to date.");
  })
  .catch((err: unknown) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
