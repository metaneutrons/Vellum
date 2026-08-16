// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.

export const FLASH_MODEL_STORAGE_KEY = "vellum-firmware-flash-model";

/**
 * Restore a saved USB-flash target without allowing a stale/unknown model to
 * escape the current display registry. The registry order defines the UI's
 * deterministic default.
 */
export function resolveFlashModel(
  storedModel: string | null,
  availableModels: readonly string[]
): string {
  if (storedModel && availableModels.includes(storedModel)) return storedModel;
  return availableModels[0] ?? "";
}
