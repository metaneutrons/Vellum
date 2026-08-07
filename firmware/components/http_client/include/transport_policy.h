// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#pragma once

#include <stdbool.h>

/**
 * Whether a backend URL is permitted by the selected build policy.
 * HTTPS is always accepted. Development HTTP is restricted to an RFC1918 IPv4
 * literal so enabling it cannot silently permit plaintext public endpoints.
 */
bool vellum_transport_url_allowed(const char *url, bool allow_private_http);
