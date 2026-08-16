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
    schema.optional()
  );

/* Both env templates ship placeholders that satisfy every length rule, so
 * length alone cannot tell a real secret from the example text:
 *   deploy/vellum.env.example  ENCRYPTION_KEY=replace-with-openssl-rand-hex-32   (exactly 32)
 *   .env.example               ENCRYPTION_KEY=change-me-generate-with-openssl-rand-hex-32 (44)
 * An operator who edits only POSTGRES_PASSWORD would boot a fully "validated"
 * server whose session-signing key, provider-credential master key and global
 * API key are public repository content. Fail closed on the placeholder text
 * instead. Matched anywhere in the value, not just as the whole value: the prod
 * stack derives DATABASE_URL from POSTGRES_PASSWORD, so an unedited password
 * arrives embedded in a connection string that is otherwise well-formed. */
const PLACEHOLDER_RE = /replace[-_]with|change[-_]?me/i;

/** Secret-bearing value: enforces a minimum length AND refuses example text. */
const secret = (name: string, min: number, hint: string) =>
  z
    .string()
    .min(min, `${name} must be at least ${min} characters`)
    .refine(
      (value) => !PLACEHOLDER_RE.test(value),
      `${name} still contains the example placeholder from .env.example — generate a real value (${hint})`
    );

const publicOrigin = z
  .string()
  .url("VELLUM_PUBLIC_URL must be an absolute HTTPS origin")
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname === "/" && !url.search && !url.hash;
  }, "VELLUM_PUBLIC_URL must be an HTTPS origin without a path, query, or fragment");

/* Exported for tests: importing `env` runs loadEnv() at module load, which
 * process.exit(1)s on invalid input, so the schema is validated directly. */
export const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .url("DATABASE_URL must be a valid URL")
    .refine(
      (value) => !PLACEHOLDER_RE.test(value),
      "DATABASE_URL still contains the example placeholder password from deploy/vellum.env.example — set a real POSTGRES_PASSWORD and use it here"
    ),
  ENCRYPTION_KEY: secret("ENCRYPTION_KEY", 32, "openssl rand -hex 32"),
  SESSION_SECRET: secret("SESSION_SECRET", 32, "openssl rand -hex 32"),
  ADMIN_API_KEY: secret("ADMIN_API_KEY", 32, "openssl rand -hex 32"),
  ADMIN_USER: z.string().min(1, "ADMIN_USER is required"),
  ADMIN_PASS: secret("ADMIN_PASS", 8, "use a password manager"),
  ENTRA_TENANT_ID: optionalEnv(z.string().uuid("ENTRA_TENANT_ID must be a UUID")),
  ENTRA_CLIENT_ID: optionalEnv(z.string().uuid("ENTRA_CLIENT_ID must be a UUID")),
  ENTRA_CLIENT_SECRET: optionalEnv(
    secret("ENTRA_CLIENT_SECRET", 1, "copy it from the Entra app registration")
  ),
  VELLUM_PUBLIC_URL: optionalEnv(publicOrigin),
  UPDATER_URL: optionalEnv(z.string().url()),
  UPDATER_TOKEN: optionalEnv(secret("UPDATER_TOKEN", 32, "openssl rand -hex 32")),
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
        UPDATER_URL: undefined,
        UPDATER_TOKEN: undefined,
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
