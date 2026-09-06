// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * What a given display should do, resolved from the layers that can say so.
 *
 * Three of these were already resolved, each in its own place and each with the
 * same shape: the device's value, else the row marked default, else a built-in.
 * Adding a site meant either repeating that a fourth time or naming the pattern
 * once. This names it.
 *
 * Layers, most general first:
 *
 *   builtin    the row marked is_default, or nothing at all
 *   site       the location's defaults, and its timezone
 *   device     the operator's decision for this one display
 *
 * The `profile` layer of the cascade is deliberately unused here. Assignments say
 * WHICH profile applies; the profile's own values are a separate resolution, and
 * conflating the two is what made the previous code hard to extend.
 */
import { cascade, type Layer, type LayerName } from "./cascade";

/** The assignments and facts a display resolves to. */
export interface DeviceSettings {
  refreshProfileId: string | null;
  themeId: string | null;
  contentInstanceId: string | null;
  /** IANA zone, or null when nothing knows it and the server clock applies. */
  timezone: string | null;
}

export interface SiteLayer {
  refreshProfileId?: string | null;
  themeId?: string | null;
  contentInstanceId?: string | null;
  timezone?: string | null;
}

export interface DeviceLayer {
  refreshProfileId?: string | null;
  themeId?: string | null;
  contentInstanceId?: string | null;
  timezone?: string | null;
}

/** The workspace-wide defaults, i.e. the rows an operator marked as default. */
export interface WorkspaceDefaults {
  refreshProfileId?: string | null;
  themeId?: string | null;
  contentInstanceId?: string | null;
}

export interface ResolvedDeviceSettings {
  values: DeviceSettings;
  from: Partial<Record<keyof DeviceSettings, LayerName>>;
}

/**
 * A null in a layer means "this layer says nothing", not "explicitly none".
 *
 * That distinction decides the whole behaviour. `devices.theme_id` is null for
 * every display that never had a theme picked, which is most of them, so treating
 * null as an explicit choice would make the device layer permanently override the
 * site with emptiness. There is deliberately no way to say "no theme, and ignore
 * the site": an operator who wants that assigns an empty theme, which is a thing
 * they can see and undo.
 */
function present<T extends object>(layer: T | null | undefined): Partial<T> {
  if (!layer) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(layer)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

export function resolveDeviceSettings(input: {
  workspace?: WorkspaceDefaults | null;
  site?: SiteLayer | null;
  device?: DeviceLayer | null;
}): ResolvedDeviceSettings {
  const base: DeviceSettings = {
    refreshProfileId: null,
    themeId: null,
    contentInstanceId: null,
    timezone: null,
  };

  const layers: Layer<DeviceSettings>[] = [
    /* The workspace default is the least specific thing that can name a value, so
     * it enters as the builtin layer rather than as one of its own. */
    { name: "builtin", values: present(input.workspace) as Partial<DeviceSettings> },
    { name: "site", values: present(input.site) as Partial<DeviceSettings> },
    { name: "device", values: present(input.device) as Partial<DeviceSettings> },
  ];

  const resolved = cascade(base, layers);
  return { values: resolved.values, from: resolved.from };
}

/** Whether a string is an IANA zone this runtime can actually resolve. */
export function isUsableTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
