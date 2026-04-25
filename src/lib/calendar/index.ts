/**
 * Calendar module — re-exports for clean imports.
 */

export type { CalendarEvent, CalendarProvider } from "./types";
export { getCalendarProvider, getAllCalendarProviders } from "./registry";
export { applyRoomPolicy } from "./policy";
