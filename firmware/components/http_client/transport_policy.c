// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#include "transport_policy.h"

#include <stdint.h>
#include <string.h>

static bool parse_ipv4_host(const char *host, uint8_t octets[4])
{
    for (int i = 0; i < 4; ++i) {
        if (*host < '0' || *host > '9') return false;

        unsigned value = 0;
        int digits = 0;
        while (*host >= '0' && *host <= '9') {
            value = value * 10U + (unsigned)(*host - '0');
            if (value > 255U || ++digits > 3) return false;
            ++host;
        }
        octets[i] = (uint8_t)value;

        if (i < 3) {
            if (*host++ != '.') return false;
        }
    }

    /* Only an optional numeric port and path may follow the IPv4 literal. */
    if (*host == ':') {
        ++host;
        unsigned port = 0;
        int digits = 0;
        while (*host >= '0' && *host <= '9') {
            port = port * 10U + (unsigned)(*host - '0');
            if (port > 65535U || ++digits > 5) return false;
            ++host;
        }
        if (digits == 0 || port == 0) return false;
    }
    return *host == '\0' || *host == '/';
}

bool vellum_transport_url_allowed(const char *url, bool allow_private_http)
{
    if (!url) return false;
    if (strncmp(url, "https://", 8) == 0) return true;
    if (!allow_private_http || strncmp(url, "http://", 7) != 0) return false;

    uint8_t ip[4];
    if (!parse_ipv4_host(url + 7, ip)) return false;

    return ip[0] == 10 ||
           (ip[0] == 172 && ip[1] >= 16 && ip[1] <= 31) ||
           (ip[0] == 192 && ip[1] == 168);
}
