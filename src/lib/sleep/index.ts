// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Sleep duration computation with configurable refresh profiles.
 *
 * Priority chain:
 *   1. Content renderer override (e.g. carousel → 60s)
 *   2. Schedule rule match (weekday/time-based override)
 *   3. Device refresh profile defaults
 *   4. Hardcoded fallback
 *
 * Schedule rules support two modes:
 *   - "poll": Device stays awake (or light-sleeps), polls after intervalS.
 *   - "sleep": Device enters deep sleep until the rule's endHour.
 *             No polling, display off. Use for overnight/weekend rest.
 */

import { z } from "zod";

/** A time-based override rule */
const scheduleRuleSchema = z.object({
  /** Rule name for display in admin UI */
  name: z.string().default(""),
  /** Days this rule applies: 0=Sun, 1=Mon, ..., 6=Sat. Empty = all days. */
  days: z.array(z.number().min(0).max(6)).default([]),
  /** Start hour (0-23) */
  startHour: z.number().min(0).max(23),
  /** End hour (0-23). If < startHour, wraps past midnight. */
  endHour: z.number().min(0).max(23),
  /** Override interval in seconds when this rule is active (used for mode=poll) */
  intervalS: z.number().min(0),
  /**
   * Device behavior during this rule:
   * - "poll": Stay awake, refresh every intervalS seconds.
   * - "sleep": Deep sleep until endHour. No polling, display off.
   */
  mode: z.enum(["poll", "sleep"]).default("poll"),
});

export type ScheduleRule = z.infer<typeof scheduleRuleSchema>;

export const refreshProfileSchema = z.object({
  usbIntervalS: z.number().default(60),
  batteryIntervalS: z.number().default(900),
  lowBatteryIntervalS: z.number().default(3600),
  lowBatteryThresholdPct: z.number().default(20),
  imminentEventWindowS: z.number().default(1200),
  wakeBeforeEventS: z.number().default(300),
  /** Default mode when no schedule rule matches */
  defaultMode: z.enum(["poll", "sleep"]).default("sleep"),
  /** Schedule rules — checked in order, first match wins */
  schedule: z.array(scheduleRuleSchema).default([]),
  /**
   * Retry ladder, in seconds, walked on consecutive failed render cycles: the
   * first failure waits `errorBackoffS[0]`, the second `[1]`, and so on, holding
   * at the last rung.
   *
   * It replaces doubling the normal cadence, which made recovery *worse* the
   * slower the profile: on a 15-minute battery cadence, a single failed cycle
   * pushed the next attempt out to 30 minutes, so a display that dropped one
   * request stayed stale for half an hour. A ladder that starts well below the
   * cadence recovers in a minute and still backs off to hourly if the server is
   * genuinely gone.
   *
   * Not sent when empty — the device then keeps its normal cadence on failure,
   * which is the safe direction (retries too often, never too rarely).
   */
  errorBackoffS: z.array(z.number().int().positive()).max(8).default([60, 300, 900, 3600]),
  /**
   * Ceiling on the refresh interval while a display has no content assigned.
   *
   * Commissioning is the one moment an operator is standing in front of the
   * display waiting for it to react, and it used to be the slowest: the render
   * route answered 204 before computing any cadence, so the device fell back to
   * its firmware default of 900s and the profile never applied at all.
   *
   * A ceiling rather than its own interval, so it inherits the USB / battery
   * tiers below instead of duplicating them — it can only make a display more
   * responsive, never less. The low-battery tier is exempt (see computeSleep):
   * protecting a critical cell outranks commissioning convenience.
   *
   * 300s matches VELLUM_APPROVAL_POLL_SEC in the firmware, which is already the
   * cadence for the analogous "enrolled but waiting for an operator" state.
   */
  unassignedIntervalS: z.number().int().positive().default(300),
});

export type RefreshProfile = z.infer<typeof refreshProfileSchema>;

const DEFAULT_PROFILE: RefreshProfile = refreshProfileSchema.parse({});

export interface SleepContext {
  powerSource: "usb" | "battery";
  batteryLevel: number;
  nextEventStart: Date | null;
  now: Date;
  profile?: RefreshProfile | null;
  rendererOverrideS?: number | null;
  timezone?: string;
  /**
   * False while the display has nothing assigned to render. Caps the result at
   * `unassignedIntervalS` so assigning content during setup takes effect
   * promptly. Defaults to true: a caller that does not know cannot accidentally
   * make a configured display poll faster than its profile asks.
   */
  hasContent?: boolean;
}

export interface SleepResult {
  durationS: number;
  mode: "poll" | "sleep";
}

export function parseRefreshProfile(raw: unknown): RefreshProfile {
  const result = refreshProfileSchema.safeParse(raw);
  return result.success ? result.data : DEFAULT_PROFILE;
}

/** Check if a schedule rule matches the current time */
function matchesRule(rule: ScheduleRule, now: Date): boolean {
  const day = now.getDay();
  const hour = now.getHours();

  if (rule.days.length > 0 && !rule.days.includes(day)) return false;

  if (rule.startHour <= rule.endHour) {
    return hour >= rule.startHour && hour < rule.endHour;
  }
  return hour >= rule.startHour || hour < rule.endHour;
}

/** Compute seconds from now until a target hour (today or tomorrow) */
function secondsUntilHour(now: Date, targetHour: number): number {
  const target = new Date(now);
  target.setHours(targetHour, 0, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return Math.floor((target.getTime() - now.getTime()) / 1000);
}

export function computeSleep(ctx: SleepContext): SleepResult {
  const p = ctx.profile ?? DEFAULT_PROFILE;

  /* A display with nothing assigned is being commissioned, which is exactly when
   * an operator is waiting on it — so cap whatever the tiers below decide. Only
   * ever shortens: `min` cannot make a configured display slower. Applied to the
   * result rather than as a separate interval so it inherits the USB / battery
   * distinction instead of duplicating it. */
  const awaitingContent = ctx.hasContent === false;
  const cap = (r: SleepResult): SleepResult =>
    awaitingContent && r.durationS > p.unassignedIntervalS
      ? { durationS: p.unassignedIntervalS, mode: r.mode }
      : r;

  // 1. Content renderer override (always poll mode)
  if (ctx.rendererOverrideS != null && ctx.rendererOverrideS > 0) {
    return { durationS: ctx.rendererOverrideS, mode: "poll" };
  }

  // 2. Low battery → sleep to conserve. NOT capped: a near-dead cell outranks
  // commissioning convenience, and this is the one tier meant to be slow.
  if (ctx.powerSource === "battery" && ctx.batteryLevel < p.lowBatteryThresholdPct) {
    return { durationS: p.lowBatteryIntervalS, mode: "sleep" };
  }

  // 3. Schedule rules — first match wins
  for (const rule of p.schedule) {
    if (matchesRule(rule, ctx.now)) {
      if (rule.mode === "sleep") {
        // Sleep until the rule's endHour
        return cap({ durationS: secondsUntilHour(ctx.now, rule.endHour), mode: "sleep" });
      }
      return cap({ durationS: rule.intervalS, mode: "poll" });
    }
  }

  // 4. Imminent event (poll mode — want to be ready)
  if (ctx.nextEventStart !== null) {
    const diffS = Math.floor((ctx.nextEventStart.getTime() - ctx.now.getTime()) / 1000);
    if (diffS > 0 && diffS <= p.imminentEventWindowS) {
      return { durationS: Math.max(diffS - p.wakeBeforeEventS, 0), mode: "poll" };
    }
  }

  // 5. Default based on power source
  const durationS = ctx.powerSource === "usb" ? p.usbIntervalS : p.batteryIntervalS;
  return cap({ durationS, mode: p.defaultMode });
}

/** Legacy wrapper — returns just the duration in seconds */
export function computeSleepDuration(ctx: SleepContext): number {
  return computeSleep(ctx).durationS;
}

export function applyJitter(baseDuration: number, maxJitter: number = 10): number {
  return baseDuration + Math.random() * maxJitter;
}
