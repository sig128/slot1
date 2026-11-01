import pg from "pg";

const { Pool, types } = pg;

// int8 (bigint) columns: our values (ms offsets, counters) fit in JS numbers.
types.setTypeParser(20, (v: string) => Number.parseInt(v, 10));
// numeric → number
types.setTypeParser(1700, (v: string) => Number.parseFloat(v));

export type Queryable = pg.Pool | pg.PoolClient;
export type DbPool = pg.Pool;

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new Pool({ connectionString, max, idleTimeoutMillis: 30_000, application_name: "slot1" });
}

export async function withTx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export function iso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

export function isoReq(v: Date | string): string {
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

export function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
