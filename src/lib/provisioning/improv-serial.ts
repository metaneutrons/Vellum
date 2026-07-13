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
 * Vellum extends the standard Improv `WIFI_SETTINGS` RPC with an optional THIRD
 * length-prefixed string carrying the server URL, so a single command can push
 * a complete device profile (SSID + password + server URL).
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
} as const;

// Firmware buffer limits (vellum_serial.c improv_handle_wifi_settings).
// SSID copies into ssid[33] (max 32), password into pass[65] (max 64).
export const MAX_SSID_LEN = 32;
export const MAX_PASS_LEN = 64;

function lenPrefixed(s: string): number[] {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length > 255) throw new Error("Improv: string exceeds 255 bytes");
  return [bytes.length, ...bytes];
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
 * Encode a WIFI_SETTINGS command carrying ssid + password + optional serverUrl.
 * The cmd payload is `ssid_len|ssid|pass_len|pass|[url_len|url]`, exactly what
 * `improv_handle_wifi_settings` parses.
 */
/** Encode a SCAN_WIFI command (no payload). */
export function encodeScanWifi(): Uint8Array {
  return encodeRpcCommand(ImprovCmd.SCAN_WIFI, []);
}

export function encodeWifiSettings(
  ssid: string,
  password: string,
  serverUrl?: string,
  deviceToken?: string,
): Uint8Array {
  const payload = [...lenPrefixed(ssid), ...lenPrefixed(password)];
  // The device token is the optional 4TH string; the server URL is the 3rd and
  // acts as its positional separator, so emit an empty URL placeholder if a
  // token is supplied without one.
  if (serverUrl || deviceToken) payload.push(...lenPrefixed(serverUrl ?? ""));
  if (deviceToken) payload.push(...lenPrefixed(deviceToken));
  return encodeRpcCommand(ImprovCmd.WIFI_SETTINGS, payload);
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
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}
interface SerialLike {
  requestPort(options?: { filters?: { usbVendorId?: number }[] }): Promise<SerialPortLike>;
}

const ESPRESSIF_USB_VENDOR_ID = 0x303a;

export function isWebSerialSupported(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

function getSerial(): SerialLike | undefined {
  return (navigator as unknown as { serial?: SerialLike }).serial;
}

export type ProvisionPhase =
  | "connecting"
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
  /** Optional pre-provisioning voucher token for zero-touch enrolment. */
  deviceToken?: string;
  /** Progress callback for UI. */
  onPhase?: (phase: ProvisionPhase, detail?: string) => void;
  /** Overall timeout for the device to report PROVISIONED/error (ms). */
  timeoutMs?: number;
  /** Skip the Espressif VID filter in the port picker (show all serial ports). */
  anyPort?: boolean;
}

const ERROR_TEXT: Record<number, string> = {
  [ImprovError.INVALID_RPC]: "Device rejected the request (invalid RPC).",
  [ImprovError.UNKNOWN_CMD]: "Device does not support this command.",
  [ImprovError.UNABLE_CONNECT]: "Device could not join the Wi-Fi network (check SSID/password).",
};

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
    port = await serial.requestPort(
      opts.anyPort ? undefined : { filters: [{ usbVendorId: ESPRESSIF_USB_VENDOR_ID }] },
    );
  } catch {
    return { ok: false, error: "No serial port selected." };
  }

  onPhase("connecting");
  await port.open({ baudRate: 115200 }); // baud is ignored by USB-Serial-JTAG

  const parser = new ImprovParser();
  const writer = port.writable?.getWriter();
  const reader = port.readable?.getReader();
  if (!writer || !reader) {
    await port.close();
    return { ok: false, error: "Serial port is not readable/writable." };
  }

  const done: ProvisionResult = { ok: false };
  let settled = false;
  const finish = (r: ProvisionResult) => {
    if (!settled) {
      settled = true;
      Object.assign(done, r);
    }
  };

  const timer = setTimeout(
    () => finish({ ok: false, error: "Timed out waiting for the device to respond." }),
    timeoutMs,
  );

  try {
    onPhase("sending");
    await writer.write(
      encodeWifiSettings(opts.ssid, opts.password, opts.serverUrl, opts.deviceToken),
    );

    while (!settled) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) {
        finish({ ok: false, error: "Serial connection closed unexpectedly." });
        break;
      }
      if (!value) continue;
      for (const frame of parser.push(value)) {
        if (frame.type === ImprovType.CURRENT_STATE) {
          const state = frame.payload[0];
          if (state === ImprovState.PROVISIONING) onPhase("provisioning");
          else if (state === ImprovState.PROVISIONED) {
            onPhase("provisioned");
            finish({ ok: true });
          }
        } else if (frame.type === ImprovType.ERROR_STATE) {
          const err = frame.payload[0];
          if (err !== ImprovError.NONE) {
            const msg = ERROR_TEXT[err] ?? `Device error 0x${err.toString(16)}.`;
            onPhase("error", msg);
            finish({ ok: false, error: msg });
          }
        } else if (frame.type === ImprovType.RPC_RESULT) {
          const { cmd, strings } = decodeRpcResult(frame.payload);
          if (cmd === ImprovCmd.WIFI_SETTINGS && strings[0]) {
            done.redirectUrl = strings[0];
          }
        }
      }
    }
  } catch (e) {
    finish({ ok: false, error: e instanceof Error ? e.message : "Serial I/O error." });
  } finally {
    clearTimeout(timer);
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    reader.releaseLock();
    writer.releaseLock();
    await port.close().catch(() => {});
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
  anyPort?: boolean;
  timeoutMs?: number;
}): Promise<ScanResult> {
  const serial = getSerial();
  if (!serial) return { ok: false, networks: [], error: "Web Serial is not supported." };

  let port: SerialPortLike;
  try {
    port = await serial.requestPort(
      opts?.anyPort ? undefined : { filters: [{ usbVendorId: ESPRESSIF_USB_VENDOR_ID }] },
    );
  } catch {
    return { ok: false, networks: [], error: "No serial port selected." };
  }

  await port.open({ baudRate: 115200 });
  const parser = new ImprovParser();
  const writer = port.writable?.getWriter();
  const reader = port.readable?.getReader();
  if (!writer || !reader) {
    await port.close();
    return { ok: false, networks: [], error: "Serial port is not readable/writable." };
  }

  const byName = new Map<string, WifiNetwork>();
  let finished = false;
  const timer = setTimeout(() => {
    finished = true;
  }, opts?.timeoutMs ?? 8000);

  try {
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
  } catch (e) {
    clearTimeout(timer);
    return {
      ok: false,
      networks: [],
      error: e instanceof Error ? e.message : "Serial I/O error.",
    };
  } finally {
    clearTimeout(timer);
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    reader.releaseLock();
    writer.releaseLock();
    await port.close().catch(() => {});
  }

  const networks = [...byName.values()].sort((a, b) => b.rssi - a.rssi);
  return { ok: true, networks };
}
