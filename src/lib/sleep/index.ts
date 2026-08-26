// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Sleep duration computation with configurable refresh profiles.
 *
 * Priority chain:
 *   1. Battery safety
 *   2. Explicit scheduled device sleep
 *   3. Content renderer override (e.g. carousel → 60s)
 *   4. Scheduled cadence
 *   5. Event/default cadence
 *
 * Schedule rules support two modes:
 *   - "poll": Device stays awake (or light-sleeps), polls after intervalS.
 *   - "sleep": Device enters deep sleep until the rule's endHour.
 *             No polling, display off. Use for overnight/weekend rest.
 */

import { z } from "zod";
import { TZDate } from "@date-fns/tz";
import { brightnessPolicySchema } from "@/lib/settings/brightness";

export const phaseBehaviorSchema = z
  .object({
    /** Poll cadence while this phase is active for this power source. */
    intervalS: z.number().int().positive().optional(),
    /** Backlight target. Zero is deliberately distinct from powering the panel off. */
    brightnessPercent: z.number().int().min(0).max(100).optional(),
    /** Whether the physical panel should remain powered. */
    display: z.enum(["on", "off"]).optional(),
    /** Whether the controller remains active or sleeps until the phase ends. */
    device: z.enum(["awake", "sleep"]).optional(),
  })
  .superRefine((behavior, ctx) => {
    if (behavior.device === "sleep" && behavior.display === "on") {
      ctx.addIssue({
        code: "custom",
        path: ["display"],
        message: "A sleeping device cannot keep its display powered",
      });
    }
  });
export type PhaseBehavior = z.infer<typeof phaseBehaviorSchema>;

/** A time-based phase. USB and battery are intentionally independent. */
export const scheduleRuleSchema = z.object({
  /** Rule name for display in admin UI */
  name: z.string().default(""),
  /** Days this rule applies: 0=Sun, 1=Mon, ..., 6=Sat. Empty = all days. */
  days: z.array(z.number().min(0).max(6)).default([]),
  /** Start hour (0-23) */
  startHour: z.number().min(0).max(23),
  /** End hour (0-23). If < startHour, wraps past midnight. */
  endHour: z.number().min(0).max(23),
  /**
   * Legacy cadence. Kept for read compatibility only; the editor writes the
   * source-specific `usb` and `battery` branches below.
   */
  intervalS: z.number().positive().optional(),
  /**
   * Device behavior during this rule:
   * - "poll": Stay awake, refresh every intervalS seconds.
   * - "sleep": Deep sleep until endHour. No polling, display off.
   */
  mode: z.enum(["poll", "sleep"]).optional(),
  usb: phaseBehaviorSchema.optional(),
  battery: phaseBehaviorSchema.optional(),
});

export type ScheduleRule = z.infer<typeof scheduleRuleSchema>;

export const refreshProfileSchema = z.object({
  /** Version 2 is the first profile whose phases carry explicit power actions. */
  version: z.literal(2).optional(),
  usbIntervalS: z.number().default(60),
  batteryIntervalS: z.number().default(900),
  lowBatteryIntervalS: z.number().default(3600),
  lowBatteryThresholdPct: z.number().default(20),
  imminentEventWindowS: z.number().default(1200),
  wakeBeforeEventS: z.number().default(300),
  /** Legacy field. It was never consumed by firmware and must stay inert. */
  defaultMode: z.enum(["poll", "sleep"]).optional(),
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

export const unifiedRefreshProfileSchema = refreshProfileSchema.extend({
  version: z.literal(2),
  brightness: brightnessPolicySchema.extend({ schedule: z.tuple([]) }),
});

export type UnifiedRefreshProfile = z.infer<typeof unifiedRefreshProfileSchema>;

function phaseKey(rule: Pick<ScheduleRule, "days" | "startHour" | "endHour">): string {
  return `${[...rule.days].sort((a, b) => a - b).join(",")}|${rule.startHour}|${rule.endHour}`;
}

/**
 * Convert every historical profile shape into the single-phase version written
 * by the current editor. Pure and idempotent, so it is safe on reads, saves and
 * explicit data migrations alike.
 *
 * Legacy `mode=sleep` is deliberately NOT promoted. Released firmware ignored
 * that header, and changing a dormant field into an active fleet command during
 * an ordinary edit would violate backwards compatibility.
 */
export function upgradeRefreshProfileConfig(raw: unknown): UnifiedRefreshProfile {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const parsed = refreshProfileSchema.safeParse(source);
  const base = parsed.success ? parsed.data : refreshProfileSchema.parse({});
  const brightnessResult = brightnessPolicySchema.safeParse(source.brightness ?? {});
  const brightness = brightnessResult.success
    ? brightnessResult.data
    : brightnessPolicySchema.parse({});

  if (base.version === 2) {
    return unifiedRefreshProfileSchema.parse({
      ...base,
      version: 2,
      brightness: {
        usbPercent: brightness.usbPercent,
        batteryPercent: brightness.batteryPercent,
        schedule: [],
      },
    });
  }

  const phases: ScheduleRule[] = base.schedule.map((rule) => ({
    name: rule.name,
    days: rule.days,
    startHour: rule.startHour,
    endHour: rule.endHour,
    usb: rule.intervalS ? { intervalS: rule.intervalS } : {},
    battery: rule.intervalS ? { intervalS: rule.intervalS } : {},
  }));

  for (const legacy of brightness.schedule) {
    const key = phaseKey(legacy);
    let phase = phases.find((candidate) => phaseKey(candidate) === key);
    if (!phase) {
      phase = {
        name: legacy.name,
        days: legacy.days,
        startHour: legacy.startHour,
        endHour: legacy.endHour,
        usb: {},
        battery: {},
      };
      phases.push(phase);
    }
    if (legacy.percent != null) {
      phase.usb = { ...phase.usb, brightnessPercent: legacy.percent };
      phase.battery = { ...phase.battery, brightnessPercent: legacy.percent };
    }
  }

  return unifiedRefreshProfileSchema.parse({
    ...base,
    version: 2,
    defaultMode: undefined,
    schedule: phases,
    brightness: {
      usbPercent: brightness.usbPercent,
      batteryPercent: brightness.batteryPercent,
      schedule: [],
    },
  });
}

/** One layer of a cascade: only the keys it actually sets. */
export type RefreshProfilePatch = Partial<RefreshProfile>;

/**
 * Validate a cascade layer without inventing values for what it omits.
 *
 * `refreshProfileSchema.partial()` does NOT do this: every field carries a
 * `.default()`, and making the key optional on top still resolves an absent key
 * to its default. Parsing a site layer that only sets a night rule would come
 * back carrying built-in intervals for everything else, and those would then
 * outrank the profile they were supposed to leave alone. Verified, not assumed:
 * `.partial().parse({ usbIntervalS: 30 })` returns ten keys.
 *
 * So only the keys actually present are picked and parsed. A layer with one
 * malformed value is discarded whole rather than half-applied, matching what
 * parseRefreshProfile already does with a malformed profile.
 */
export function parseRefreshProfilePatch(raw: unknown): RefreshProfilePatch {
  if (!raw || typeof raw !== "object") return {};
  const source = raw as Record<string, unknown>;
  const present = (Object.keys(refreshProfileSchema.shape) as Array<keyof RefreshProfile>).filter(
    (key) => source[key] !== undefined
  );
  if (present.length === 0) return {};
  const mask = Object.fromEntries(present.map((key) => [key, true]));
  const result = refreshProfileSchema.pick(mask as never).safeParse(source);
  return result.success ? (result.data as RefreshProfilePatch) : {};
}

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

/** Which tier of the precedence chain decided the result. */
export type SleepTier =
  "renderer-override" | "low-battery" | "schedule" | "imminent-event" | "power-default";

export interface SleepResult {
  durationS: number;
  mode: "poll" | "sleep";
  /* Optional and additive: existing callers destructure durationS and mode. The
   * point is to be able to answer "why is this display polling every 15 minutes"
   * without re-deriving the chain by hand. */
  tier?: SleepTier;
  /** Name of the schedule rule that matched, when one did. */
  rule?: string;
  /** True when unassignedIntervalS shortened the tier's own answer. */
  capped?: boolean;
}

export interface DisplayPowerResult {
  state: "on" | "off";
  tier: "schedule" | "power-default";
  rule?: string;
}

export function parseRefreshProfile(raw: unknown): RefreshProfile {
  const result = refreshProfileSchema.safeParse(raw);
  return result.success ? result.data : DEFAULT_PROFILE;
}

/**
 * Day and hour as the DISPLAY experiences them.
 *
 * Without a timezone this falls back to the server's, which is what the code did
 * implicitly until now: `SleepContext.timezone` was declared and never read, so a
 * schedule looked timezone-aware while being only accidentally right. It happened
 * to be correct because the container sets TZ=Europe/Berlin, and would have gone
 * silently wrong at the first display in another zone or the first change to that
 * variable.
 */
function localParts(now: Date, timezone?: string): { day: number; hour: number } {
  if (!timezone) return { day: now.getDay(), hour: now.getHours() };
  const zoned = new TZDate(now, timezone);
  return { day: zoned.getDay(), hour: zoned.getHours() };
}

/** Check if a schedule rule matches the current time */
function matchesRule(rule: ScheduleRule, now: Date, timezone?: string): boolean {
  const { day, hour } = localParts(now, timezone);
  if (rule.startHour === rule.endHour) {
    return rule.days.length === 0 || rule.days.includes(day);
  }
  if (rule.startHour <= rule.endHour) {
    if (rule.days.length > 0 && !rule.days.includes(day)) return false;
    return hour >= rule.startHour && hour < rule.endHour;
  }
  /* For a phase that crosses midnight, 02:00 Saturday belongs to the phase
   * that STARTED Friday. Evaluating Saturday here made weekday night phases end
   * at midnight and weekend phases start six hours too early. */
  const phaseDay = hour < rule.endHour ? (day + 6) % 7 : day;
  if (rule.days.length > 0 && !rule.days.includes(phaseDay)) return false;
  return hour >= rule.startHour || hour < rule.endHour;
}

/**
 * Seconds from now until a target hour, today or tomorrow, in the display's zone.
 *
 * The zone matters more here than in matching: a rule that sleeps until 07:00 and
 * computes that hour in the wrong zone oversleeps or wakes early by the offset,
 * which on a room display is the difference between a dark panel and a booked
 * meeting at 07:00.
 */
function secondsUntilHour(now: Date, targetHour: number, timezone?: string): number {
  const target = timezone ? new TZDate(now, timezone) : new Date(now);
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
      ? { ...r, durationS: p.unassignedIntervalS, capped: true }
      : r;

  // 1. Low battery → sleep to conserve. NOT capped: a near-dead cell outranks
  // commissioning convenience, and this is the one tier meant to be slow.
  if (ctx.powerSource === "battery" && ctx.batteryLevel < p.lowBatteryThresholdPct) {
    return { durationS: p.lowBatteryIntervalS, mode: "sleep", tier: "low-battery" };
  }

  // 2. Explicit scheduled sleep outranks a renderer's preferred cadence. A
  // carousel cannot keep an LCD awake after an administrator turned the night
  // phase off, and commissioning must not wake it every five minutes either.
  if (p.version === 2) {
    for (const rule of p.schedule) {
      if (!matchesRule(rule, ctx.now, ctx.timezone)) continue;
      if (rule[ctx.powerSource]?.device === "sleep") {
        return {
          durationS: secondsUntilHour(ctx.now, rule.endHour, ctx.timezone),
          mode: "sleep",
          tier: "schedule",
          rule: rule.name || undefined,
        };
      }
    }
  }

  // 3. Content renderer override (always poll mode)
  if (ctx.rendererOverrideS != null && ctx.rendererOverrideS > 0) {
    return { durationS: ctx.rendererOverrideS, mode: "poll", tier: "renderer-override" };
  }

  // 4. Schedule phases — first matching phase that defines cadence wins. A
  // brightness-only phase must not accidentally alter polling.
  for (const rule of p.schedule) {
    if (matchesRule(rule, ctx.now, ctx.timezone)) {
      const behavior = rule[ctx.powerSource];
      const intervalS = behavior?.intervalS ?? rule.intervalS;
      if (intervalS != null) {
        const result = {
          durationS: intervalS,
          mode: "poll" as const,
          tier: "schedule" as const,
          rule: rule.name || undefined,
        };
        return behavior?.display === "off" ? result : cap(result);
      }
    }
  }

  // 4. Imminent event (poll mode — want to be ready)
  if (ctx.nextEventStart !== null) {
    const diffS = Math.floor((ctx.nextEventStart.getTime() - ctx.now.getTime()) / 1000);
    if (diffS > 0 && diffS <= p.imminentEventWindowS) {
      return {
        durationS: Math.max(diffS - p.wakeBeforeEventS, 0),
        mode: "poll",
        tier: "imminent-event",
      };
    }
  }

  // 5. Default based on power source
  const durationS = ctx.powerSource === "usb" ? p.usbIntervalS : p.batteryIntervalS;
  return cap({ durationS, mode: "poll", tier: "power-default" });
}

/** Resolve whether the panel itself should remain powered for this phase. */
export function computeDisplayPower(
  ctx: Pick<SleepContext, "powerSource" | "now" | "profile" | "timezone">
): DisplayPowerResult {
  const p = ctx.profile ?? DEFAULT_PROFILE;
  if (p.version === 2) {
    for (const rule of p.schedule) {
      if (!matchesRule(rule, ctx.now, ctx.timezone)) continue;
      const behavior = rule[ctx.powerSource];
      /* Deep sleep necessarily removes panel power. Treat an omitted display
       * field as off too, so API-written profiles cannot create an impossible
       * "controller asleep, LCD on" state. */
      const state = behavior?.device === "sleep" ? "off" : behavior?.display;
      if (state) {
        return { state, tier: "schedule", rule: rule.name || undefined };
      }
    }
  }
  return { state: "on", tier: "power-default" };
}

/** Legacy wrapper — returns just the duration in seconds */
export function computeSleepDuration(ctx: SleepContext): number {
  return computeSleep(ctx).durationS;
}

export function applyJitter(baseDuration: number, maxJitter: number = 10): number {
  return baseDuration + Math.random() * maxJitter;
}
