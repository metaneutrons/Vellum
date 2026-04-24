/**
 * Sleep duration computation with configurable refresh profiles.
 *
 * Priority chain:
 *   1. Content renderer override (e.g. carousel → 60s)
 *   2. Schedule rule match (weekday/time-based override)
 *   3. Device refresh profile defaults
 *   4. Hardcoded fallback
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
  /** Override interval in seconds when this rule is active */
  intervalS: z.number().min(0),
});

export type ScheduleRule = z.infer<typeof scheduleRuleSchema>;

export const refreshProfileSchema = z.object({
  usbIntervalS: z.number().default(60),
  batteryIntervalS: z.number().default(900),
  lowBatteryIntervalS: z.number().default(3600),
  lowBatteryThresholdPct: z.number().default(20),
  imminentEventWindowS: z.number().default(1200),
  wakeBeforeEventS: z.number().default(300),
  /** Schedule rules — checked in order, first match wins */
  schedule: z.array(scheduleRuleSchema).default([]),
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
}

export function parseRefreshProfile(raw: unknown): RefreshProfile {
  const result = refreshProfileSchema.safeParse(raw);
  return result.success ? result.data : DEFAULT_PROFILE;
}

/** Check if a schedule rule matches the current time */
function matchesRule(rule: ScheduleRule, now: Date): boolean {
  const day = now.getDay();
  const hour = now.getHours();

  // Check day filter (empty = all days)
  if (rule.days.length > 0 && !rule.days.includes(day)) return false;

  // Check time window
  if (rule.startHour <= rule.endHour) {
    // Same-day window: e.g. 9-17
    return hour >= rule.startHour && hour < rule.endHour;
  }
  // Overnight window: e.g. 22-6
  return hour >= rule.startHour || hour < rule.endHour;
}

export function computeSleepDuration(ctx: SleepContext): number {
  const p = ctx.profile ?? DEFAULT_PROFILE;

  // 1. Content renderer override
  if (ctx.rendererOverrideS !== null && ctx.rendererOverrideS !== undefined && ctx.rendererOverrideS > 0) {
    return ctx.rendererOverrideS;
  }

  // 2. USB powered
  if (ctx.powerSource === "usb") {
    return p.usbIntervalS;
  }

  // 3. Low battery
  if (ctx.batteryLevel < p.lowBatteryThresholdPct) {
    return p.lowBatteryIntervalS;
  }

  // 4. Schedule rules — first match wins
  for (const rule of p.schedule) {
    if (matchesRule(rule, ctx.now)) {
      return rule.intervalS;
    }
  }

  // 5. Imminent event
  if (ctx.nextEventStart !== null) {
    const diffS = Math.floor((ctx.nextEventStart.getTime() - ctx.now.getTime()) / 1000);
    if (diffS > 0 && diffS <= p.imminentEventWindowS) {
      return Math.max(diffS - p.wakeBeforeEventS, 0);
    }
  }

  // 6. Default battery interval
  return p.batteryIntervalS;
}

export function applyJitter(baseDuration: number, maxJitter: number = 10): number {
  return baseDuration + Math.random() * maxJitter;
}
