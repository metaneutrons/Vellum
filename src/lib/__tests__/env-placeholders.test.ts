// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Both env templates ship placeholder secrets that satisfy every length rule,
 * so an operator who edits only POSTGRES_PASSWORD could boot a server whose
 * session-signing key, provider-credential master key and global API key were
 * public repository content. These tests pin the fail-closed behavior — and,
 * just as importantly, pin that the real CI and test values still pass.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { envSchema } from "../env";

const REPO_ROOT = join(__dirname, "..", "..", "..");

/** A complete, realistic env that must validate. */
const validEnv = {
  DATABASE_URL: "postgresql://vellum:s3cret-db-pw@postgres:5432/vellum",
  ENCRYPTION_KEY: "b8f2c1a49d7e3f60b8f2c1a49d7e3f60",
  SESSION_SECRET: "4d9e7c2b6a1f8035d4c9b2e7a6f1082c",
  ADMIN_API_KEY: "7f3a9c1e5b8d2064f7a3c9e1b5d80264",
  ADMIN_USER: "admin",
  ADMIN_PASS: "correct-horse-battery",
  NODE_ENV: "production",
};

/** Read a KEY=value pair out of one of the shipped templates. */
function fromTemplate(file: string, key: string): string {
  const line = readFileSync(join(REPO_ROOT, file), "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${key}=`));
  if (!line) throw new Error(`${key} not found in ${file}`);
  return line.slice(key.length + 1);
}

/**
 * The production template no longer ships a DATABASE_URL: docker-compose.yml
 * derives it from POSTGRES_* so the password is defined once. An operator who
 * leaves POSTGRES_PASSWORD unedited therefore reaches the server as a *derived*
 * URL carrying the placeholder, which is the shape the guard has to catch. Kept in
 * step with the `DATABASE_URL:` expression in deploy/docker-compose.yml.
 */
function derivedProdDatabaseUrl(): string {
  const password = fromTemplate("deploy/vellum.env.example", "POSTGRES_PASSWORD");
  const user = fromTemplate("deploy/vellum.env.example", "POSTGRES_USER");
  const database = fromTemplate("deploy/vellum.env.example", "POSTGRES_DB");
  return `postgresql://${user}:${password}@postgres:5432/${database}`;
}

describe("env schema", () => {
  it("accepts a fully populated, real configuration", () => {
    expect(envSchema.safeParse(validEnv).success).toBe(true);
  });

  it("still enforces minimum lengths", () => {
    for (const [key, tooShort] of [
      ["ENCRYPTION_KEY", "short"],
      ["SESSION_SECRET", "short"],
      ["ADMIN_API_KEY", "short"],
      ["ADMIN_PASS", "abc"],
    ] as const) {
      const result = envSchema.safeParse({ ...validEnv, [key]: tooShort });
      expect(result.success, `${key} should reject a too-short value`).toBe(false);
    }
  });
});

describe("placeholder rejection", () => {
  /* The exact strings shipped in the repo. If someone edits a template, these
   * assertions follow it — the guard is tested against reality, not a copy. */
  it.each([
    ["deploy/vellum.env.example", "ENCRYPTION_KEY"],
    ["deploy/vellum.env.example", "SESSION_SECRET"],
    ["deploy/vellum.env.example", "ADMIN_API_KEY"],
    ["deploy/vellum.env.example", "ADMIN_PASS"],
    [".env.example", "ENCRYPTION_KEY"],
    [".env.example", "SESSION_SECRET"],
    [".env.example", "ADMIN_API_KEY"],
    [".env.example", "ADMIN_PASS"],
  ])("rejects the %s value shipped for %s", (file, key) => {
    const shipped = fromTemplate(file, key);
    const result = envSchema.safeParse({ ...validEnv, [key]: shipped });
    expect(result.success, `${key} from ${file} (${shipped}) must not validate`).toBe(false);
  });

  it("rejects a DATABASE_URL derived from an unedited POSTGRES_PASSWORD", () => {
    // The production failure mode since docker-compose.yml started deriving the
    // connection string: the operator never sees a DATABASE_URL placeholder to
    // edit, so the guard has to catch the password carried inside the derived URL.
    const derived = derivedProdDatabaseUrl();
    expect(derived).toMatch(/replace[-_]with/); // the template still ships one
    const result = envSchema.safeParse({ ...validEnv, DATABASE_URL: derived });
    expect(result.success, `${derived} must not validate`).toBe(false);
  });

  it("rejects an unedited prod template wholesale, naming every offender", () => {
    const result = envSchema.safeParse({
      DATABASE_URL: derivedProdDatabaseUrl(),
      ENCRYPTION_KEY: fromTemplate("deploy/vellum.env.example", "ENCRYPTION_KEY"),
      SESSION_SECRET: fromTemplate("deploy/vellum.env.example", "SESSION_SECRET"),
      ADMIN_API_KEY: fromTemplate("deploy/vellum.env.example", "ADMIN_API_KEY"),
      ADMIN_USER: fromTemplate("deploy/vellum.env.example", "ADMIN_USER"),
      ADMIN_PASS: fromTemplate("deploy/vellum.env.example", "ADMIN_PASS"),
      UPDATER_TOKEN: fromTemplate("deploy/vellum.env.example", "UPDATER_TOKEN"),
      NODE_ENV: "production",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const flagged = new Set(result.error.issues.map((i) => String(i.path[0])));
    for (const key of [
      "DATABASE_URL",
      "ENCRYPTION_KEY",
      "SESSION_SECRET",
      "ADMIN_API_KEY",
      "ADMIN_PASS",
      "UPDATER_TOKEN",
    ]) {
      expect(flagged, `${key} should be reported`).toContain(key);
    }
  });

  it.each([
    "replace-with-openssl-rand-hex-32",
    "change-me-generate-with-a-real-secret",
    "CHANGEME-but-long-enough-to-pass-min",
    "change_me_and_this_is_long_enough_ok",
  ])("rejects placeholder variant %s", (value) => {
    expect(envSchema.safeParse({ ...validEnv, SESSION_SECRET: value }).success).toBe(false);
  });

  it("explains how to generate a real value", () => {
    const result = envSchema.safeParse({
      ...validEnv,
      ENCRYPTION_KEY: "replace-with-openssl-rand-hex-32",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]!.message).toMatch(/openssl rand -hex 32/);
  });

  it("does not flag legitimate secrets that merely mention change", () => {
    /* Guards against an over-broad pattern: "exchange" contains "change". */
    const result = envSchema.safeParse({
      ...validEnv,
      SESSION_SECRET: "exchange-rate-service-signing-key-01",
    });
    expect(result.success).toBe(true);
  });

  it("accepts the values CI actually uses", () => {
    /* Regression guard: hardening env validation must not break the CI env
     * block in .github/workflows/ci.yml. */
    expect(
      envSchema.safeParse({
        DATABASE_URL: "postgresql://ci:ci@localhost:5432/ci",
        ENCRYPTION_KEY: "ci-encryption-key-that-is-at-least-32-characters",
        SESSION_SECRET: "ci-session-secret-that-is-at-least-32-characters",
        ADMIN_API_KEY: "ci-admin-api-key-that-is-at-least-32-chars-long",
        ADMIN_USER: "admin",
        ADMIN_PASS: "ci-password-at-least-8",
      }).success
    ).toBe(true);
  });

  it("accepts the in-process test fallback values", () => {
    expect(
      envSchema.safeParse({
        DATABASE_URL: "postgresql://test:test@localhost:5432/test",
        ENCRYPTION_KEY: "test-encryption-key-at-least-32-chars-long",
        SESSION_SECRET: "test-session-secret-at-least-32-chars-long",
        ADMIN_API_KEY: "test-admin-api-key-that-is-at-least-32-chars",
        ADMIN_USER: "admin",
        ADMIN_PASS: "testpassword",
        NODE_ENV: "test",
      }).success
    ).toBe(true);
  });
});
