// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Environment configuration — Single Source of Truth.
 *
 * Only infrastructure secrets live here. Provider credentials
 * are stored encrypted in the database.
 */

import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid URL"),
  ENCRYPTION_KEY: z.string().min(32, "ENCRYPTION_KEY must be at least 32 characters"),
  ADMIN_API_KEY: z.string().min(32, "ADMIN_API_KEY must be at least 32 characters"),
  ADMIN_USER: z.string().min(1, "ADMIN_USER is required"),
  ADMIN_PASS: z.string().min(8, "ADMIN_PASS must be at least 8 characters"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    if (process.env.NODE_ENV === "test" || process.env.VITEST) {
      return {
        DATABASE_URL: "postgresql://test:test@localhost:5432/test",
        ENCRYPTION_KEY: "test-encryption-key-at-least-32-chars-long",
        ADMIN_API_KEY: "test-admin-api-key-that-is-at-least-32-chars",
        ADMIN_USER: "admin",
        ADMIN_PASS: "testpassword",
        NODE_ENV: "test",
        LOG_LEVEL: "error",
      };
    }
    console.error(`\n❌ Environment validation failed:\n${missing}\n`);
    console.error("Create a .env file based on .env.example and fill in all values.\n");
    process.exit(1);
  }
  return result.data;
}

export const env: Env = loadEnv();
