/**
 * Calendar provider registry — maps provider types to implementations.
 */

import type { CalendarProvider } from "./types";
import { microsoft365Provider } from "./providers/microsoft365";
import { googleProvider } from "./providers/google";
import { icalProvider } from "./providers/ical";

const providers = new Map<string, CalendarProvider>();

function register(provider: CalendarProvider) {
  providers.set(provider.type, provider);
}

register(microsoft365Provider);
register(googleProvider);
register(icalProvider);

export function getCalendarProvider(type: string): CalendarProvider | undefined {
  return providers.get(type);
}

export function getAllCalendarProviders(): CalendarProvider[] {
  return [...providers.values()];
}
