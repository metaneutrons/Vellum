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

/** Execute a database operation with retry + circuit breaker. */
export async function withDb<T>(operation: () => Promise<T>, label?: string): Promise<T> {
  return dbResilience.execute(operation, label);
}

export const db = drizzle(pool, { schema });
