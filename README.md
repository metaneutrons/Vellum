<p align="center">
  <img src="assets/vellum_logo.svg" alt="Vellum" width="200" />
</p>

# Vellum

[![CI](https://github.com/YOUR_ORG/vellum/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR_ORG/vellum/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

E-Ink meeting room display system. A Next.js backend renders calendar data from Microsoft Graph into dithered pixel buffers for ESP32-S3 powered E-Ink panels.

## Architecture

```
┌──────────────┐     HTTPS      ┌──────────────┐     Graph API    ┌─────────────┐
│  ESP32-S3    │ ──────────────▶│  Next.js API  │ ──────────────▶ │  Microsoft  │
│  E-Ink Panel │ ◀──────────────│  (Vercel/VPS) │ ◀────────────── │  365        │
└──────────────┘  pixel buffer  └──────┬───────┘                  └─────────────┘
                                       │
                                       ▼
                                ┌──────────────┐
                                │  PostgreSQL   │
                                └──────────────┘
```

## Prerequisites

- Node.js 20+
- PostgreSQL 15+
- Azure AD app registration with `Calendars.Read` application permission
- ESP-IDF v5.3+ (firmware only)

## Quick Start

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your credentials

# Run database migrations
psql $DATABASE_URL < drizzle/0000_initial_schema.sql

# Start development server
npm run dev

# Run tests
npm test

# Lint
npm run lint
```

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/ink/hello` | None | Device registration (TOFU) |
| `GET` | `/api/v1/ink/render?mac=XX:XX:XX:XX:XX:XX` | Token | Render pixel buffer |
| `GET` | `/api/v1/ink/config?mac=XX:XX:XX:XX:XX:XX` | Token | Device configuration |
| `POST` | `/api/v1/ink/report` | Token | Submit issue report |
| `POST` | `/api/v1/admin/devices/approve` | API Key | Approve pending device |
| `GET` | `/api/v1/health` | None | Health check |

## Firmware

```bash
cd firmware
make setup    # Install ESP-IDF + toolchain
make build    # Compile
make fm       # Flash + monitor
```

See `firmware/main/Kconfig.projbuild` for all configurable options.

## Project Structure

```
src/
├── app/api/v1/       # Next.js API routes
│   ├── health/       # Health check
│   ├── ink/          # Device API
│   └── admin/        # Admin API
├── db/               # Drizzle schema + pool
└── lib/
    ├── auth/         # TOFU device authentication
    ├── calendar/     # Microsoft Graph integration
    ├── render/       # Canvas → dithered pixel buffer
    ├── sleep/        # Sleep duration computation
    ├── telemetry/    # Device telemetry ingestion
    ├── env.ts        # Environment validation (SSOT)
    ├── logger.ts     # Structured JSON logging
    ├── rate-limit.ts # In-memory rate limiter
    ├── cache.ts      # TTL cache for Graph API
    ├── types.ts      # Shared type definitions
    └── validation.ts # Zod request schemas

firmware/
├── main/             # ESP-IDF entry point
└── components/       # Modular ESP-IDF components
    ├── buttons/      # GPIO interrupt handler
    ├── http_client/  # Backend communication
    ├── nvs_manager/  # Encrypted NVS storage
    ├── sleep_manager/# Deep sleep management
    ├── vellum_display/# E-Ink SPI driver
    └── wifi_manager/ # Station + SoftAP provisioning
```

## License

MIT
