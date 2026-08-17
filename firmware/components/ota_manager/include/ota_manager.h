// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file ota_manager.h
 * @brief Over-the-air firmware update with SHA-256 + Ed25519 verification.
 */
#pragma once

typedef enum {
    /** No update was attempted, or an update was applied and the device restarts. */
    OTA_CHECK_NO_RESTORE = 0,
    /** An update failed after taking over the display; caller must render normal content. */
    OTA_CHECK_RESTORE_RENDER,
} ota_check_result_t;

/**
 * Query the backend /config endpoint for an available update and, if present,
 * download it over HTTPS, verify its SHA-256 and Ed25519 signature, and apply
 * it — restarting the device on success. Failed post-download validation is
 * rate-limited and returns OTA_CHECK_RESTORE_RENDER after the error was shown.
 */
ota_check_result_t ota_manager_check_and_apply(void);

/**
 * Confirm the running image is good, cancelling bootloader rollback.
 * Call once early after a successful server round-trip (hello + render). If the
 * running image is PENDING_VERIFY and this is never called, the bootloader
 * rolls back to the previous image on the next boot.
 */
void ota_manager_mark_valid(void);

/** Report a rollback recovered during boot once device authentication is ready. */
void ota_manager_report_deferred_configuration(void);
