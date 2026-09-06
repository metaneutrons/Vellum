// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Reading values out of an untyped record without asserting their type.
 *
 * Content instances, refresh profiles and the settings table keep their options
 * in a jsonb column, and a JSON:API provider answers with an open attributes bag.
 * What arrives is `Record<string, unknown>` — whatever was written, by whichever
 * version of the app wrote it.
 *
 * `config.x as string` claims a shape the source cannot promise, and the claim
 * defeats its own safety net: the assertion removes `undefined` from the type, so
 * the `?? fallback` written right behind it can never fire. A value stored as a
 * number then reaches a text input as a number. These readers check instead of
 * claiming, which makes the fallback answer a wrong type as well as a missing key.
 */

/** The field as text, or `fallback` when it is absent or is not text. */
export function recordString(source: Record<string, unknown>, key: string, fallback = ""): string {
  const value = source[key];
  return typeof value === "string" ? value : fallback;
}

/**
 * The field as a finite number, or `fallback`.
 *
 * NaN and Infinity count as absent. Neither survives arithmetic, and a number
 * input given either renders empty, so treating them as present would only move
 * the failure somewhere less obvious.
 */
export function recordNumber(
  source: Record<string, unknown>,
  key: string,
  fallback: number
): number {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** The field as a boolean, or `fallback` when it is absent or is not one. */
export function recordBoolean(
  source: Record<string, unknown>,
  key: string,
  fallback = false
): boolean {
  const value = source[key];
  return typeof value === "boolean" ? value : fallback;
}

/**
 * The value as a record, or an empty one.
 *
 * An array is not a record here. Reading a named field off one yields undefined
 * for every key, so the readers above would answer with their fallback anyway,
 * and saying so up front keeps that out of the call site.
 */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
