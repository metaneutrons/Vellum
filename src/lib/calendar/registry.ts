// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Calendar provider registry — maps provider types to implementations.
 */

import type { CalendarProvider } from "./types";
import { microsoft365Provider } from "./providers/microsoft365";
import { googleProvider } from "./providers/google";
import { icalProvider } from "./providers/ical";
import { annyProvider } from "./providers/anny";

const providers = new Map<string, CalendarProvider>();

function register(provider: CalendarProvider) {
  providers.set(provider.type, provider);
}

register(microsoft365Provider);
register(googleProvider);
register(icalProvider);
register(annyProvider);

export function getCalendarProvider(type: string): CalendarProvider | undefined {
  return providers.get(type);
}

export function getAllCalendarProviders(): CalendarProvider[] {
  return [...providers.values()];
}
