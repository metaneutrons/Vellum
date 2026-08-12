// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { env } from "@/lib/env";
import { z } from "zod";

export type ServerUpdateStatus = {
  supported: boolean;
  state: "unavailable" | "starting" | "checking" | "available" | "updating" | "current" | "failed";
  currentVersion: string | null;
  availableVersion: string | null;
  updateAvailable: boolean;
  updateMode: "manual" | "automatic";
  maintenanceTime: string;
  timezone: string;
  lastCheckedAt: string | null;
  lastUpdatedAt: string | null;
  lastError: string | null;
  /** The updater sidecar's own image version, or null when it does not report
   * one — which itself means it predates version reporting and is outdated. The
   * updater never replaces its own container, so this is the only signal an
   * operator gets that the component holding the Docker socket has fallen
   * behind. See docs/DOCKER_DEPLOYMENT.md for the deliberate manual swap. */
  updaterVersion: string | null;
  updaterUpdateAvailable: boolean;
  /** Outcome of the last updater self-update, reported by the updater that
   * replaced the one which performed it. Null when none has run. */
  updaterSwap: { outcome: "succeeded" | "failed" | "rolled-back"; detail: string | null; at: string | null } | null;
  /** Which step the updater is on. The server cannot report its own restart, so
   * this journal — written by the updater and read back after the container is
   * up again — is the only progress the UI can show. */
  progress: {
    phase: "verifying" | "backing-up" | "deploying" | "waiting-for-health" | "done" | "rolling-back" | "failed";
    detail: string | null;
    at: string | null;
    startedAt: string | null;
  } | null;
};

const unavailable: ServerUpdateStatus = { supported: false, state: "unavailable", currentVersion: null,
  availableVersion: null, updateAvailable: false, updateMode: "manual", maintenanceTime: "02:00", timezone: "UTC", lastCheckedAt: null,
  lastUpdatedAt: null, lastError: null, updaterVersion: null, updaterUpdateAvailable: false, updaterSwap: null, progress: null };

const statusSchema = z.object({
  state: z.enum(["starting", "checking", "available", "updating", "current", "failed"]),
  currentVersion: z.string().nullable(),
  availableVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
  updateMode: z.enum(["manual", "automatic"]),
  maintenanceTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timezone: z.string().min(1).max(100),
  lastCheckedAt: z.string().datetime().nullable(),
  lastUpdatedAt: z.string().datetime().nullable(),
  lastError: z.string().max(500).nullable(),
  /* Optional on purpose: the currently deployed updater predates these fields,
   * and a strict schema would reject its whole payload and report the update
   * system as unavailable. */
  updaterVersion: z.string().max(64).nullable().optional(),
  updaterUpdateAvailable: z.boolean().optional(),
  updaterSwap: z.object({
    outcome: z.enum(["succeeded", "failed", "rolled-back"]),
    detail: z.string().max(300).nullable(),
    at: z.string().nullable(),
  }).nullable().optional(),
  progress: z.object({
    phase: z.enum(["verifying", "backing-up", "deploying", "waiting-for-health", "done", "rolling-back", "failed"]),
    detail: z.string().max(200).nullable(),
    at: z.string().nullable(),
    startedAt: z.string().nullable(),
  }).nullable().optional(),
});

async function request(path: string, method = "GET", body?: unknown): Promise<ServerUpdateStatus> {
  if (!env.UPDATER_URL || !env.UPDATER_TOKEN) return unavailable;
  try {
    const response = await fetch(new URL(path, env.UPDATER_URL), {
      method,
      headers: { Authorization: `Bearer ${env.UPDATER_TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok && response.status !== 202 && response.status !== 409) return unavailable;
    const raw = await response.json() as { status?: unknown };
    const value = raw.status ?? raw;
    const parsed = statusSchema.safeParse(value);
    if (!parsed.success) return unavailable;
    return {
      ...parsed.data,
      supported: true,
      updaterVersion: parsed.data.updaterVersion ?? null,
      updaterUpdateAvailable: parsed.data.updaterUpdateAvailable ?? false,
      updaterSwap: parsed.data.updaterSwap ?? null,
      progress: parsed.data.progress ?? null,
    };
  } catch {
    return unavailable;
  }
}

export const getServerUpdateStatus = () => request("/v1/status");
export const requestServerUpdateCheck = () => request("/v1/check", "POST");
export const requestServerUpdate = () => request("/v1/apply", "POST");
export const configureServerUpdates = (config: { mode: "manual" | "automatic"; maintenanceTime: string; timezone: string }) =>
  request("/v1/config", "POST", config);
