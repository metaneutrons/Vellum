// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/** Permission registry shared by server enforcement and read-only UI labels. */
export const PERMISSIONS = [
  "dashboard.read",
  "devices.read", "devices.manage", "devices.approve", "devices.provision",
  "content.read", "content.manage", "themes.manage", "profiles.manage",
  "providers.read", "providers.manage", "providers.manage_secrets",
  "firmware.read", "firmware.flash", "firmware.rollout",
  "access.read", "access.manage", "audit.read", "system.update",
] as const;

export type Permission = (typeof PERMISSIONS)[number];
