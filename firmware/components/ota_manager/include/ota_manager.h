// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file ota_manager.h
 * @brief Over-the-air firmware update with SHA-256 + Ed25519 verification.
 */
#pragma once

/**
 * Query the backend /config endpoint for an available update and, if present,
 * download it over HTTPS, verify its SHA-256 and Ed25519 signature, and apply
 * it — restarting the device on success. No-op when no update is offered.
 */
void ota_manager_check_and_apply(void);

/**
 * Confirm the running image is good, cancelling bootloader rollback.
 * Call once early after a successful server round-trip (hello + render). If the
 * running image is PENDING_VERIFY and this is never called, the bootloader
 * rolls back to the previous image on the next boot.
 */
void ota_manager_mark_valid(void);
