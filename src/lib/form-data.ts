// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Reading text out of a `FormData` without trusting that it is text.
 *
 * `FormData.get()` returns `string | File | null`, because a multipart request
 * decides the shape, not the server. `String(...)` on the File branch yields the
 * literal `"[object File]"` — a value that looks like input, passes a non-empty
 * check, and is identical for every caller.
 *
 * That is not hypothetical here. The invitation flow read a password with
 * `String(formData.get("password") ?? "")`, so a request sending a file field
 * instead of a text field would have set the account's password to
 * `"[object File]"`: predictable, and identical across accounts.
 */

/** The field as text, or `""` when it is absent or was not sent as text. */
export function formString(form: FormData, field: string): string {
  const value = form.get(field);
  return typeof value === "string" ? value : "";
}

/** Like {@link formString}, trimmed — the usual shape for a name or an address. */
export function formTrimmed(form: FormData, field: string): string {
  return formString(form, field).trim();
}

/**
 * The field as text, or `null` when it is absent or was not sent as text.
 *
 * Distinguishes "not supplied" from "supplied empty", which `formString` cannot:
 * an optional field that clears a stored value needs that difference.
 */
export function formStringOrNull(form: FormData, field: string): string | null {
  const value = form.get(field);
  return typeof value === "string" ? value : null;
}
