<p align="center">
  <img src="assets/vellum_logo.svg" alt="Vellum" width="240" />
</p>

<p align="center">
  <strong>(E-Ink) Display Management Platform</strong><br>
  Centrally manage, brand, and deploy content to (E-Paper) displays.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/CI-passing-brightgreen" alt="CI">
  <img src="https://img.shields.io/badge/Firmware-ESP32--S3-red" alt="Firmware">
  <img src="https://img.shields.io/badge/TypeScript-6.0-blue" alt="TypeScript">
  <img src="https://img.shields.io/badge/Next.js-16.2-black" alt="Next.js">
  <img src="https://img.shields.io/badge/ESP--IDF-6.0-red" alt="ESP-IDF">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-green.svg" alt="License">
  <img src="https://img.shields.io/badge/Docker-ghcr.io-blue" alt="Docker"></a>
</p>

---

## What is Vellum?

Vellum is an open-source platform for managing (not only) E-Ink/E-Paper displays in offices, coworking spaces, and conference rooms. A central server renders content (meeting room schedules, dashboards, signage) and delivers pixel-perfect images to battery-powered ESP32-S3 displays that can run for months on a single charge.

## Features

- **🖥 Plugin Content System** — Room booking (Outlook-style day view), extensible for weather, dashboards, photos
- **📅 Calendar & Booking Providers** — Microsoft 365, Google Calendar, anny (room/workspace booking), and iCal URL feeds
- **🎨 Theme System** — DB-backed branding with live preview, per-device assignment
- **📡 Display Agnostic** — Mono, 4/16-level grayscale, and 7-color Spectra 6 displays
- **✏️ Pixel-Perfect Rendering** — Pre-rendered bitmap font atlas for color e-paper, anti-aliased for grayscale
- **⏱ Refresh Profiles** — Schedule rules by weekday/time (night mode, weekends, office hours)
- **⬆️ OTA Updates** — Signed firmware distribution via GitHub Releases (Ed25519 + SHA256)
- **🔒 Encrypted Security** — validated TLS (HTTPS) to the backend, X25519 ECDH encrypted token delivery, and NVS credential encryption at rest (production hardening profile — see [SECURITY.md](SECURITY.md))
- **🌐 Zero-Config Setup** — mDNS auto-discovery, USB/Web-Serial provisioning from the browser (SoftAP captive portal remains the first-boot fallback)
- **🖱 Web Flasher** — Flash firmware to devices directly from the browser via USB
- **🧪 Device Simulator** — Web-based E-Paper simulator for development (dev-only)
- **📊 Telemetry Dashboard** — Battery, RSSI, firmware version monitoring with warnings

## Supported Hardware

| Model | Display | Resolution | Colors | Link |
|-------|---------|-----------|--------|------|
| [reTerminal E1001](https://www.seeedstudio.com/reTerminal-E1001-p-6534.html) | 7.5" E-Ink | 800×480 | 4-level grayscale | [Wiki](https://wiki.seeedstudio.com/getting_started_with_reterminal_e1001) |
| [reTerminal E1002](https://www.seeedstudio.com/reTerminal-E1002-p-6533.html) | 7.3" Spectra 6 | 800×480 | 7 colors (B/W/R/G/B/Y/O) | [Wiki](https://wiki.seeedstudio.com/getting_started_with_reterminal_e1002) |
| [reTerminal E1003](https://www.seeedstudio.com/catalogsearch/result/?q=e1003) | 10.3" E-Ink | 1404×1872 | 16-level grayscale | [Wiki](https://wiki.seeedstudio.com/getting_started_with_reterminal_e1003) |

All displays are powered by **ESP32-S3** with WiFi, 2000mAh battery, USB-C, and 3 programmable buttons. New display hardware can be added by implementing a display driver — the server adapts automatically via capability negotiation.

## Architecture

```plain
┌──────────────────┐       HTTPS        ┌────────────────────┐       APIs       ┌─────────────┐
│  ESP32-S3        │ ──────────────────▶│  Vellum Server     │ ────────────────▶│  M365       │
│  E-Ink Display   │ ◀──────────────────│  (Next.js)         │ ◀────────────────│  Google     │
│                  │    pixel buffer    │                    │                  │  anny       │
│  Sleeps 99%      │                    │  Admin Dashboard   │                  │  iCal       │
│  of the time     │                    │  Device Simulator  │                  └─────────────┘
└──────────────────┘                    └─────────┬──────────┘
                                                  │
                                          ┌───────┴──────┐
                                          │  PostgreSQL  │
                                          └──────────────┘
```

## Quick Start

### Prerequisites

- Node.js 22+
- PostgreSQL 15+
- A calendar provider (Microsoft 365, Google, anny, or any iCal URL)

### Server Setup

```bash
git clone <your-repo-url>
cd vellum
npm install

# Configure environment
cp .env.example .env
# Edit .env: set DATABASE_URL, ENCRYPTION_KEY, SESSION_SECRET (required, min 32 chars — `openssl rand -hex 32`), ADMIN_API_KEY, ADMIN_USER, ADMIN_PASS

# Create database and run migrations (idempotent — safe to re-run on upgrades)
createdb vellum
npm run db:migrate

# Start with mDNS auto-discovery
npm run dev:mdns
```

Open **<http://localhost:3000/admin>** and log in.

### Docker

```bash
docker pull ghcr.io/metaneutrons/vellum:latest

docker run -d \
  --name vellum \
  -p 3000:3000 \
  -e DATABASE_URL=postgresql://user:pass@host:5432/vellum \
  -e ENCRYPTION_KEY=your-encryption-key \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  -e ADMIN_API_KEY=your-admin-api-key \
  -e ADMIN_USER=admin \
  -e ADMIN_PASS=your-password \
  ghcr.io/metaneutrons/vellum:latest
```

The container **applies pending database migrations on startup** (idempotent; fail-open so a transient DB outage doesn't block boot), so a fresh `DATABASE_URL` is provisioned automatically and upgrades pick up new migrations with no manual step.

Multi-arch image available for **linux/amd64** and **linux/arm64** (native builds, no QEMU).

### Microsoft Entra ID sign-in

Vellum supports local break-glass accounts alongside Microsoft Entra ID OIDC.
When Entra is enabled, set a single canonical HTTPS origin and let Vellum derive
the callback path; do not configure the callback as a separate application
setting:

```dotenv
VELLUM_PUBLIC_URL=https://vellum.example.com
ENTRA_TENANT_ID=your-tenant-id
ENTRA_CLIENT_ID=your-app-client-id
ENTRA_CLIENT_SECRET=store-this-in-your-secret-manager
```

Register this exact **Web** redirect URI in the Entra app registration:

```text
https://vellum.example.com/api/auth/oidc/entra/callback
```

`VELLUM_PUBLIC_URL` must be an HTTPS origin only: no path, query string, or
fragment. The callback path is deliberately fixed so the OIDC client,
authorization-code exchange, and post-login redirects cannot diverge. Keep the
local owner account as a break-glass recovery path.

### First-Time Setup (Admin Dashboard)

1. **Data Providers** → Add your Microsoft 365 / Google / anny / iCal credentials
2. **Content** → Create a room booking instance (select provider, room email, timezone)
3. **Themes** → Customize colors or use the default theme
4. **Devices** → Approve devices as they connect, assign content + theme

### Firmware Installation

#### Option A: Browser-Based (recommended)

1. Connect the reTerminal to your computer via USB-C
2. Open **Admin → Firmware → Flash Device**
3. Select the display model and firmware channel
4. Click **"Connect & Flash"** — the browser flashes the firmware directly

> Requires Chrome or Edge (Web Serial API).

#### Option B: Command Line

```bash
cd firmware
# Requires ESP-IDF v6.0 installed out-of-band (the Makefile activates it from a
# hardcoded path — there is no `make setup` target).
make build    # Compile firmware (default MODEL=e1002; e.g. make build MODEL=e1001)
make fm       # Flash + open serial monitor
```

See `firmware/main/Kconfig.projbuild` for all configurable options (display model, pins, timeouts).

### Device Setup

Provision the device over the USB cable — no phone or hotspot needed:

1. Keep the reTerminal connected via USB-C (Chrome or Edge — Web Serial API)
2. Open **Admin → Firmware → Provision**
3. Push the WiFi SSID/password and server URL to the device over the cable
4. *(Optional)* Mint a single-use, 7-day **voucher** for zero-touch auto-enrolment — the voucher token is delivered over the cable as the device's bearer token, so it registers and enrols itself without a manual approval step
5. The device connects to WiFi and registers with the server
6. Approve the device in the admin dashboard (unless a voucher auto-enrolled it) → it starts displaying content

> **Fallback — SoftAP captive portal.** If the device boots with no stored WiFi credentials, it opens an open access point **"Vellum-XXXX"** and shows a QR code. Connect a phone to the AP, complete the captive portal, and enter WiFi credentials (server URL is auto-discovered via mDNS). This is the first-boot fallback only; USB provisioning is the primary path.

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/ink/hello` | None | Device registration (TOFU + X25519 ECDH) |
| `GET` | `/api/v1/ink/render?mac=...` | Token | Render pixel buffer for device |
| `GET` | `/api/v1/ink/config?mac=...` | Token | Device config + OTA update check |
| `POST` | `/api/v1/ink/report` | Token | Submit issue report |
| `GET` | `/api/v1/health` | None | Health check (DB connectivity) |
| `POST` | `/api/v1/admin/devices/approve` | API Key | Approve pending device |
| `GET` | `/api/v1/admin/preview?instanceId=...` | Session | Render content preview as PNG |

## Development

```bash
npm run dev          # Start Next.js dev server
npm run dev:mdns     # Start with mDNS announcement
npm test             # Run tests (~20 vitest suites)
npm run lint         # ESLint
npx tsc --noEmit     # Type check
```

### Device Simulator

Open **<http://localhost:3000/simulator>** (dev mode only). Simulates the full firmware cycle: boot → WiFi → ECDH hello → render → sleep. Supports all three display models.

## Project Structure

```plain
src/
├── app/
│   ├── admin/            # Dashboard (9 pages: overview, devices, content, providers,
│   │                     #   themes, profiles, firmware, flash, telemetry)
│   ├── api/v1/           # Device + admin API endpoints
│   ├── login/            # Admin authentication
│   └── simulator/        # Device simulator (dev only)
├── components/           # Shared UI (toast, modal, confirm, button, search, etc.)
├── db/                   # Drizzle ORM schema + connection pool
└── lib/
    ├── auth/             # TOFU device auth + X25519 ECDH
    ├── calendar/         # Provider registry + M365/Google/anny/iCal implementations
    ├── content/          # Content renderer registry + room-booking renderer
    ├── render/           # Canvas → pixel buffer pipeline + bitmap font atlas
    ├── sleep/            # Refresh profiles + schedule rules engine
    ├── firmware.ts       # OTA manifest fetcher + semver resolver
    ├── display.ts        # Display capability negotiation (device-reported)
    ├── theme.ts          # Theme system (Zod-validated from DB)
    ├── encryption.ts     # AES-256-GCM for provider credentials
    └── crypto.ts         # X25519 ECDH for secure token delivery

firmware/
├── main/                 # ESP-IDF entry point + boot flow (Wi-Fi, ECDH, render, sleep)
└── components/
    ├── board/            # Board HAL (battery ADC, USB-power detect, pin map)
    ├── vellum_display/   # Display driver abstraction
    │   └── drivers/      # E1001 (UC8179), E1002 (UC8179C), E1003, Stub
    ├── http_client/      # Server communication (cJSON, TLS)
    ├── wifi_manager/     # Station + SoftAP captive portal (first-boot fallback)
    ├── vellum_serial/    # USB-serial Improv Wi-Fi provisioning + text console (primary onboarding)
    ├── secure_channel/   # X25519 ECDH secure channel for encrypted token delivery
    ├── ota_manager/      # OTA update engine (Ed25519-signed image verify, staged partition)
    ├── nvs_manager/      # NVS store (WiFi, token, X25519 keypair; encrypted in prod profile)
    ├── buttons/          # GPIO interrupt handler (3 buttons)
    └── sleep_manager/    # Deep sleep + timer/GPIO wake
```

The browser-based flash and USB-serial provisioning UIs live under `src/app/admin/firmware/` (`flash/` and `provision/`).

## Security

- **Transport**: HTTPS-only to the backend with CA-bundle certificate validation; the device refuses non-`https://` URLs and cleartext-downgrade redirects
- **Device Authentication**: Trust-On-First-Use with X25519 ECDH encrypted token delivery
- **Credentials at Rest** (server): AES-256-GCM encryption with server-side master key
- **Token Comparison**: SHA-256 hash-then-compare (constant-time, no length leakage)
- **OTA Firmware**: Ed25519 signed + SHA256 verified against the staged partition before it is made bootable
- **NVS Storage** (device): WiFi credentials, device token, and X25519 key live in NVS — encrypted at rest under the production hardening profile ([SECURITY.md](SECURITY.md)); **not** encrypted in dev builds
- **Rate Limiting**: Per-IP rate limits on all API endpoints
- **Admin Auth**: Timing-safe password comparison, httpOnly session cookies

## Tech Stack

| Component | Technology |
|-----------|------------|
| Server | Next.js 16.2, TypeScript 6, Drizzle ORM |
| Database | PostgreSQL 15+ |
| Admin UI | Tailwind CSS 4, React Server Components |
| Firmware | ESP-IDF 6.0, C, ESP32-S3 / ESP32-P4 |
| Rendering | @napi-rs/canvas, Floyd-Steinberg dithering, bitmap font atlas |
| Crypto | X25519 ECDH, AES-256-GCM, Ed25519, HKDF-SHA256 |
| CI/CD | GitHub Actions, release-please |

## Contributing

Contributions are welcome! Please open an issue first to discuss what you'd like to change. See [ROADMAP.md](ROADMAP.md) for planned work.

## Acknowledgments

- [Seeed Studio](https://www.seeedstudio.com/) — reTerminal E-Series hardware
- [Espressif](https://www.espressif.com/) — ESP-IDF and ESP32-S3
- [Vercel](https://vercel.com/) — Next.js framework
- [Project Nayuki](https://www.nayuki.io/page/qr-code-generator-library) — QR code generation
- [Rasmus Andersson](https://rsms.me/inter/) — Inter typeface

## License

AGPL-3.0 — see [LICENSE](LICENSE) for details.
