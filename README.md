<p align="center">
  <img src="assets/vellum_logo.svg" alt="Vellum" width="240" />
</p>

<p align="center">
  <strong>E-Ink Display Management Platform</strong><br>
  Centrally manage, brand, and deploy content to E-Paper displays.
</p>

<p align="center">
  <a href="https://github.com/YOUR_ORG/vellum/actions/workflows/ci.yml"><img src="https://github.com/YOUR_ORG/vellum/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/YOUR_ORG/vellum/actions/workflows/firmware.yml"><img src="https://github.com/YOUR_ORG/vellum/actions/workflows/firmware.yml/badge.svg" alt="Firmware"></a>
  <img src="https://img.shields.io/badge/TypeScript-6.0-blue" alt="TypeScript">
  <img src="https://img.shields.io/badge/Next.js-16.2-black" alt="Next.js">
  <img src="https://img.shields.io/badge/ESP--IDF-5.3-red" alt="ESP-IDF">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-green.svg" alt="License"></a>
</p>

---

## What is Vellum?

Vellum is an open-source platform for managing E-Ink/E-Paper displays in offices, coworking spaces, and conference rooms. A central server renders content (meeting room schedules, dashboards, signage) and delivers pixel-perfect images to battery-powered ESP32-S3 displays that can run for months on a single charge.

## Features

- **🖥 Plugin Content System** — Room booking (Outlook-style day view), extensible for weather, dashboards, photos
- **📅 Calendar Providers** — Microsoft 365, Google Calendar, iCal URL feeds
- **🎨 Theme System** — DB-backed branding with live preview, per-device assignment
- **📡 Display Agnostic** — Mono, 4/16-level grayscale, and 7-color Spectra 6 displays
- **✏️ Pixel-Perfect Rendering** — Pre-rendered bitmap font atlas for color e-paper, anti-aliased for grayscale
- **⏱ Refresh Profiles** — Schedule rules by weekday/time (night mode, weekends, office hours)
- **⬆️ OTA Updates** — Signed firmware distribution via GitHub Releases (Ed25519 + SHA256)
- **🔒 Encrypted Security** — X25519 ECDH token delivery, AES-256-GCM credentials at rest
- **🌐 Zero-Config Setup** — mDNS auto-discovery, branded captive portal for WiFi provisioning
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

```
┌──────────────────┐       HTTPS        ┌──────────────────┐       APIs        ┌─────────────┐
│  ESP32-S3        │ ──────────────────▶│  Vellum Server    │ ────────────────▶│  Microsoft  │
│  E-Ink Display   │ ◀──────────────────│  (Next.js)        │ ◀────────────────│  365        │
│                  │   pixel buffer     │                    │                  │  Google     │
│  Sleeps 99%      │                    │  Admin Dashboard   │                  │  iCal       │
│  of the time     │                    │  Device Simulator  │                  └─────────────┘
└──────────────────┘                    └────────┬───────────┘
                                                 │
                                          ┌──────┴──────┐
                                          │  PostgreSQL  │
                                          └─────────────┘
```

## Quick Start

### Prerequisites

- Node.js 22+
- PostgreSQL 15+
- A calendar provider (Microsoft 365, Google, or any iCal URL)

### Server Setup

```bash
git clone https://github.com/YOUR_ORG/vellum.git
cd vellum
npm install

# Configure environment
cp .env.example .env
# Edit .env: set DATABASE_URL, ENCRYPTION_KEY, ADMIN_API_KEY, ADMIN_USER, ADMIN_PASS

# Create database and run migrations
createdb vellum
for f in drizzle/*.sql; do psql -d vellum -f "$f"; done

# Start with mDNS auto-discovery
npm run dev:mdns
```

Open **http://localhost:3000/admin** and log in.

### First-Time Setup (Admin Dashboard)

1. **Data Providers** → Add your Microsoft 365 / Google / iCal credentials
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
make setup    # Install ESP-IDF v5.3 + toolchain (one-time)
make build    # Compile firmware
make fm       # Flash + open serial monitor
```

See `firmware/main/Kconfig.projbuild` for all configurable options (display model, pins, timeouts).

### Device Setup

Once flashed, the device:

1. Starts a WiFi hotspot **"Vellum-XXXX"**
2. Shows a QR code on the display
3. Connect your phone → captive portal opens
4. Enter WiFi credentials (server URL is auto-discovered via mDNS)
5. Device reboots, connects to WiFi, registers with the server
6. Approve the device in the admin dashboard → it starts displaying content

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
npm test             # Run tests (53 tests)
npm run lint         # ESLint
npx tsc --noEmit     # Type check
```

### Device Simulator

Open **http://localhost:3000/simulator** (dev mode only). Simulates the full firmware cycle: boot → WiFi → ECDH hello → render → sleep. Supports all three display models.

## Project Structure

```
src/
├── app/
│   ├── admin/            # Dashboard (8 pages: devices, content, providers,
│   │                     #   themes, profiles, firmware, flash, telemetry)
│   ├── api/v1/           # Device + admin API endpoints
│   ├── login/            # Admin authentication
│   └── simulator/        # Device simulator (dev only)
├── components/           # Shared UI (toast, modal, confirm, button, search, etc.)
├── db/                   # Drizzle ORM schema + connection pool
└── lib/
    ├── auth/             # TOFU device auth + X25519 ECDH
    ├── calendar/         # Provider registry + M365/Google/iCal implementations
    ├── content/          # Content renderer registry + room-booking renderer
    ├── render/           # Canvas → pixel buffer pipeline + bitmap font atlas
    ├── sleep/            # Refresh profiles + schedule rules engine
    ├── firmware.ts       # OTA manifest fetcher + semver resolver
    ├── display.ts        # Display capability negotiation (device-reported)
    ├── theme.ts          # Theme system (Zod-validated from DB)
    ├── encryption.ts     # AES-256-GCM for provider credentials
    └── crypto.ts         # X25519 ECDH for secure token delivery

firmware/
├── main/                 # ESP-IDF entry point, OTA, ECDH, sensor reads
└── components/
    ├── vellum_display/   # Display driver abstraction
    │   └── drivers/      # E1001 (UC8179), E1002 (UC8179C), E1003, Stub
    ├── http_client/      # Server communication (cJSON, TLS)
    ├── wifi_manager/     # Station + SoftAP captive portal
    ├── nvs_manager/      # Encrypted NVS (WiFi, token, X25519 keypair)
    ├── buttons/          # GPIO interrupt handler (3 buttons)
    └── sleep_manager/    # Deep sleep + timer/GPIO wake
```

## Security

- **Device Authentication**: Trust-On-First-Use with X25519 ECDH encrypted token delivery
- **Credentials at Rest**: AES-256-GCM encryption with server-side master key
- **Token Comparison**: SHA-256 hash-then-compare (constant-time, no length leakage)
- **OTA Firmware**: Ed25519 signed + SHA256 verified before flashing
- **NVS Storage**: ESP32 encrypted NVS for WiFi credentials and device keys
- **Rate Limiting**: Per-IP rate limits on all API endpoints
- **Admin Auth**: Timing-safe password comparison, httpOnly session cookies

## Tech Stack

| Component | Technology |
|-----------|------------|
| Server | Next.js 16.2, TypeScript 6, Drizzle ORM |
| Database | PostgreSQL 15+ |
| Admin UI | Tailwind CSS 4, React Server Components |
| Firmware | ESP-IDF 5.3, C, ESP32-S3 |
| Rendering | @napi-rs/canvas, Floyd-Steinberg dithering, bitmap font atlas |
| Crypto | X25519 ECDH, AES-256-GCM, Ed25519, HKDF-SHA256 |
| CI/CD | GitHub Actions, release-please |

## Contributing

Contributions are welcome! Please open an issue first to discuss what you'd like to change.

## Acknowledgments

- [Seeed Studio](https://www.seeedstudio.com/) — reTerminal E-Series hardware
- [Espressif](https://www.espressif.com/) — ESP-IDF and ESP32-S3
- [Vercel](https://vercel.com/) — Next.js framework
- [Project Nayuki](https://www.nayuki.io/page/qr-code-generator-library) — QR code generation
- [Rasmus Andersson](https://rsms.me/inter/) — Inter typeface

## License

AGPL-3.0 — see [LICENSE](LICENSE) for details.

---

<p align="center">
</p>
