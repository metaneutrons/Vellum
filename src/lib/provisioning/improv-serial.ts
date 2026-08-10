// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Improv Wi-Fi Serial client for browser-based device provisioning over USB.
 *
 * Byte-exact counterpart to firmware/components/vellum_serial/vellum_serial.c.
 * Frame layout (both directions):
 *
 *   "IMPROV"(6) | version(1)=0x01 | type(1) | len(1) | payload(len) | checksum(1)
 *
 * where checksum = (sum of the first 9+len bytes) & 0xFF.
 *
 * Vellum extends the standard Improv `WIFI_SETTINGS` RPC with optional
 * length-prefixed strings for the server URL, zero-touch voucher, and an
 * administrator-selected NTP server, and the client's current UTC Unix time.
 *
 * The pure encode/parse helpers here are environment-agnostic and unit-tested.
 * `provisionOverSerial()` drives the actual Web Serial connection (browser only).
 */

export const IMPROV_HEADER = [0x49, 0x4d, 0x50, 0x52, 0x4f, 0x56] as const; // "IMPROV"
export const IMPROV_VERSION = 0x01;

export const ImprovType = {
  CURRENT_STATE: 0x01,
  ERROR_STATE: 0x02,
  RPC_COMMAND: 0x03,
  RPC_RESULT: 0x04,
} as const;

export const ImprovCmd = {
  WIFI_SETTINGS: 0x01,
  GET_STATE: 0x02,
  GET_DEVICE_INFO: 0x03,
  SCAN_WIFI: 0x04,
} as const;

export const ImprovState = {
  READY: 0x02,
  PROVISIONING: 0x03,
  PROVISIONED: 0x04,
} as const;

export const ImprovError = {
  NONE: 0x00,
  INVALID_RPC: 0x01,
  UNKNOWN_CMD: 0x02,
  UNABLE_CONNECT: 0x03,
  INSECURE_URL: 0x04,
} as const;

// Firmware buffer limits (vellum_serial.c improv_handle_wifi_settings).
// SSID copies into ssid[33] (max 32), password into pass[65] (max 64).
export const MAX_SSID_LEN = 32;
export const MAX_PASS_LEN = 64;
export const MIN_PROVISIONING_UNIX_TIME = 1_704_067_200; // 2024-01-01T00:00:00Z
export const MAX_PROVISIONING_UNIX_TIME = 4_102_444_799; // 2099-12-31T23:59:59Z

function lenPrefixed(s: string): number[] {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length > 255) throw new Error("Improv: string exceeds 255 bytes");
  return [bytes.length, ...bytes];
}

function utcTimestampString(value: number): string {
  const seconds = Math.floor(value);
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < MIN_PROVISIONING_UNIX_TIME ||
    seconds > MAX_PROVISIONING_UNIX_TIME
  ) {
    throw new Error("Improv: UTC timestamp must be between 2024-01-01 and 2099-12-31");
  }
  return String(seconds);
}

/** 8-bit sum of `bytes[0 .. n-1]`. */
function checksum(bytes: number[]): number {
  let c = 0;
  for (const b of bytes) c = (c + b) & 0xff;
  return c;
}

/** Wrap a type + payload in an IMPROV frame (header, version, len, checksum). */
export function encodeFrame(type: number, payload: number[]): Uint8Array {
  const frame = [...IMPROV_HEADER, IMPROV_VERSION, type, payload.length, ...payload];
  frame.push(checksum(frame));
  return new Uint8Array(frame);
}

/** Encode an RPC_COMMAND frame: payload = [cmd, cmdLen, ...cmdPayload]. */
export function encodeRpcCommand(cmd: number, cmdPayload: number[]): Uint8Array {
  return encodeFrame(ImprovType.RPC_COMMAND, [cmd, cmdPayload.length, ...cmdPayload]);
}

/**
 * Encode a WIFI_SETTINGS command carrying SSID, password, and optional profile
 * fields. NTP is fifth and UTC time sixth to preserve existing clients.
 */
/** Encode a SCAN_WIFI command (no payload). */
export function encodeScanWifi(): Uint8Array {
  return encodeRpcCommand(ImprovCmd.SCAN_WIFI, []);
}

/** Request the current Improv state without changing device configuration. */
export function encodeGetState(): Uint8Array {
  return encodeRpcCommand(ImprovCmd.GET_STATE, []);
}

export function encodeWifiSettings(
  ssid: string,
  password: string,
  serverUrl?: string,
  deviceToken?: string,
  ntpServer?: string,
  provisionedAtUnix?: number,
): Uint8Array {
  const payload = [...lenPrefixed(ssid), ...lenPrefixed(password)];
  const hasTime = provisionedAtUnix !== undefined;
  // URL, token, NTP, and UTC time are positional. Emit empty placeholders when
  // a later field is provided so older firmware can still parse earlier forms.
  if (serverUrl || deviceToken || ntpServer !== undefined || hasTime) payload.push(...lenPrefixed(serverUrl ?? ""));
  if (deviceToken || ntpServer !== undefined || hasTime) payload.push(...lenPrefixed(deviceToken ?? ""));
  if (ntpServer !== undefined || hasTime) payload.push(...lenPrefixed(ntpServer ?? ""));
  if (hasTime) payload.push(...lenPrefixed(utcTimestampString(provisionedAtUnix)));
  if (payload.length > MAX_WIFI_SETTINGS_PAYLOAD) {
    // The payload becomes a 1-byte cmd_len (and the frame's 1-byte data_len is
    // cmd_len+2), so it can't exceed 253 or the length wraps and the firmware
    // rejects the frame. Fail loudly instead of sending a corrupt frame.
    throw new Error(
      `Improv profile too large (${payload.length} > ${MAX_WIFI_SETTINGS_PAYLOAD} bytes) — shorten the server URL.`,
    );
  }
  return encodeRpcCommand(ImprovCmd.WIFI_SETTINGS, payload);
}

/**
 * Max bytes for the WIFI_SETTINGS RPC payload. It becomes a single-byte cmd_len,
 * and the frame's single-byte data_len is cmd_len+2, so the payload must be ≤253.
 */
export const MAX_WIFI_SETTINGS_PAYLOAD = 253;

/** Byte length the WIFI_SETTINGS payload would occupy — for pre-send validation. */
export function wifiSettingsPayloadLength(
  ssid: string,
  password: string,
  serverUrl?: string,
  deviceToken?: string,
  ntpServer?: string,
  provisionedAtUnix?: number,
): number {
  const enc = new TextEncoder();
  const hasTime = provisionedAtUnix !== undefined;
  let n = 1 + enc.encode(ssid).length + 1 + enc.encode(password).length;
  if (serverUrl || deviceToken || ntpServer !== undefined || hasTime) n += 1 + enc.encode(serverUrl ?? "").length;
  if (deviceToken || ntpServer !== undefined || hasTime) n += 1 + enc.encode(deviceToken ?? "").length;
  if (ntpServer !== undefined || hasTime) n += 1 + enc.encode(ntpServer ?? "").length;
  if (hasTime) n += 1 + enc.encode(utcTimestampString(provisionedAtUnix)).length;
  return n;
}

export interface ImprovFrame {
  type: number;
  /** The `len` payload bytes (between the length byte and the checksum). */
  payload: Uint8Array;
}

/**
 * Streaming frame parser. The device interleaves binary IMPROV frames with
 * plain-text console output, so this scans for the "IMPROV" magic, validates
 * the checksum, and drops everything else (console noise). Feed it chunks from
 * the serial reader; it returns whatever complete frames became available.
 */
export class ImprovParser {
  private buf: number[] = [];

  push(chunk: Uint8Array): ImprovFrame[] {
    const out: ImprovFrame[] = [];
    for (const b of chunk) this.buf.push(b);

    for (;;) {
      // Discard bytes until the buffer starts with a prefix of the header.
      const start = this.headerStart();
      if (start < 0) {
        // No possible header — keep only a trailing partial-header window.
        this.buf = this.buf.slice(Math.max(0, this.buf.length - 5));
        break;
      }
      if (start > 0) this.buf.splice(0, start);
      if (this.buf.length < 10) break; // need full header + len + checksum

      const len = this.buf[8];
      const frameLen = 10 + len;
      if (this.buf.length < frameLen) break; // wait for the rest

      const frame = this.buf.slice(0, frameLen);
      const ok =
        frame[6] === IMPROV_VERSION &&
        checksum(frame.slice(0, 9 + len)) === frame[9 + len];
      if (ok) {
        out.push({ type: frame[7], payload: new Uint8Array(frame.slice(9, 9 + len)) });
        this.buf.splice(0, frameLen);
      } else {
        // Bad frame (or "IMPROV" appearing in console text) — resync past it.
        this.buf.splice(0, 1);
      }
    }
    return out;
  }

  /** Index of the first position where the buffer matches a header prefix, or -1. */
  private headerStart(): number {
    for (let i = 0; i < this.buf.length; i++) {
      let match = true;
      for (let j = 0; j < IMPROV_HEADER.length && i + j < this.buf.length; j++) {
        if (this.buf[i + j] !== IMPROV_HEADER[j]) {
          match = false;
          break;
        }
      }
      if (match) return i;
    }
    return -1;
  }
}

/** Decode an RPC_RESULT payload into its length-prefixed strings. */
export function decodeRpcResult(payload: Uint8Array): { cmd: number; strings: string[] } {
  const cmd = payload[0];
  const dataLen = payload[1];
  const strings: string[] = [];
  let pos = 2;
  const end = Math.min(2 + dataLen, payload.length);
  const dec = new TextDecoder();
  while (pos < end) {
    const slen = payload[pos++];
    strings.push(dec.decode(payload.slice(pos, pos + slen)));
    pos += slen;
  }
  return { cmd, strings };
}

/* ── Web Serial orchestration (browser only) ─────────────────────────────── */

// Minimal local typing so we don't depend on lib.dom Web Serial defs.
interface SerialPortLike {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  /**
   * Optional in Web Serial because native USB serial ports need not expose
   * modem-control lines. USB-UART bridges such as the E1003's CH340 do.
   */
  setSignals?(signals: {
    dataTerminalReady?: boolean;
    requestToSend?: boolean;
  }): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}
interface SerialLike {
  requestPort(options?: { filters?: { usbVendorId?: number }[] }): Promise<SerialPortLike>;
}

export function isWebSerialSupported(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

function getSerial(): SerialLike | undefined {
  return (navigator as unknown as { serial?: SerialLike }).serial;
}

export type ProvisionPhase =
  | "connecting"
  | "checking"
  | "waking"
  | "sending"
  | "provisioning"
  | "provisioned"
  | "error";

export interface ProvisionResult {
  ok: boolean;
  redirectUrl?: string;
  error?: string;
}

export interface ProvisionOptions {
  ssid: string;
  password: string;
  serverUrl?: string;
  /** Optional administrator NTP server. Overrides DHCP and firmware fallbacks. */
  ntpServer?: string;
  /** Optional pre-provisioning voucher token for zero-touch enrolment. */
  deviceToken?: string;
  /** Browser UTC Unix time, persisted to a hardware RTC when the model has one. */
  provisionedAtUnix?: number;
  /** Progress callback for UI. */
  onPhase?: (phase: ProvisionPhase, detail?: string) => void;
  /** Overall timeout for the device to report PROVISIONED/error (ms). */
  timeoutMs?: number;
}

const SERIAL_BAUD_RATE = 115_200;
const PROBE_TIMEOUT_MS = 900;
const RESET_PULSE_MS = 150;
// An E1003 takes roughly three seconds to initialise its e-paper controller
// before its serial console and Improv handler are ready.
const RESET_BOOT_WAIT_MS = 3_500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function closeSerial(
  port: SerialPortLike,
  reader?: ReadableStreamDefaultReader<Uint8Array>,
  writer?: WritableStreamDefaultWriter<Uint8Array>,
): Promise<void> {
  try {
    await reader?.cancel();
  } catch {
    /* A silent device is expected while probing. */
  }
  reader?.releaseLock();
  writer?.releaseLock();
  await port.close().catch(() => {});
}

/**
 * Check that the selected device is alive before ever touching control lines.
 * GET_STATE is an idempotent Improv command, so a waking device cannot receive
 * Wi-Fi credentials or otherwise change state during this probe.
 */
async function probeImprovDevice(port: SerialPortLike): Promise<boolean> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  try {
    await port.open({ baudRate: SERIAL_BAUD_RATE });
    // Keep both active-low bridge outputs released while testing an awake
    // device. This is a no-op on USB-Serial-JTAG ports.
    await port.setSignals?.({ dataTerminalReady: false, requestToSend: false });
    reader = port.readable?.getReader();
    writer = port.writable?.getWriter();
    if (!reader || !writer) return false;

    const parser = new ImprovParser();
    await writer.write(encodeGetState());
    return await Promise.race([
      reader.read().then(({ value, done }) => {
        if (done || !value) return false;
        return parser.push(value).length > 0;
      }),
      sleep(PROBE_TIMEOUT_MS).then(() => false),
    ]);
  } catch {
    return false;
  } finally {
    await closeSerial(port, reader, writer);
  }
}

/**
 * Wake a sleeping ESP over an auto-reset capable USB-UART bridge. DTR must
 * remain released (normal boot); pulsing active-low RTS drives ESP_EN/reset.
 * This deliberately does not use the bootloader sequence or alter flash.
 */
async function pulseSerialReset(port: SerialPortLike): Promise<boolean> {
  if (!port.setSignals) return false;
  try {
    await port.open({ baudRate: SERIAL_BAUD_RATE });
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    await sleep(50);
    await port.setSignals({ requestToSend: true });
    await sleep(RESET_PULSE_MS);
    await port.setSignals({ requestToSend: false });
    return true;
  } catch {
    return false;
  } finally {
    await port.close().catch(() => {});
  }
}

/**
 * Prefer a non-disruptive Improv probe. Only devices that do not answer are
 * given one USB-UART reset attempt, which wakes supported sleeping displays.
 */
async function wakeIfNeeded(
  port: SerialPortLike,
  onPhase?: (phase: ProvisionPhase) => void,
): Promise<boolean> {
  onPhase?.("checking");
  if (await probeImprovDevice(port)) return false;

  onPhase?.("waking");
  const resetSent = await pulseSerialReset(port);
  if (resetSent) await sleep(RESET_BOOT_WAIT_MS);
  return resetSent;
}

const ERROR_TEXT: Record<number, string> = {
  [ImprovError.INVALID_RPC]: "Device rejected the request (invalid RPC).",
  [ImprovError.UNKNOWN_CMD]: "Device does not support this command.",
  [ImprovError.UNABLE_CONNECT]: "Device could not join the Wi-Fi network (check SSID/password).",
  [ImprovError.INSECURE_URL]:
    "This production firmware requires an https:// server URL. No settings were changed.",
};

/** Convert a device-side Improv error code into a user-facing explanation. */
export function improvErrorMessage(error: number): string {
  return ERROR_TEXT[error] ?? `Device error 0x${error.toString(16)}.`;
}

/**
 * Provision a Vellum device over USB via Web Serial. Prompts the user for a
 * serial port, pushes the profile, and resolves once the device reports
 * PROVISIONED (or an error / timeout). Browser-only.
 */
export async function provisionOverSerial(opts: ProvisionOptions): Promise<ProvisionResult> {
  const serial = getSerial();
  if (!serial) return { ok: false, error: "Web Serial is not supported in this browser." };

  const onPhase = opts.onPhase ?? (() => {});
  const timeoutMs = opts.timeoutMs ?? 30_000;

  let port: SerialPortLike;
  try {
    // Show ALL serial ports (no VID filter) — exactly like ESP Web Tools does
    // for flashing. A device on a USB-UART bridge (CP210x/CH340/FTDI) has a
    // non-Espressif VID and an exclusive filter would hide it entirely — which
    // is why flashing worked but provisioning reported "no serial port".
    port = await serial.requestPort();
  } catch {
    return { ok: false, error: "No serial port selected. Make sure the device is connected via USB and isn't open in another tab." };
  }

  // Try an idempotent state query first. A sleeping E1003 has no UART task,
  // but its CH340 control lines can reset it safely without flashing.
  const resetAttempted = await wakeIfNeeded(port, (phase) => onPhase(phase));

  const parser = new ImprovParser();
  const done: ProvisionResult = { ok: false };
  let settled = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let opened = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let legacyTimeFallbackAttempted = false;

  // finish() also cancels the reader so a pending reader.read() unblocks and the
  // loop exits — otherwise a silent device would hang past the timeout.
  const finish = (r: ProvisionResult) => {
    if (settled) return;
    settled = true;
    Object.assign(done, r);
    reader?.cancel().catch(() => {});
  };

  const timer = setTimeout(
    () => finish({
      ok: false,
      error: resetAttempted
        ? "Timed out after attempting to wake the display over USB. Press Refresh on the display and try again."
        : "Timed out waiting for the device to respond. Press Refresh on the display and try again.",
    }),
    timeoutMs,
  );

  try {
    onPhase("connecting");
    await port.open({ baudRate: SERIAL_BAUD_RATE }); // baud is ignored by USB-Serial-JTAG
    opened = true;
    writer = port.writable?.getWriter();
    reader = port.readable?.getReader();
    if (!writer || !reader) {
      finish({ ok: false, error: "Serial port is not readable/writable." });
    } else {
      onPhase("sending");
      await writer.write(
        encodeWifiSettings(
          opts.ssid,
          opts.password,
          opts.serverUrl,
          opts.deviceToken,
          opts.ntpServer,
          opts.provisionedAtUnix ?? Math.floor(Date.now() / 1000),
        ),
      );

      while (!settled) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) {
          finish({ ok: false, error: "Serial connection closed unexpectedly." });
          break;
        }
        if (!value) continue;
        for (const frame of parser.push(value)) {
          if (frame.payload.length === 0) continue; // ignore malformed empty frames
          if (frame.type === ImprovType.CURRENT_STATE) {
            const state = frame.payload[0];
            if (state === ImprovState.PROVISIONING) onPhase("provisioning");
            else if (state === ImprovState.PROVISIONED) {
              onPhase("provisioned");
              done.ok = true;
              // The device sends the redirect RPC_RESULT just after PROVISIONED,
              // possibly in a later chunk — wait a short grace to capture it.
              if (!graceTimer) graceTimer = setTimeout(() => finish({ ok: true }), 600);
            }
          } else if (frame.type === ImprovType.ERROR_STATE) {
            const err = frame.payload[0];
            if (err !== ImprovError.NONE) {
              // Firmware predating the sixth UTC field rejects the otherwise
              // valid profile as INVALID_RPC. Retry once in the legacy five-field
              // form so existing field devices remain provisionable during rollout.
              if (err === ImprovError.INVALID_RPC && !legacyTimeFallbackAttempted) {
                legacyTimeFallbackAttempted = true;
                onPhase("sending");
                await writer.write(
                  encodeWifiSettings(
                    opts.ssid,
                    opts.password,
                    opts.serverUrl,
                    opts.deviceToken,
                    opts.ntpServer,
                  ),
                );
                continue;
              }
              const msg = improvErrorMessage(err);
              onPhase("error", msg);
              finish({ ok: false, error: msg });
            }
          } else if (frame.type === ImprovType.RPC_RESULT) {
            const { cmd, strings } = decodeRpcResult(frame.payload);
            if (cmd === ImprovCmd.WIFI_SETTINGS && strings[0]) {
              done.redirectUrl = strings[0];
              if (done.ok) finish({ ok: true, redirectUrl: strings[0] });
            }
          }
        }
      }
    }
  } catch (e) {
    finish({ ok: false, error: e instanceof Error ? e.message : "Serial I/O error." });
  } finally {
    clearTimeout(timer);
    if (graceTimer) clearTimeout(graceTimer);
    if (opened) await closeSerial(port, reader, writer);
  }

  return done;
}

export interface WifiNetwork {
  ssid: string;
  rssi: number;
  /** true if the network requires a password. */
  secured: boolean;
}

export interface ScanResult {
  ok: boolean;
  networks: WifiNetwork[];
  error?: string;
}

/** Decode a SCAN_WIFI RPC_RESULT (`[ssid, rssi, "YES"|"NO"]`) into a network. */
export function decodeScanNetwork(strings: string[]): WifiNetwork | null {
  if (strings.length < 3) return null; // empty result = list terminator
  const [ssid, rssi, auth] = strings;
  if (!ssid) return null;
  return { ssid, rssi: Number.parseInt(rssi, 10) || 0, secured: auth === "YES" };
}

/**
 * Ask the device to scan for nearby Wi-Fi networks (Improv SCAN_WIFI) and
 * return the deduped list, strongest signal first. Browser-only.
 */
export async function scanNetworksOverSerial(opts?: {
  timeoutMs?: number;
}): Promise<ScanResult> {
  const serial = getSerial();
  if (!serial) return { ok: false, networks: [], error: "Web Serial is not supported." };

  let port: SerialPortLike;
  try {
    port = await serial.requestPort(); // show all ports — see provisionOverSerial
  } catch {
    return { ok: false, networks: [], error: "No serial port selected. Make sure the device is connected via USB." };
  }

  await wakeIfNeeded(port);

  const parser = new ImprovParser();
  const byName = new Map<string, WifiNetwork>();
  let finished = false;
  let error: string | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let opened = false;

  // Cancel the reader on timeout so a pending read unblocks (the scan may never
  // receive the empty terminator from a misbehaving device).
  const timer = setTimeout(() => {
    finished = true;
    reader?.cancel().catch(() => {});
  }, opts?.timeoutMs ?? 8000);

  try {
    await port.open({ baudRate: SERIAL_BAUD_RATE });
    opened = true;
    writer = port.writable?.getWriter();
    reader = port.readable?.getReader();
    if (!writer || !reader) {
      error = "Serial port is not readable/writable.";
    } else {
      await writer.write(encodeScanWifi());
      while (!finished) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        if (!value) continue;
        for (const frame of parser.push(value)) {
          if (frame.type !== ImprovType.RPC_RESULT) continue;
          const { cmd, strings } = decodeRpcResult(frame.payload);
          if (cmd !== ImprovCmd.SCAN_WIFI) continue;
          const net = decodeScanNetwork(strings);
          if (net) {
            const prev = byName.get(net.ssid);
            if (!prev || net.rssi > prev.rssi) byName.set(net.ssid, net);
          } else {
            finished = true; // empty terminator
            break;
          }
        }
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : "Serial I/O error.";
  } finally {
    clearTimeout(timer);
    if (opened) await closeSerial(port, reader, writer);
  }

  if (error) return { ok: false, networks: [], error };
  const networks = [...byName.values()].sort((a, b) => b.rssi - a.rssi);
  return { ok: true, networks };
}
