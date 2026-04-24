# Requirements Document

## Introduction

Vellum is a headless, server-side rendered display system that turns raw E-Ink surfaces into intelligent meeting room status indicators. The system follows a "Calm Intelligence" philosophy: an ESP32-S3 thin client wakes, authenticates, downloads a pre-rendered pixel buffer from a Node.js/TypeScript backend, draws it to the screen, and sleeps. The backend handles all business logic including Microsoft 365 calendar integration, canvas-based layout rendering, Floyd-Steinberg dithering, and adaptive power scheduling. A CLI tool supports mass USB provisioning for IT deployments.

## Glossary

- **Device**: The ESP32-S3 based E-Ink hardware unit (Seeed Studio reTerminal E10xx) running Vellum firmware.
- **Server**: The Node.js/TypeScript backend application responsible for calendar integration, rendering, dithering, and device management.
- **CLI_Tool**: The USB provisioning utility used by IT administrators for mass device deployment.
- **Pixel_Buffer**: A raw binary image (800x480) rendered server-side and streamed to the Device for direct E-Ink display.
- **NVS**: Non-Volatile Storage on the ESP32-S3 used to persist Wi-Fi credentials and device secrets.
- **SoftAP_Mode**: A Wi-Fi access point mode where the Device broadcasts its own network for initial configuration.
- **Captive_Portal**: A web interface served by the Device in SoftAP_Mode for Wi-Fi credential entry.
- **TOFU**: Trust On First Use authentication where the Server issues a crypto token after an administrator approves a new Device.
- **Floyd_Steinberg_Dithering**: An error-diffusion algorithm used to convert grayscale/color images to the limited palette supported by E-Ink displays.
- **Sleep_Duration**: The time in seconds a Device remains in deep sleep between render cycles, communicated via the X-Sleep-Duration HTTP header.
- **Jitter**: A randomized delay added to Device wake times to prevent simultaneous server requests from many Devices.
- **Room_Policy**: An administrator-configured privacy setting that controls what calendar information is visible on a specific Device.

## Requirements

### Requirement 1: Wi-Fi Provisioning via SoftAP

**User Story:** As a facility manager, I want to configure a new Device's Wi-Fi credentials through a phone-friendly captive portal, so that I can deploy Devices without IT support or USB tools.

#### Acceptance Criteria

1. WHEN the Device boots with no stored Wi-Fi credentials, THE Device SHALL enter SoftAP_Mode and broadcast a configuration network.
2. WHEN the Device enters SoftAP_Mode, THE Device SHALL render a QR code to the E-Ink display containing the SoftAP Wi-Fi connection string.
3. WHEN a user connects to the SoftAP network, THE Device SHALL serve a Captive_Portal web interface for Wi-Fi credential entry.
4. WHEN valid Wi-Fi credentials are submitted through the Captive_Portal, THE Device SHALL store the credentials in encrypted NVS and restart in normal operating mode.
5. IF invalid Wi-Fi credentials are submitted, THEN THE Device SHALL display an error message in the Captive_Portal and allow the user to retry.
6. IF the Device fails to connect to the configured Wi-Fi network within 30 seconds, THEN THE Device SHALL re-enter SoftAP_Mode and display a connection failure indicator on the E-Ink screen.

### Requirement 2: USB Mass Provisioning

**User Story:** As an IT administrator, I want to provision multiple Devices via USB using a CLI tool, so that I can deploy large fleets of Devices efficiently without manual Wi-Fi setup on each unit.

#### Acceptance Criteria

1. WHEN the CLI_Tool is connected to a Device via USB-C, THE CLI_Tool SHALL write Wi-Fi credentials and a Device secret directly to the Device NVS.
2. WHEN provisioning completes successfully, THE CLI_Tool SHALL output a confirmation message including the Device MAC address.
3. IF the CLI_Tool cannot communicate with the connected Device, THEN THE CLI_Tool SHALL report a descriptive connection error and exit with a non-zero status code.
4. THE CLI_Tool SHALL accept Wi-Fi credentials and Device secrets as command-line arguments or from a configuration file.
5. WHEN provisioning from a configuration file, THE CLI_Tool SHALL validate the configuration file format before writing to the Device.

### Requirement 3: Device Authentication (TOFU)

**User Story:** As a system administrator, I want Devices to authenticate with the Server using a Trust On First Use model, so that only approved Devices can receive rendered content.

#### Acceptance Criteria

1. WHEN a Device connects to the Server for the first time, THE Device SHALL send a POST request to /v1/ink/hello containing the Device MAC address.
2. WHEN the Server receives a hello request from an unknown MAC address, THE Server SHALL register the Device as pending approval.
3. WHEN an administrator approves a pending Device, THE Server SHALL generate a cryptographic token and return the token to the Device on the next hello request.
4. WHEN the Device receives a cryptographic token, THE Device SHALL store the token in encrypted NVS for subsequent authenticated requests.
5. WHEN the Device sends a render request, THE Device SHALL include the cryptographic token in the X-Device-Token header.
6. IF a render request contains an invalid or missing X-Device-Token, THEN THE Server SHALL respond with HTTP 401 and the Device SHALL display a hardcoded "Unauthorized" fallback icon.

### Requirement 4: Microsoft 365 Calendar Integration

**User Story:** As a meeting room user, I want the display to show the current room schedule from Outlook, so that I can see at a glance whether the room is free or occupied.

#### Acceptance Criteria

1. THE Server SHALL authenticate with Microsoft Graph API using Azure AD Client Credentials Flow with Calendars.Read.All application-scope permission.
2. WHEN the Server fetches calendar data for a Device, THE Server SHALL retrieve events for the associated room mailbox from Microsoft Graph API.
3. WHEN a calendar event is marked as public, THE Server SHALL include the event subject, time range, and organizer name in the rendered display.
4. WHEN a calendar event is marked as private in Outlook, THE Server SHALL replace the event subject with "Booked by [Organizer Name]" and include a lock icon in the rendered display.
5. WHEN a Room_Policy is set to "Hide Subject" for a Device, THE Server SHALL replace all event subjects with "Reserved" regardless of the event privacy flag.
6. WHEN a Room_Policy is set to "Hide All" for a Device, THE Server SHALL display only "FREE" or "BUSY" status without any event details.
7. THE Server SHALL convert all UTC event times to the timezone configured for the specific room before rendering.

### Requirement 5: Server-Side Rendering Pipeline

**User Story:** As a system operator, I want the Server to render complete display images as raw pixel buffers, so that Devices can remain simple thin clients without any rendering logic.

#### Acceptance Criteria

1. WHEN the Server receives a render request from an authenticated Device, THE Server SHALL fetch the latest calendar data, render a layout to an 800x480 canvas, apply Floyd_Steinberg_Dithering, and respond with the raw Pixel_Buffer.
2. THE Server SHALL render the current room status as "FREE" or "BUSY" prominently in the layout.
3. THE Server SHALL render the next 2-3 upcoming calendar slots in the layout.
4. THE Server SHALL include a "Last Updated" timestamp in the rendered layout.
5. WHEN calendar data is stale by more than 4 hours, THE Server SHALL render a "System Offline" fail-safe message in the layout.
6. THE Server SHALL apply Floyd_Steinberg_Dithering to convert the rendered canvas to the color palette supported by the target Device E-Ink display.


### Requirement 6: Adaptive Sleep and Power Management

**User Story:** As a facility manager, I want Devices to intelligently manage their sleep cycles based on power source and upcoming meetings, so that battery-powered Devices last as long as possible while USB-powered Devices stay current.

#### Acceptance Criteria

1. WHEN the Server responds to a render request, THE Server SHALL include an X-Sleep-Duration header specifying the number of seconds the Device should sleep before the next request.
2. WHILE the Device is powered via USB, THE Server SHALL set X-Sleep-Duration to 60 seconds.
3. WHILE the Device is powered by battery, THE Server SHALL set X-Sleep-Duration to 900 seconds (15 minutes) by default.
4. WHILE the Device is powered by battery and a meeting starts within 20 minutes, THE Server SHALL set X-Sleep-Duration so the Device wakes 5 minutes before the next meeting start time.
5. WHILE the Device battery level is below 20%, THE Server SHALL set X-Sleep-Duration to 3600 seconds (60 minutes).
6. WHEN the Device receives the X-Sleep-Duration header, THE Device SHALL enter deep sleep for the specified duration.
7. WHEN multiple Devices are expected to wake simultaneously, THE Server SHALL apply Jitter by varying X-Sleep-Duration by a random offset of up to 10 seconds to distribute server load.

### Requirement 7: Device Telemetry Reporting

**User Story:** As a system administrator, I want each Device to report its health metrics with every request, so that I can monitor fleet health and proactively address issues.

#### Acceptance Criteria

1. WHEN the Device sends a request to the Server, THE Device SHALL include the following HTTP headers: X-Battery-Voltage, X-Battery-Level, X-WiFi-RSSI, and X-Firmware-Ver.
2. WHEN the Server receives telemetry headers, THE Server SHALL log the telemetry data associated with the Device MAC address.
3. WHEN a user presses Button 2 (middle), THE Device SHALL send a POST request to /v1/ink/report to flag an issue for the associated room.

### Requirement 8: Physical Button Interactions

**User Story:** As a meeting room user, I want to use the physical buttons on the Device to trigger common actions, so that I can interact with the system without a phone or computer.

#### Acceptance Criteria

1. WHEN a user presses Button 1 (top), THE Device SHALL immediately wake from sleep and request a fresh render from the Server.
2. WHEN a user presses Button 2 (middle), THE Device SHALL send an issue report to the Server via POST /v1/ink/report.
3. WHEN a user holds Button 3 (bottom) for 5 seconds, THE Device SHALL enter SoftAP_Mode for reconfiguration.
4. WHEN a button press triggers a server request, THE Device SHALL display a brief loading indicator on the E-Ink screen while the request is in progress.

### Requirement 9: Error Handling and Fallback Display

**User Story:** As a facility manager, I want the Device to display meaningful status icons when errors occur, so that users and administrators can quickly identify and resolve issues.

#### Acceptance Criteria

1. THE Device firmware SHALL include hardcoded fallback bitmap icons stored in flash memory for each error state.
2. IF the Device cannot connect to Wi-Fi, THEN THE Device SHALL display a "No Signal" icon overlay on the E-Ink screen.
3. IF the Server responds with an HTTP 5xx error, THEN THE Device SHALL display a "Cloud Disconnect" icon overlay on the E-Ink screen.
4. IF the Device battery level drops below 5%, THEN THE Device SHALL display a "Connect Power" icon and enter permanent deep sleep until USB power is connected.
5. IF the Device receives a malformed or incomplete Pixel_Buffer, THEN THE Device SHALL retain the previously displayed image and display a small error indicator.

### Requirement 10: Render API Contract

**User Story:** As a backend developer, I want a well-defined API contract between Device and Server, so that firmware and backend can be developed and tested independently.

#### Acceptance Criteria

1. THE Server SHALL expose a GET /v1/ink/render endpoint that accepts a mac query parameter and X-Device-Token header, and responds with a binary Pixel_Buffer and X-Sleep-Duration header.
2. THE Server SHALL expose a POST /v1/ink/hello endpoint that accepts a JSON body containing the Device MAC address and responds with a device status or cryptographic token.
3. THE Server SHALL expose a POST /v1/ink/report endpoint that accepts a JSON body containing the Device MAC address and an issue description.
4. THE Server SHALL expose a GET /v1/ink/config endpoint that responds with device configuration including OTA update availability and display rotation settings.
5. IF a request to any endpoint is missing required parameters, THEN THE Server SHALL respond with HTTP 400 and a JSON error body containing a descriptive message.
6. THE Server SHALL serialize all JSON API responses using a consistent envelope format containing status, data, and error fields.
7. FOR ALL valid API request-response pairs, serializing the response to JSON and deserializing the JSON back SHALL produce an equivalent response object (round-trip property).

### Requirement 11: Scalability and Load Distribution

**User Story:** As a system operator, I want the Server to handle simultaneous requests from many Devices without degradation, so that all meeting rooms update reliably during peak times.

#### Acceptance Criteria

1. WHEN the Server receives concurrent render requests, THE Server SHALL process each request independently without blocking other requests.
2. THE Server SHALL support at least 50 concurrent Device render requests without request timeout or failure.
3. WHEN assigning sleep durations, THE Server SHALL apply Jitter to distribute Device wake times and prevent thundering herd scenarios.
