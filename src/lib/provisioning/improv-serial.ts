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
 * `SerialProvisioningSession` drives the actual Web Serial connection (browser only).
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
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}
interface SerialLike {
  requestPort(options?: { filters?: { usbVendorId?: number }[] }): Promise<SerialPortLike>;
  addEventListener?(type: "disconnect", listener: (event: { target?: unknown }) => void): void;
  removeEventListener?(type: "disconnect", listener: (event: { target?: unknown }) => void): void;
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
// Opening the Web Serial port resets every supported display (through either
// its USB-UART bridge or the ESP32-P4 native USB-Serial/JTAG controller). D1001
// then initialises its LCD and ESP-Hosted C6 coprocessor before exposing Improv,
// which takes about 6.2 seconds on hardware. Leave a cold-boot safety margin.
const READY_PROBE_WINDOW_MS = 8_000;

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

interface ReadySerialConnection {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  writer: WritableStreamDefaultWriter<Uint8Array>;
}

/**
 * Open the port exactly once and keep it open through cold-boot readiness
 * probing and the real command. Opening is intentionally treated as the single
 * reset event on every supported transport. Never add a later DTR/RTS pulse:
 * that would restart the display twice and can race native USB enumeration.
 */
async function openReadyImprovConnection(
  port: SerialPortLike,
  onPhase?: (phase: ProvisionPhase) => void,
): Promise<ReadySerialConnection> {
  onPhase?.("connecting");
  await port.open({ baudRate: SERIAL_BAUD_RATE });
  onPhase?.("waking");

  const reader = port.readable?.getReader();
  const writer = port.writable?.getWriter();
  if (!reader || !writer) {
    await closeSerial(port, reader, writer);
    throw new Error("Serial port is not readable/writable.");
  }

  const parser = new ImprovParser();
  const startedAt = Date.now();
  const deadline = startedAt + READY_PROBE_WINDOW_MS + 3_000;
  let nextProbeAt = 0;
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;

  try {
    while (Date.now() < deadline) {
      const now = Date.now();
      if (now >= nextProbeAt) {
        await writer.write(encodeGetState());
        nextProbeAt = now + 500;
      }

      pendingRead ??= reader.read();
      const outcome = await Promise.race([
        pendingRead.then((result) => ({ kind: "read" as const, result })),
        sleep(100).then(() => ({ kind: "tick" as const })),
      ]);
      if (outcome.kind === "tick") continue;

      pendingRead = undefined;
      if (outcome.result.done) throw new Error("Serial connection closed unexpectedly.");
      if (!outcome.result.value) continue;
      if (parser.push(outcome.result.value).length > 0) {
        return { reader, writer };
      }
    }
  } catch (error) {
    await closeSerial(port, reader, writer);
    throw error;
  }

  await closeSerial(port, reader, writer);
  throw new Error("Timed out waiting for the device to restart and become ready over USB.");
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
 * Turn a thrown serial error into something an operator can act on.
 *
 * The case worth naming is a port already held by ESP Web Tools or another tab.
 * That does NOT fail at `requestPort()` — selecting a port always succeeds — it
 * fails later at `port.open()`, where the browser throws a bare DOMException:
 * Chrome says "Failed to open serial port." when another context holds it and
 * "The port is already open." for a double-open. Neither tells the operator that
 * closing the flash tool is the fix.
 *
 * Anything else is passed through unchanged: an invented explanation for an
 * unknown fault is worse than the browser's own wording.
 */
export function describeSerialError(e: unknown): string {
  const msg = e instanceof Error ? e.message : "Serial I/O error.";
  if (/already open|in use|failed to open/i.test(msg)) {
    return "Couldn't open the serial port — it's already in use. Close the flash tool or other tabs using it, then retry.";
  }
  return msg;
}

/**
 * One browser-owned USB session shared by readiness probing, any number of
 * Wi-Fi scans, and the final provisioning command. Operations are serialized
 * over one reader/writer pair so the port is opened — and the display reset —
 * exactly once.
 */
export class SerialProvisioningSession {
  private readonly parser = new ImprovParser();
  private pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  private operation: Promise<void> = Promise.resolve();
  private closed = false;
  private cleanedUp = false;
  private readonly disconnectListener: (event: { target?: unknown }) => void;

  private constructor(
    private readonly serial: SerialLike,
    private readonly port: SerialPortLike,
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly writer: WritableStreamDefaultWriter<Uint8Array>,
    onDisconnect?: () => void,
  ) {
    this.disconnectListener = (event) => {
      if (event.target && event.target !== this.port) return;
      if (this.closed) return;
      this.closed = true;
      this.cleanedUp = true;
      this.serial.removeEventListener?.("disconnect", this.disconnectListener);
      void closeSerial(this.port, this.reader, this.writer);
      onDisconnect?.();
    };
    serial.addEventListener?.("disconnect", this.disconnectListener);
  }

  static async connect(
    onPhase?: (phase: ProvisionPhase) => void,
    onDisconnect?: () => void,
  ): Promise<SerialProvisioningSession> {
    const serial = getSerial();
    if (!serial) throw new Error("Web Serial is not supported in this browser.");

    let port: SerialPortLike;
    try {
      // Show every port: E-series USB-UART bridges use non-Espressif VIDs.
      port = await serial.requestPort();
    } catch {
      throw new Error("No serial port selected. Make sure the device is connected via USB.");
    }

    try {
      const connection = await openReadyImprovConnection(port, onPhase);
      return new SerialProvisioningSession(serial, port, connection.reader, connection.writer, onDisconnect);
    } catch (error) {
      throw new Error(describeSerialError(error));
    }
  }

  get connected(): boolean {
    return !this.closed;
  }

  async scanNetworks(opts?: { timeoutMs?: number }): Promise<ScanResult> {
    return this.exclusive(async () => {
      this.assertConnected();
      const byName = new Map<string, WifiNetwork>();
      const deadline = Date.now() + (opts?.timeoutMs ?? 15_000);
      await this.writer.write(encodeScanWifi());

      while (Date.now() < deadline) {
        const frames = await this.readFrames(deadline - Date.now());
        if (!frames) break;
        for (const frame of frames) {
          if (frame.type !== ImprovType.RPC_RESULT) continue;
          const { cmd, strings } = decodeRpcResult(frame.payload);
          if (cmd !== ImprovCmd.SCAN_WIFI) continue;
          const network = decodeScanNetwork(strings);
          if (!network) {
            return { ok: true, networks: [...byName.values()].sort((a, b) => b.rssi - a.rssi) };
          }
          const previous = byName.get(network.ssid);
          if (!previous || network.rssi > previous.rssi) byName.set(network.ssid, network);
        }
      }

      return { ok: false, networks: [], error: "Timed out waiting for the Wi-Fi scan." };
    });
  }

  async provision(opts: ProvisionOptions): Promise<ProvisionResult> {
    return this.exclusive(async () => {
      this.assertConnected();
      const onPhase = opts.onPhase ?? (() => {});
      const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
      let legacyTimeFallbackAttempted = false;
      let provisionedAt: number | undefined;
      let redirectUrl: string | undefined;

      const send = async (withTime: boolean) => {
        onPhase("sending");
        await this.writer.write(encodeWifiSettings(
          opts.ssid,
          opts.password,
          opts.serverUrl,
          opts.deviceToken,
          opts.ntpServer,
          withTime ? (opts.provisionedAtUnix ?? Math.floor(Date.now() / 1000)) : undefined,
        ));
      };
      await send(true);

      while (Date.now() < deadline) {
        const graceDeadline = provisionedAt === undefined ? deadline : Math.min(deadline, provisionedAt + 600);
        const frames = await this.readFrames(graceDeadline - Date.now());
        if (!frames) {
          if (provisionedAt !== undefined) return { ok: true, redirectUrl };
          break;
        }

        for (const frame of frames) {
          if (frame.payload.length === 0) continue;
          if (frame.type === ImprovType.CURRENT_STATE) {
            const state = frame.payload[0];
            if (state === ImprovState.PROVISIONING) onPhase("provisioning");
            if (state === ImprovState.PROVISIONED) {
              onPhase("provisioned");
              provisionedAt ??= Date.now();
            }
          } else if (frame.type === ImprovType.ERROR_STATE) {
            const error = frame.payload[0];
            if (error === ImprovError.NONE) continue;
            if (error === ImprovError.INVALID_RPC && !legacyTimeFallbackAttempted) {
              legacyTimeFallbackAttempted = true;
              await send(false);
              continue;
            }
            const message = improvErrorMessage(error);
            onPhase("error", message);
            return { ok: false, error: message };
          } else if (frame.type === ImprovType.RPC_RESULT) {
            const { cmd, strings } = decodeRpcResult(frame.payload);
            if (cmd === ImprovCmd.WIFI_SETTINGS && strings[0]) {
              redirectUrl = strings[0];
              if (provisionedAt !== undefined) return { ok: true, redirectUrl };
            }
          }
        }
      }

      return {
        ok: false,
        error: "Timed out waiting for the device to respond after restarting. Press Refresh on the display and try again.",
      };
    });
  }

  async disconnect(): Promise<void> {
    if (this.cleanedUp) return;
    this.closed = true;
    this.cleanedUp = true;
    this.serial.removeEventListener?.("disconnect", this.disconnectListener);
    await closeSerial(this.port, this.reader, this.writer);
  }

  private assertConnected(): void {
    if (this.closed) throw new Error("The USB session is disconnected.");
  }

  private async readFrames(timeoutMs: number): Promise<ImprovFrame[] | null> {
    if (timeoutMs <= 0) return null;
    this.pendingRead ??= this.reader.read();
    const outcome = await Promise.race([
      this.pendingRead.then((result) => ({ kind: "read" as const, result })),
      sleep(timeoutMs).then(() => ({ kind: "timeout" as const })),
    ]);
    if (outcome.kind === "timeout") return null;
    this.pendingRead = undefined;
    if (outcome.result.done) {
      this.closed = true;
      throw new Error("Serial connection closed unexpectedly.");
    }
    return outcome.result.value ? this.parser.push(outcome.result.value) : [];
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }
}

/** Backwards-compatible one-shot helper for callers that do not own a session. */
export async function provisionOverSerial(opts: ProvisionOptions): Promise<ProvisionResult> {
  let session: SerialProvisioningSession | undefined;
  try {
    session = await SerialProvisioningSession.connect(opts.onPhase);
    return await session.provision(opts);
  } catch (error) {
    return { ok: false, error: describeSerialError(error) };
  } finally {
    await session?.disconnect();
  }
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
  let session: SerialProvisioningSession | undefined;
  try {
    session = await SerialProvisioningSession.connect();
    return await session.scanNetworks(opts);
  } catch (error) {
    return { ok: false, networks: [], error: describeSerialError(error) };
  } finally {
    await session?.disconnect();
  }
}
