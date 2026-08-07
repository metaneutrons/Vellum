# vellum_serial

USB-serial provisioning for Vellum devices: **Improv Wi-Fi Serial over the
model's USB-exposed serial transport**, plus an interactive text console on the
same byte stream. E1001/E1002 and D1001 expose the MCU's native
USB-Serial-JTAG; E1003 exposes UART0 through its onboard CH340K bridge.

This is the component behind Vellum's **primary onboarding path** (shipped in
`firmware-v1.2.1`). An operator flashes a device and then provisions it from the
WebUI over a USB cable — no SoftAP or captive portal required. SoftAP still
exists as the no-credentials fallback (see [below](#relationship-to-softap)).

`vellum_serial_init()` spawns the `serial` task on **every boot**
(`firmware/main/main.c` calls it unconditionally, right after `display_init()`),
so provisioning over USB is always available regardless of Wi-Fi state.

## Public API

```c
#include "vellum_serial.h"

void vellum_serial_init(void);   // start the serial console + Improv task
```

`vellum_serial_init()` creates one FreeRTOS task (`serial`, 4 KB stack, prio 5)
that owns `stdin`/`stdout` on the configured console and multiplexes the two
protocols.

Component dependencies (`CMakeLists.txt`): `console`, `nvs_manager`,
`wifi_manager`, `esp_driver_uart`.

## Improv Wi-Fi Serial protocol

The wire format matches the Improv Serial spec (v1). Every frame, both
directions:

```
"IMPROV"(6) | version(1)=0x01 | type(1) | len(1) | payload(len) | checksum(1)
```

where `checksum` is the low 8 bits of the sum of the first `9 + len` bytes.
Outgoing frames are built by `improv_send_packet()` (payload capped so the frame
fits a 256-byte buffer).

### Frame types

| Type | Value | Direction |
|------|-------|-----------|
| `CURRENT_STATE` | `0x01` | device → host |
| `ERROR_STATE`   | `0x02` | device → host |
| `RPC_COMMAND`   | `0x03` | host → device |
| `RPC_RESULT`    | `0x04` | device → host |

### RPC commands (host → device)

An `RPC_COMMAND` payload is `cmd(1) | cmd_len(1) | cmd_payload(cmd_len)`,
dispatched by `improv_handle_rpc()`:

| Command | Value | Behaviour |
|---------|-------|-----------|
| `WIFI_SETTINGS`   | `0x01` | Parse the credential/profile payload, store it, attempt to join Wi-Fi (see below). |
| `GET_STATE`       | `0x02` | Reply with the current `CURRENT_STATE`. |
| `GET_DEVICE_INFO` | `0x03` | `RPC_RESULT` = `["Vellum", firmware-version, IDF-target, display-model]`. |
| `SCAN_WIFI`       | `0x04` | One `RPC_RESULT` per AP (`[ssid, rssi, secured]`, where the 3rd field is `"YES"` for secured / `"NO"` for open), then a final empty `RPC_RESULT` terminating the list. |

Reported states: `READY` (`0x02`), `PROVISIONING` (`0x03`), `PROVISIONED`
(`0x04`). Errors: `NONE` (`0x00`), `INVALID_RPC` (`0x01`), `UNKNOWN_CMD`
(`0x02`), `UNABLE_CONNECT` (`0x03`).

### WIFI_SETTINGS payload

`improv_handle_wifi_settings()` reads up to four length-prefixed
(`len(1) | bytes`) strings from the command payload:

1. **SSID** (required) — copied into a 33-byte buffer, so max 32 bytes.
2. **Password** (required, may be empty) — max 64 bytes.
3. **Server URL** (optional, 3rd string) — stored via
   `nvs_manager_store_server_url()` and echoed back to the host as the redirect
   target in the success `RPC_RESULT`. Vellum's extension to the stock Improv
   command.
4. **Pre-provisioning device token** (optional, 4th string) — stored via
   `nvs_manager_store_token()` for **zero-touch enrolment**: on first
   `/api/v1/ink/hello`, the server auto-approves the device that presents this
   voucher token. The URL string is the positional separator, so a token
   without a server URL is still preceded by an empty URL field.

On receipt the device stores the Wi-Fi credentials
(`nvs_manager_store_wifi()`), transitions to `PROVISIONING`, and calls
`wifi_manager_connect_station()`. On success it sends `PROVISIONED` followed by
the redirect `RPC_RESULT`; on failure it returns to `READY` with an
`UNABLE_CONNECT` error. Every offset is bounds-checked against the received
`len` before use, and an out-of-range field yields `INVALID_RPC` rather than an
over-read.

## Dual-stream design (Improv frames + console on one UART)

Binary Improv frames and interactive text share a **single** byte stream. The
read loop in `serial_task()` demultiplexes them without any framing escape:

- Each incoming byte is appended to `rx_buf`.
- While `rx_buf` is still a **viable Improv frame** — a prefix of the `"IMPROV"`
  magic, or the magic already matched and the declared frame is still being
  collected — the bytes keep buffering and are **never echoed**. Once `≥ 10`
  bytes and the declared body have arrived, `improv_try_parse()` validates the
  checksum and dispatches the frame, then resets both buffers (dropping any
  half-typed console line).
- The moment the accumulated bytes can no longer be an Improv frame, the whole
  buffer is **replayed byte-for-byte into the text console** — so a word that
  merely starts with `I` still types normally.

This is why the console and browser provisioning can coexist on the raw serial
endpoint (the host client, `improv-serial.ts`, does the mirror of this: it scans
the mixed stream for the `"IMPROV"` magic and ignores console noise). Native
USB ignores the configured baud rate; E1003's CH340K/UART0 path uses 115200.

## Text console commands

Registered via `esp_console` (`register_console_commands()`), line-edited
against the `vellum>` prompt. `help` is also registered
(`esp_console_register_help_command()`).

| Command | Usage | Effect |
|---------|-------|--------|
| `wifi`      | `wifi <ssid> <password> [server-url]` | Store Wi-Fi credentials (and optional server URL) in NVS. Reboot to connect. |
| `server`    | `server [url]` | With no arg, print the stored server URL (or note mDNS discovery); with an arg, store it. |
| `token`     | `token <value>` | Store a pre-provisioning device token in NVS. |
| `info`      | `info` | Print MAC, firmware version, display model, and IDF version. |
| `nvs-erase` | `nvs-erase` | Factory reset — erase all NVS, then reboot. |
| `reboot`    | `reboot` | Restart the device. |

These are the developer/power-user equivalents of the Improv RPCs; the WebUI
flow does not need them.

## Security note (physical-trust model)

Wi-Fi credentials **and** the pre-provisioning token cross the USB cable in
**cleartext** inside the Improv `WIFI_SETTINGS` frame — the Improv Serial spec
carries plain length-prefixed strings, and there is no on-device key exchange
before the token is delivered. The exposure is a **local USB cable held by the
operator during a provisioning window**, not the network, which is the accepted
trust model for this flow. Encrypting the token in transit (via an on-device
key exchange) is a tracked, deliberately-deferred item — see
[`ROADMAP.md`](../../../ROADMAP.md) under *USB provisioning (zero-touch
enrolment)*, "Encrypt the device token in transit over USB (review #14)", along
with the related voucher-binding and revocation trade-offs.

## Cross-references

- **Host / browser client:**
  [`src/lib/provisioning/improv-serial.ts`](../../../src/lib/provisioning/improv-serial.ts)
  — byte-exact Improv encoder/parser plus the Web Serial orchestration
  (`provisionOverSerial()`, `scanNetworksOverSerial()`).
- **Admin UI:**
  [`src/app/admin/firmware/provision/`](../../../src/app/admin/firmware/provision/)
  — the *Admin → Firmware → Provision* tool that drives the flow and can mint a
  single-use zero-touch voucher (`createProvisioningVoucher()`).
- **SoftAP fallback:** [`firmware/main/main.c`](../../main/main.c) — when NVS
  holds no Wi-Fi credentials, first boot falls back to an open SoftAP + captive
  setup screen. USB/Improv is the intended primary path, but SoftAP is **not
  removed**; both remain available.
