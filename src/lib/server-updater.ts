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
};

const unavailable: ServerUpdateStatus = { supported: false, state: "unavailable", currentVersion: null,
  availableVersion: null, updateAvailable: false, updateMode: "manual", maintenanceTime: "02:00", timezone: "UTC", lastCheckedAt: null,
  lastUpdatedAt: null, lastError: null };

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
    return parsed.success ? { ...parsed.data, supported: true } : unavailable;
  } catch {
    return unavailable;
  }
}

export const getServerUpdateStatus = () => request("/v1/status");
export const requestServerUpdateCheck = () => request("/v1/check", "POST");
export const requestServerUpdate = () => request("/v1/apply", "POST");
export const configureServerUpdates = (config: { mode: "manual" | "automatic"; maintenanceTime: string; timezone: string }) =>
  request("/v1/config", "POST", config);
