// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Layered settings resolution.
 *
 * Vellum settings arrive from several places at once: built-in defaults, a site,
 * a profile, and an operator's decision for one display. Until now each feature
 * resolved that on its own, and `computeSleep` additionally mixed resolution
 * together with evaluating the result against runtime state. Adding a second
 * scheduled setting would have duplicated the mixing, and a third would have
 * duplicated it again.
 *
 * Two operations, kept apart on purpose:
 *
 *   cascade over configuration  ->  one resolved policy
 *   evaluate against state      ->  concrete numbers for this display, now
 *
 * This module is the first half. It is deliberately small and boring: a shallow
 * merge with provenance. The interesting decisions are which layers exist and in
 * what order, and those belong to the caller.
 */

/** Layers, ordered from most general to most specific. Later wins. */
export type LayerName = "builtin" | "site" | "profile" | "device";

export const LAYER_ORDER: readonly LayerName[] = ["builtin", "site", "profile", "device"];

export interface Layer<T> {
  name: LayerName;
  /** Only the keys this layer actually sets. See the note on `undefined` below. */
  values: Partial<T> | null | undefined;
}

export interface Resolved<T> {
  values: T;
  /**
   * Which layer supplied each key.
   *
   * Not decoration: a cascade is only usable if the interface can answer "why is
   * this display at 20 percent?" with "the profile's night rule". Without that,
   * every layered system becomes a guessing game, and the guessing is what makes
   * operators distrust it.
   */
  from: Partial<Record<keyof T, LayerName>>;
}

/**
 * Merge `layers` onto `base`, most general first.
 *
 * Shallow by design. Arrays and nested objects replace wholesale rather than
 * merging element-wise, because "does a site's schedule extend the profile's or
 * replace it?" has no answer an operator can predict. Replacement is the rule
 * that fits in one sentence, and a rule that fits in one sentence is one they can
 * hold while debugging a display at 23:00.
 *
 * A key set to `undefined` does not overwrite. A layer that stays silent about a
 * setting must leave it alone, which is why layers have to be validated with a
 * PARTIAL schema: a full parse would fill every absent key with its default and
 * the layer would silently reset everything it never mentioned.
 */
export function cascade<T extends object>(base: T, layers: Array<Layer<T>>): Resolved<T> {
  const values = { ...base };
  const from: Partial<Record<keyof T, LayerName>> = {};
  for (const key of Object.keys(base) as Array<keyof T>) {
    from[key] = "builtin";
  }

  for (const name of LAYER_ORDER) {
    for (const layer of layers) {
      if (layer.name !== name || !layer.values) continue;
      for (const [rawKey, value] of Object.entries(layer.values)) {
        if (value === undefined) continue;
        const key = rawKey as keyof T;
        values[key] = value as T[keyof T];
        from[key] = name;
      }
    }
  }

  return { values, from };
}

/** Human-readable provenance for one key, for the admin UI and for logs. */
export function explainKey<T extends object>(resolved: Resolved<T>, key: keyof T): string {
  const layer = resolved.from[key] ?? "builtin";
  const value = resolved.values[key];
  return `${String(key)}=${JSON.stringify(value)} (${layer})`;
}
