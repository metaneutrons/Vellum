// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { env } from "@/lib/env";
import { log } from "@/lib/logger";
import { dbResilience, DbUnavailableError } from "@/lib/db-resilience";

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 3_000,
  statement_timeout: 30_000,
  query_timeout: 35_000,
  idle_in_transaction_session_timeout: 15_000,
  keepAlive: true,
  application_name: "vellum-server",
});

pool.on("error", (err) => {
  log.error("Database pool error", { error: String(err) });
});

/** Raw health check (used by resilience layer probe) */
async function rawHealthCheck(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
  } finally {
    client.release();
  }
}

// Register with resilience manager and start monitoring
dbResilience.registerHealthCheck(rawHealthCheck);
dbResilience.startMonitoring();

/** Check database connectivity (resilience-aware). */
export async function checkDbHealth(): Promise<boolean> {
  try {
    await rawHealthCheck();
    return true;
  } catch {
    return false;
  }
}

/** Get database health state for API/WebUI. */
export { dbResilience, DbUnavailableError };

export const db = drizzle(pool, { schema });

export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Reads may be replayed after transient transport failures. */
export async function withDbRead<T>(operation: () => Promise<T>, label?: string): Promise<T> {
  return dbResilience.execute(operation, label, "read");
}

/** Plain writes are never replayed because their commit outcome may be unknown. */
export async function withDbWrite<T>(operation: () => Promise<T>, label?: string): Promise<T> {
  return dbResilience.execute(operation, label, "write");
}

/** Transactions retry only when PostgreSQL guarantees the prior attempt rolled back. */
export async function withDbTransaction<T>(
  operation: () => Promise<T>,
  label?: string
): Promise<T> {
  return dbResilience.execute(operation, label, "transaction");
}
