// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const token = process.env.UPDATER_TOKEN ?? "";
const intervalSeconds = Number(process.env.POLL_INTERVAL_SECONDS ?? 900);
const operationTimeoutMs = Number(process.env.UPDATE_TIMEOUT_SECONDS ?? 900) * 1000;
const port = Number(process.env.CONTROL_PORT ?? 8080);
// This repository publishes independent server and firmware releases. GitHub's
// /releases/latest endpoint is repository-wide, so a newer firmware-v* release
// can hide the newest server release. Fetch the release collection and select by
// component instead.
const releaseApi = process.env.RELEASE_API ?? "https://api.github.com/repos/metaneutrons/Vellum/releases?per_page=100";
/* Own image version, baked in at build time (Dockerfile ARG UPDATER_VERSION).
 * Current updaters can hand their replacement to a detached, health-checked
 * helper. Older updaters omit these fields, which lets the UI show the one-time
 * manual bootstrap instead of prescribing manual maintenance forever. */
const updaterVersion = (process.env.UPDATER_VERSION ?? "").trim() || null;
const updaterSelfUpdateCapable = true;
const updaterSelfUpdateEnabled = (process.env.AUTO_UPDATE_UPDATER ?? "true") === "true";
const swapResultFile = process.env.SWAP_RESULT_FILE ?? "/state/updater-swap.json";
const progressFile = process.env.PROGRESS_FILE ?? "/state/updater-progress.json";
/* Outcome of the last self-update, written by the detached helper that performed
 * it. The container that did the swap is gone by the time anyone can ask, so the
 * NEW updater reads the file and reports it — otherwise a failed or rolled-back
 * swap would be invisible outside the container logs. */
function lastSwap() {
  try {
    const value = JSON.parse(readFileSync(swapResultFile, "utf8"));
    if (!value || typeof value.outcome !== "string") return null;
    if (!["succeeded", "failed", "rolled-back"].includes(value.outcome)) return null;
    return {
      outcome: value.outcome,
      detail: typeof value.detail === "string" ? value.detail.slice(0, 300) : null,
      at: typeof value.at === "string" ? value.at : null,
    };
  } catch { return null; }
}
const target = process.env.TARGET_CONTAINER ?? "vellum";
const configFile = process.env.UPDATER_CONFIG_FILE ?? "/state/config.json";
const defaultConfig = {
  mode: (process.env.AUTO_APPLY ?? "true") === "true" ? "automatic" : "manual",
  maintenanceTime: process.env.MAINTENANCE_TIME ?? "02:00",
  timezone: process.env.TZ ?? "UTC",
  lastAutomaticAttemptDate: null,
};

function validTimezone(value) {
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; } catch { return false; }
}
function validateConfig(value) {
  return value && ["manual", "automatic"].includes(value.mode) && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.maintenanceTime)
    && typeof value.timezone === "string" && value.timezone.length <= 100 && validTimezone(value.timezone)
    && (value.lastAutomaticAttemptDate == null || /^\d{4}-\d{2}-\d{2}$/.test(value.lastAutomaticAttemptDate));
}
if (process.env.VELLUM_UPDATER_TEST !== "true") {
  if (token.length < 32) throw new Error("UPDATER_TOKEN must contain at least 32 characters");
  // vellum.env.example ships UPDATER_TOKEN=replace-with-openssl-rand-hex-32, which
  // is exactly 32 characters and would otherwise pass the check above — leaving
  // this root-equivalent control API guarded by a token published in the repo.
  if (/replace[-_]with|change[-_]?me/i.test(token)) {
    throw new Error("UPDATER_TOKEN still contains the example placeholder — generate a real value with: openssl rand -hex 32");
  }
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 300) throw new Error("POLL_INTERVAL_SECONDS must be at least 300");
  if (!Number.isInteger(operationTimeoutMs) || operationTimeoutMs < 60_000) throw new Error("UPDATE_TIMEOUT_SECONDS must be at least 60");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("CONTROL_PORT is invalid");
  if (!validateConfig(defaultConfig)) throw new Error("invalid default update schedule");
}

function loadConfig() {
  try {
    const stored = JSON.parse(readFileSync(configFile, "utf8"));
    if (validateConfig(stored)) return { ...defaultConfig, ...stored };
    console.error("vellum-updater: ignoring invalid persisted configuration");
  } catch (error) {
    if (error?.code !== "ENOENT") console.error(`vellum-updater: cannot read persisted configuration: ${error}`);
  }
  return { ...defaultConfig };
}
let config = loadConfig();
function saveConfig() {
  mkdirSync(dirname(configFile), { recursive: true, mode: 0o700 });
  const temporary = `${configFile}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  renameSync(temporary, configFile);
}

const status = { state: "starting", currentVersion: null, availableVersion: null,
  updateAvailable: false, lastCheckedAt: null, lastUpdatedAt: null, lastError: null,
  updaterVersion, updaterUpdateAvailable: false, updaterSelfUpdateCapable,
  updaterSelfUpdateEnabled };
let active = false;

const PHASES = ["verifying", "backing-up", "deploying", "waiting-for-health", "done", "rolling-back", "failed"];
/* The phase journal written by update.sh. The server is the thing being replaced,
 * so it cannot report its own restart — this is the only progress the admin UI
 * can show while the container is gone, and it is read back afterwards to
 * reconstruct what happened. */
function lastProgress() {
  try {
    const value = JSON.parse(readFileSync(progressFile, "utf8"));
    if (!value || !PHASES.includes(value.phase)) return null;
    return {
      phase: value.phase,
      detail: typeof value.detail === "string" ? value.detail.slice(0, 200) : null,
      at: typeof value.at === "string" ? value.at : null,
      startedAt: typeof value.startedAt === "string" ? value.startedAt : null,
    };
  } catch { return null; }
}

function publicStatus() {
  return { ...status, updateMode: config.mode, maintenanceTime: config.maintenanceTime, timezone: config.timezone,
    updaterSwap: lastSwap(), progress: lastProgress() };
}
function equalToken(candidate) {
  const a = Buffer.from(candidate ?? ""); const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
function parts(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value ?? "");
  return match ? match.slice(1).map(Number) : null;
}
function newer(current, candidate) {
  const a = parts(current); const b = parts(candidate);
  if (!b) return false;
  if (!a) return true;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return b[i] > a[i]; }
  return false;
}
function stableServerReleaseTag(payload) {
  const releases = Array.isArray(payload) ? payload : [payload];
  return releases
    .filter((release) => release && release.draft === false && release.prerelease === false
      && /^v\d+\.\d+\.\d+$/.test(release.tag_name ?? ""))
    .map((release) => release.tag_name)
    .sort((left, right) => {
      const a = parts(left); const b = parts(right);
      for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return b[i] - a[i]; }
      return 0;
    })[0] ?? null;
}
function zonedClock(date, timezone) {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric",
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}
function command(commandName, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, args, { timeout: operationTimeoutMs, killSignal: "SIGTERM", ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; process.stderr.write(data); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `${commandName} exited ${code}`)));
  });
}
async function currentVersion() {
  const image = await command("docker", ["inspect", "--format", "{{.Image}}", target]);
  return command("docker", ["image", "inspect", "--format", '{{ index .Config.Labels "org.opencontainers.image.version" }}', image]);
}
async function releaseVersion() {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "vellum-updater" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(releaseApi, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`GitHub Releases returned HTTP ${response.status}`);
  const tag = stableServerReleaseTag(await response.json());
  if (!tag) throw new Error("GitHub Releases contains no stable Vellum server release");
  return tag;
}
async function check() {
  if (active) return;
  active = true; status.state = "checking"; status.lastError = null;
  try {
    const [current, available] = await Promise.all([currentVersion(), releaseVersion()]);
    status.currentVersion = current || null; status.availableVersion = available;
    status.updateAvailable = newer(current, available); status.lastCheckedAt = new Date().toISOString();
    /* Both images are pinned to the same release tag by deployment-assets.yml, so
     * the server's candidate release is also the updater's candidate. */
    status.updaterUpdateAvailable = newer(updaterVersion, available);
    status.state = status.updateAvailable ? "available" : "current";
  } catch (error) {
    status.state = "failed"; status.lastError = String(error instanceof Error ? error.message : error).slice(0, 500);
  } finally { active = false; }
  await tryScheduledApply();
}
async function apply() {
  if (active) return false;
  active = true; status.state = "updating"; status.lastError = null;
  try {
    await command("/usr/local/bin/vellum-update", [], { env: { ...process.env, UPDATE_ONCE: "true" } });
    status.currentVersion = status.availableVersion; status.updateAvailable = false;
    status.lastUpdatedAt = new Date().toISOString(); status.state = "current";
  } catch (error) {
    status.state = "failed"; status.lastError = String(error instanceof Error ? error.message : error).slice(0, 500);
  } finally { active = false; }
  return true;
}
async function tryScheduledApply(now = new Date()) {
  if (active || !status.updateAvailable || config.mode !== "automatic") return false;
  const clock = zonedClock(now, config.timezone);
  if (clock.time !== config.maintenanceTime || clock.date === config.lastAutomaticAttemptDate) return false;
  config.lastAutomaticAttemptDate = clock.date;
  saveConfig();
  return apply();
}
function send(response, code, body) {
  response.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; if (body.length > 4096) request.destroy(); });
    request.on("end", () => { try { resolve(JSON.parse(body)); } catch { reject(new Error("invalid_json")); } });
    request.on("error", reject);
  });
}
function startServer() { return createServer(async (request, response) => {
  try {
    if (!equalToken(request.headers.authorization?.replace(/^Bearer /, ""))) return send(response, 401, { error: "unauthorized" });
    if (request.method === "GET" && request.url === "/v1/status") return send(response, 200, publicStatus());
    if (request.method === "POST" && request.url === "/v1/check") {
      if (active) return send(response, 409, { error: "operation_in_progress", status: publicStatus() });
      void check(); return send(response, 202, publicStatus());
    }
    if (request.method === "POST" && request.url === "/v1/apply") {
      if (active) return send(response, 409, { error: "operation_in_progress", status: publicStatus() });
      if (!status.updateAvailable) return send(response, 200, publicStatus());
      void apply(); return send(response, 202, publicStatus());
    }
    if (request.method === "POST" && request.url === "/v1/config") {
      if (active) return send(response, 409, { error: "operation_in_progress", status: publicStatus() });
      const input = await readJson(request);
      if (!validateConfig(input)) return send(response, 400, { error: "invalid_config" });
      config = { mode: input.mode, maintenanceTime: input.maintenanceTime, timezone: input.timezone,
        lastAutomaticAttemptDate: null };
      saveConfig();
      void tryScheduledApply();
      return send(response, 200, publicStatus());
    }
    return send(response, 404, { error: "not_found" });
  } catch (error) {
    console.error(`vellum-updater: control request failed: ${error}`);
    if (!response.headersSent) return send(response, 400, { error: "invalid_request" });
  }
}).listen(port, "0.0.0.0", () => console.error(`vellum-updater: control API listening on ${port}`)); }

if (process.env.VELLUM_UPDATER_TEST !== "true") {
  const server = startServer();
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  void check();
  setInterval(() => void check(), intervalSeconds * 1000).unref();
  setInterval(() => void tryScheduledApply(), 30_000).unref();
}

export { equalToken, newer, stableServerReleaseTag, validateConfig, zonedClock, publicStatus };
