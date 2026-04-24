e# Implementation Plan: Vellum Display System

## Overview

Incremental implementation of the Vellum backend (Next.js 16.1 App Router) and firmware (ESP32-S3). Tasks are ordered so each step builds on the previous, with property tests placed close to the code they validate. The backend is implemented first since it can be developed and tested independently, followed by firmware.

## Tasks

- [x] 1. Initialize Next.js project and core infrastructure
  - [x] 1.1 Scaffold Next.js 16.1 project with App Router, TypeScript, and ESLint
    - Initialize with `create-next-app` using App Router
    - Install dependencies: `drizzle-orm@0.45.1`, `pg@8.18.0`, `zod@4.3.6`, `@napi-rs/canvas@0.1.92`, `date-fns@4.1.0`, `@date-fns/tz@1.4.1`, `@microsoft/microsoft-graph-client@3.0.7`, `@azure/identity@4.13.0`
    - Install dev dependencies: `vitest@4.0.18`, `fast-check@4.5.3`, `drizzle-kit@0.31.9`
    - Configure `vitest.config.ts`
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [x] 1.2 Define Drizzle ORM schema and database connection
    - Create `db/schema.ts` with `devices`, `telemetry`, and `reports` tables using pgEnum for `device_status` and `room_policy`
    - Create `db/index.ts` with database connection using `DATABASE_URL` env var
    - Create `drizzle.config.ts` for migrations
    - _Requirements: 3.2, 7.2_

  - [x] 1.3 Define shared TypeScript types and Zod validation schemas
    - Create `lib/types.ts` with `RoomPolicy`, `DeviceStatus`, `DisplayEvent`, `RenderContext`, `ApiResponse`, `CalendarEvent`, `SleepContext`, `TelemetryEntry` types
    - Create `lib/validation.ts` with `macSchema`, `helloRequestSchema`, `reportRequestSchema`, `renderQuerySchema`
    - Create `lib/api-response.ts` with `okResponse()` and `errorResponse()` helper functions
    - _Requirements: 10.5, 10.6_

- [x] 2. Implement API response envelope and validation utilities
  - [x] 2.1 Implement API response helpers and request validation
    - Implement `okResponse<T>(data)` and `errorResponse(message)` in `lib/api-response.ts`
    - Implement `validateRequest(schema, data)` utility that returns 400 with descriptive error on Zod validation failure
    - _Requirements: 10.5, 10.6_

  - [x] 2.2 Write property tests for API response envelope
    - **Property 15: All JSON responses use consistent envelope format**
    - **Validates: Requirements 10.6**

  - [x] 2.3 Write property test for API response serialization round-trip
    - **Property 16: API response serialization round-trip**
    - **Validates: Requirements 10.7**

- [x] 3. Implement TOFU authentication module
  - [x] 3.1 Implement `handleHello`, `approveDevice`, and `validateToken` in `lib/auth/`
    - `handleHello(mac)`: insert new device as "pending" if unknown, return token if approved
    - `approveDevice(mac)`: generate token via `crypto.randomBytes(32)`, update status to "approved"
    - `validateToken(mac, token)`: query device by mac, compare token
    - _Requirements: 3.2, 3.3, 3.6_

  - [x] 3.2 Write property tests for TOFU auth
    - **Property 10: Unknown MAC registration creates pending device**
    - **Validates: Requirements 3.2**
    - **Property 11: Approved device receives token on next hello**
    - **Validates: Requirements 3.3**
    - **Property 12: Invalid or missing token returns 401**
    - **Validates: Requirements 3.6**

- [x] 4. Implement calendar integration module
  - [x] 4.1 Implement Microsoft Graph client and event fetching in `lib/calendar/`
    - Create `getGraphClient()` using `ClientSecretCredential` with env vars `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`
    - Implement `fetchRoomEvents(roomEmail, windowHours)` to call Graph calendarView endpoint
    - Parse Graph API response into `CalendarEvent[]`
    - _Requirements: 4.1, 4.2_

  - [x] 4.2 Implement `applyRoomPolicy` function in `lib/calendar/policy.ts`
    - "Show All": public events keep subject/organizer; private events get "Booked by [Organizer]" + lock icon
    - "Hide Subject": all events get "Reserved" subject, time preserved
    - "Hide All": return only FREE/BUSY indicator, no event details
    - _Requirements: 4.3, 4.4, 4.5, 4.6_

  - [x] 4.3 Implement timezone conversion utility in `lib/calendar/timezone.ts`
    - Use `date-fns` v4 with `@date-fns/tz` (`TZDate`) to convert UTC times to room-configured timezone
    - _Requirements: 4.7_

  - [x] 4.4 Write property tests for room policy application
    - **Property 1: Room policy transforms public and private events correctly under "Show All"**
    - **Validates: Requirements 4.3, 4.4**
    - **Property 2: "Hide Subject" policy replaces all subjects with "Reserved"**
    - **Validates: Requirements 4.5**
    - **Property 3: "Hide All" policy produces only FREE/BUSY status**
    - **Validates: Requirements 4.6**

  - [x] 4.5 Write property test for timezone conversion round-trip
    - **Property 4: Timezone conversion round-trip**
    - **Validates: Requirements 4.7**

- [x] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement sleep scheduler
  - [x] 6.1 Implement `computeSleepDuration` and `applyJitter` in `lib/sleep/`
    - Priority logic: USB → 60s, battery < 20% → 3600s, meeting within 20min → wake 5min before, default → 900s
    - `applyJitter(base, maxJitter=10)` adds random offset in [0, maxJitter]
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.7, 11.3_

  - [x] 6.2 Write property tests for sleep scheduler
    - **Property 5: Sleep duration computation follows priority rules**
    - **Validates: Requirements 6.2, 6.3, 6.4, 6.5**
    - **Property 6: Jitter stays within bounds**
    - **Validates: Requirements 6.7, 11.3**
    - **Property 17: Render response always includes sleep duration header**
    - **Validates: Requirements 6.1**

- [x] 7. Implement rendering pipeline
  - [x] 7.1 Implement Floyd-Steinberg dithering in `lib/render/dither.ts`
    - Process pixels left-to-right, top-to-bottom
    - Distribute quantization error: 7/16 right, 3/16 below-left, 5/16 below, 1/16 below-right
    - Find nearest palette color for each pixel
    - Output buffer of palette indices with same width × height dimensions
    - _Requirements: 5.6_

  - [x] 7.2 Write property test for dithering
    - **Property 7: Dithered output contains only palette indices and preserves dimensions**
    - **Validates: Requirements 5.6**

  - [x] 7.3 Implement layout renderer in `lib/render/layout.ts`
    - Use `@napi-rs/canvas` to create 800x480 canvas
    - Render header with room name and FREE/BUSY status
    - Render up to 3 upcoming event slots
    - Render "Last Updated" timestamp in footer
    - Implement `renderOfflineLayout()` for "System Offline" fail-safe
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x] 7.4 Implement `canvasToPixelBuffer` to chain canvas → dither → raw buffer
    - Extract image data from canvas
    - Apply Floyd-Steinberg dithering with device palette
    - Return raw Buffer for HTTP response
    - _Requirements: 5.1, 5.6_

  - [x] 7.5 Write property tests for rendering pipeline
    - **Property 8: Render layout contains required visual elements**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
    - **Property 9: Stale calendar data triggers fail-safe**
    - **Validates: Requirements 5.5**

- [x] 8. Implement telemetry logger
  - [x] 8.1 Implement `extractTelemetry` and `logTelemetry` in `lib/telemetry/`
    - Extract X-Battery-Voltage, X-Battery-Level, X-WiFi-RSSI, X-Firmware-Ver from request headers
    - Insert telemetry entry into database associated with device MAC
    - _Requirements: 7.2_

  - [x] 8.2 Write property test for telemetry logging
    - **Property 13: Telemetry headers are logged with correct MAC association**
    - **Validates: Requirements 7.2**

- [x] 9. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Wire up API Route Handlers
  - [x] 10.1 Implement POST `/api/v1/ink/hello/route.ts`
    - Validate request body with `helloRequestSchema`
    - Call `handleHello(mac)`
    - Return envelope response with device status or token
    - _Requirements: 3.2, 3.3, 10.2_

  - [x] 10.2 Implement GET `/api/v1/ink/render/route.ts`
    - Validate `mac` query param, validate `X-Device-Token` via `validateDeviceToken`
    - Extract and log telemetry
    - Fetch calendar events for device's room
    - Apply room policy
    - Check staleness (>4 hours → render offline layout)
    - Render layout → dither → pixel buffer
    - Compute sleep duration based on device telemetry (power source, battery level, next event)
    - Apply jitter to sleep duration
    - Return binary response with `X-Sleep-Duration` header
    - _Requirements: 5.1, 6.1, 6.7, 10.1_

  - [x] 10.3 Implement POST `/api/v1/ink/report/route.ts`
    - Validate request body and token
    - Insert report into database
    - Return envelope response
    - _Requirements: 10.3_

  - [x] 10.4 Implement GET `/api/v1/ink/config/route.ts`
    - Validate `mac` query param and token
    - Return device configuration (OTA URL, display rotation)
    - _Requirements: 10.4_

  - [x] 10.5 Write property test for missing parameter validation
    - **Property 14: Missing required parameters return HTTP 400**
    - **Validates: Requirements 10.5**

  - [x] 10.6 Write integration tests for API endpoints
    - Test hello flow: unknown MAC → pending, approved → token returned
    - Test render flow: authenticated device gets binary response with sleep header
    - Test 401 for invalid token
    - Test 400 for missing parameters
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

- [x] 11. Final backend checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Implement firmware core modules
  - [x] 12.1 Implement NVS Manager (`firmware/src/nvs_manager/`)
    - Encrypted NVS read/write for `wifi_ssid`, `wifi_pass`, `device_token`, `server_url`
    - Helper functions: `hasWifiCredentials()`, `hasDeviceToken()`, `storeToken(token)`, `clearAll()`
    - _Requirements: 1.4, 3.4_

  - [x] 12.2 Implement WiFi Manager (`firmware/src/wifi_manager/`)
    - Station mode: connect using NVS credentials, 30-second timeout, 3 retries before SoftAP fallback
    - SoftAP mode: broadcast `Vellum-XXXX` network, serve captive portal HTML form
    - Store submitted credentials to NVS, restart on success
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [x] 12.3 Implement HTTP Client (`firmware/src/http_client/`)
    - Send requests to backend with telemetry headers (X-Battery-Voltage, X-Battery-Level, X-WiFi-RSSI, X-Firmware-Ver)
    - Include X-Device-Token on authenticated requests
    - Handle response codes: 200, 401, 400, 5xx
    - Parse X-Sleep-Duration header from render response
    - _Requirements: 3.5, 7.1, 10.1_

  - [x] 12.4 Implement E-Ink Driver (`firmware/src/display/`)
    - `drawPixelBuffer(buffer, length)` — write raw pixel data to display
    - `drawFallbackIcon(iconId)` — render hardcoded bitmaps from flash
    - `drawQRCode(data)` — render QR code for SoftAP provisioning
    - `showLoadingIndicator()` — brief loading animation
    - Include fallback icon bitmaps as C arrays in flash: No Signal, Cloud Disconnect, Unauthorized, Connect Power, Error
    - _Requirements: 1.2, 9.1, 9.2, 9.3, 9.4, 9.5_

- [x] 13. Implement firmware button handling and sleep management
  - [x] 13.1 Implement Button Handler (`firmware/src/buttons/`)
    - Interrupt-driven with 50ms debounce
    - Button 1 (top): wake and request fresh render
    - Button 2 (middle): send issue report POST /api/v1/ink/report
    - Button 3 (bottom): hold 5 seconds → enter SoftAP mode
    - Show loading indicator on button-triggered server requests
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [x] 13.2 Implement Sleep Manager (`firmware/src/sleep/`)
    - Configure deep sleep timer from X-Sleep-Duration header value
    - Configure GPIO wake sources for button interrupts
    - Determine wake reason (timer vs button) on boot
    - _Requirements: 6.6_

- [x] 14. Implement firmware main loop and error handling
  - [x] 14.1 Implement main loop (`firmware/src/main.cpp`)
    - Boot sequence: check NVS → connect Wi-Fi or SoftAP → check token → hello or render → display → sleep
    - Error handling: Wi-Fi failure → "No Signal" icon, 401 → "Unauthorized" icon, 5xx → "Cloud Disconnect" icon
    - Battery < 5% → "Connect Power" icon + permanent deep sleep
    - Malformed pixel buffer → keep previous image + error overlay
    - _Requirements: 1.1, 3.1, 9.2, 9.3, 9.4, 9.5_

- [x] 15. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties using `fast-check` with minimum 100 iterations
- Unit tests validate specific examples and edge cases
- Backend tasks (1-11) can be developed and tested independently of firmware tasks (12-14)
- Firmware tasks assume Arduino/ESP-IDF toolchain is configured separately
