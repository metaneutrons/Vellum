// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Environment configuration — Single Source of Truth.
 *
 * Only infrastructure secrets live here. Provider credentials
 * are stored encrypted in the database.
 */

import { z } from "zod";

/** Docker Compose commonly supplies unset optional environment variables as
 * empty strings. Normalize those values before validating so an optional OIDC
 * configuration can be omitted without making the entire process fail. */
const optionalEnv = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    schema.optional(),
  );

const publicOrigin = z.string().url("VELLUM_PUBLIC_URL must be an absolute HTTPS origin").refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.pathname === "/" && !url.search && !url.hash;
}, "VELLUM_PUBLIC_URL must be an HTTPS origin without a path, query, or fragment");

const envSchema = z.object({
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid URL"),
  ENCRYPTION_KEY: z.string().min(32, "ENCRYPTION_KEY must be at least 32 characters"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  ADMIN_API_KEY: z.string().min(32, "ADMIN_API_KEY must be at least 32 characters"),
  ADMIN_USER: z.string().min(1, "ADMIN_USER is required"),
  ADMIN_PASS: z.string().min(8, "ADMIN_PASS must be at least 8 characters"),
  ENTRA_TENANT_ID: optionalEnv(z.string().uuid("ENTRA_TENANT_ID must be a UUID")),
  ENTRA_CLIENT_ID: optionalEnv(z.string().uuid("ENTRA_CLIENT_ID must be a UUID")),
  ENTRA_CLIENT_SECRET: optionalEnv(z.string().min(1, "ENTRA_CLIENT_SECRET must not be empty")),
  VELLUM_PUBLIC_URL: optionalEnv(publicOrigin),
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
        SESSION_SECRET: "test-session-secret-at-least-32-chars-long",
        ADMIN_API_KEY: "test-admin-api-key-that-is-at-least-32-chars",
        ADMIN_USER: "admin",
        ADMIN_PASS: "testpassword",
        ENTRA_TENANT_ID: undefined,
        ENTRA_CLIENT_ID: undefined,
        ENTRA_CLIENT_SECRET: undefined,
        VELLUM_PUBLIC_URL: undefined,
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
