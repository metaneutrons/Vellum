// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { env } from "@/lib/env";
import { z } from "zod";
import type { UpdateProgress } from "@/lib/update-progress";

export type ServerUpdateStatus = {
  supported: boolean;
  availabilityReason: "ready" | "not-configured" | "unreachable" | "invalid-response";
  state:
    | "unavailable"
    | "starting"
    | "checking"
    | "preparing"
    | "available"
    | "updating"
    | "current"
    | "failed";
  currentVersion: string | null;
  availableVersion: string | null;
  updateAvailable: boolean;
  updateMode: "manual" | "automatic";
  maintenanceTime: string;
  timezone: string;
  lastCheckedAt: string | null;
  lastCheckAttemptAt: string | null;
  lastUpdatedAt: string | null;
  lastError: string | null;
  releaseCheckStatus: "ok" | "degraded";
  releaseCheckError:
    | "upstream-timeout"
    | "upstream-unavailable"
    | "rate-limited"
    | "invalid-response"
    | "network-error"
    | "request-rejected"
    | null;
  releaseCheckRetryAt: string | null;
  /** The updater sidecar's own image version, or null when it does not report
   * one — which itself means it predates version reporting and is outdated. The
   * capability fields distinguish a legacy updater needing a one-time bootstrap
   * from a current updater that can hand replacement to its detached helper. */
  updaterVersion: string | null;
  updaterUpdateAvailable: boolean;
  updaterSelfUpdateCapable: boolean;
  updaterSelfUpdateEnabled: boolean;
  /** Outcome of the last updater self-update, reported by the updater that
   * replaced the one which performed it. Null when none has run. */
  updaterSwap: {
    outcome: "succeeded" | "failed" | "rolled-back";
    detail: string | null;
    at: string | null;
  } | null;
  /** Which step the updater is on. The server cannot report its own restart, so
   * this journal — written by the updater and read back after the container is
   * up again — is the only progress the UI can show. */
  progress: UpdateProgress | null;
};

function unavailable(
  availabilityReason: Exclude<ServerUpdateStatus["availabilityReason"], "ready">
): ServerUpdateStatus {
  return {
    supported: false,
    availabilityReason,
    state: "unavailable",
    currentVersion: null,
    availableVersion: null,
    updateAvailable: false,
    updateMode: "manual",
    maintenanceTime: "02:00",
    timezone: "UTC",
    lastCheckedAt: null,
    lastCheckAttemptAt: null,
    lastUpdatedAt: null,
    lastError: null,
    releaseCheckStatus: "ok",
    releaseCheckError: null,
    releaseCheckRetryAt: null,
    updaterVersion: null,
    updaterUpdateAvailable: false,
    updaterSelfUpdateCapable: false,
    updaterSelfUpdateEnabled: false,
    updaterSwap: null,
    progress: null,
  };
}

const statusSchema = z.object({
  state: z.enum([
    "starting",
    "checking",
    "preparing",
    "available",
    "updating",
    "current",
    "failed",
  ]),
  currentVersion: z.string().nullable(),
  availableVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
  updateMode: z.enum(["manual", "automatic"]),
  maintenanceTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timezone: z.string().min(1).max(100),
  lastCheckedAt: z.iso.datetime().nullable(),
  lastCheckAttemptAt: z.iso.datetime().nullable().optional(),
  lastUpdatedAt: z.iso.datetime().nullable(),
  lastError: z.string().max(500).nullable(),
  releaseCheckStatus: z.enum(["ok", "degraded"]).optional(),
  releaseCheckError: z
    .enum([
      "upstream-timeout",
      "upstream-unavailable",
      "rate-limited",
      "invalid-response",
      "network-error",
      "request-rejected",
    ])
    .nullable()
    .optional(),
  releaseCheckRetryAt: z.iso.datetime().nullable().optional(),
  /* Optional on purpose: the currently deployed updater predates these fields,
   * and a strict schema would reject its whole payload and report the update
   * system as unavailable. */
  updaterVersion: z.string().max(64).nullable().optional(),
  updaterUpdateAvailable: z.boolean().optional(),
  updaterSelfUpdateCapable: z.boolean().optional(),
  updaterSelfUpdateEnabled: z.boolean().optional(),
  updaterSwap: z
    .object({
      outcome: z.enum(["succeeded", "failed", "rolled-back"]),
      detail: z.string().max(300).nullable(),
      at: z.string().nullable(),
    })
    .nullable()
    .optional(),
  progress: z
    .object({
      phase: z.enum([
        "verifying",
        "backing-up",
        "deploying",
        "waiting-for-health",
        "done",
        "rolling-back",
        "failed",
      ]),
      detail: z.string().max(200).nullable(),
      at: z.string().nullable(),
      startedAt: z.string().nullable(),
      failedPhase: z
        .enum([
          "verifying",
          "backing-up",
          "deploying",
          "waiting-for-health",
          "done",
          "rolling-back",
          "failed",
        ])
        .nullable()
        .optional(),
      rollbackAttempted: z.boolean().optional(),
    })
    .nullable()
    .optional(),
});

async function request(path: string, method = "GET", body?: unknown): Promise<ServerUpdateStatus> {
  if (!env.UPDATER_URL || !env.UPDATER_TOKEN) return unavailable("not-configured");
  try {
    const response = await fetch(new URL(path, env.UPDATER_URL), {
      method,
      headers: {
        Authorization: `Bearer ${env.UPDATER_TOKEN}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok && response.status !== 202 && response.status !== 409)
      return unavailable(response.status >= 500 ? "unreachable" : "invalid-response");
    const raw = (await response.json().catch(() => null)) as { status?: unknown } | null;
    if (!raw) return unavailable("invalid-response");
    const value = raw.status ?? raw;
    const parsed = statusSchema.safeParse(value);
    if (!parsed.success) return unavailable("invalid-response");
    return {
      ...parsed.data,
      supported: true,
      availabilityReason: "ready",
      updaterVersion: parsed.data.updaterVersion ?? null,
      lastCheckAttemptAt: parsed.data.lastCheckAttemptAt ?? parsed.data.lastCheckedAt,
      releaseCheckStatus: parsed.data.releaseCheckStatus ?? "ok",
      releaseCheckError: parsed.data.releaseCheckError ?? null,
      releaseCheckRetryAt: parsed.data.releaseCheckRetryAt ?? null,
      updaterUpdateAvailable: parsed.data.updaterUpdateAvailable ?? false,
      updaterSelfUpdateCapable: parsed.data.updaterSelfUpdateCapable ?? false,
      updaterSelfUpdateEnabled: parsed.data.updaterSelfUpdateEnabled ?? false,
      updaterSwap: parsed.data.updaterSwap ?? null,
      progress: parsed.data.progress ?? null,
    };
  } catch {
    return unavailable("unreachable");
  }
}

export const getServerUpdateStatus = () => request("/v1/status");
export const requestServerUpdateCheck = () => request("/v1/check", "POST");
export const requestServerUpdate = () => request("/v1/apply", "POST");
export const configureServerUpdates = (config: {
  mode: "manual" | "automatic";
  maintenanceTime: string;
  timezone: string;
}) => request("/v1/config", "POST", config);
