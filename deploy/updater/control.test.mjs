// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

process.env.VELLUM_UPDATER_TEST = "true";
process.env.UPDATER_TOKEN = "a".repeat(64);
const testDirectory = mkdtempSync(join(tmpdir(), "vellum-updater-control-"));
const progressFile = join(testDirectory, "progress.json");
process.env.PROGRESS_FILE = progressFile;
process.env.COMPOSE_PROJECT = "vellum";
process.env.HOSTNAME = "vellum-updater";
process.env.CONTROL_PORT = "0";
after(() => rmSync(testDirectory, { recursive: true, force: true }));

/* A real `docker` on PATH rather than an injected function, so the production
 * `command()` and its argument handling are what runs. It answers ONLY when the
 * format string asks for the Coolify label: a fake that answers anything would
 * let a removed guard pass unnoticed. */
const dockerLog = join(testDirectory, "docker.log");
writeFileSync(
  join(testDirectory, "docker"),
  `#!/bin/sh
printf '%s\\n' "$*" >>"${dockerLog}"
case "$1" in
  inspect) case "$*" in *coolify.managed*) printf '%s\\n' "$FAKE_OWN_LABEL" ;; esac ;;
  ps) case "$*" in *--format*coolify.managed*) printf '%s\\n' "$FAKE_PROJECT_LABELS" ;; esac ;;
esac
`
);
chmodSync(join(testDirectory, "docker"), 0o755);
process.env.PATH = `${testDirectory}:${process.env.PATH}`;
const dockerCalls = () =>
  existsSync(dockerLog)
    ? readFileSync(dockerLog, "utf8").split("\n").filter(Boolean)
    : [];
const forgetDockerCalls = () => writeFileSync(dockerLog, "");
const {
  apply,
  check,
  detectManagedBy,
  startServer,
  status,
  equalToken,
  fetchReleaseVersion,
  newer,
  reached,
  publicStatus,
  releaseDecision,
  retryAtFromHeaders,
  startProgressJournal,
  stableServerReleaseTag,
  validateConfig,
  zonedClock,
} = await import("./control.mjs");

test("resets a completed journal synchronously when a new update starts", () => {
  writeFileSync(
    progressFile,
    JSON.stringify({
      phase: "done",
      detail: null,
      at: "2026-08-15T08:00:10.000Z",
      startedAt: "2026-08-15T08:00:00.000Z",
    })
  );

  assert.equal(startProgressJournal("v1.12.0", new Date("2026-08-16T09:00:00.000Z")), true);
  assert.deepEqual(JSON.parse(readFileSync(progressFile, "utf8")), {
    phase: "verifying",
    detail: "v1.12.0",
    at: "2026-08-16T09:00:00.000Z",
    startedAt: "2026-08-16T09:00:00.000Z",
    failedPhase: null,
    rollbackAttempted: false,
  });
});

test("compares semantic release versions without allowing downgrades", () => {
  assert.equal(newer("1.8.1", "v1.8.2"), true);
  assert.equal(newer("v1.9.9", "v2.0.0"), true);
  assert.equal(newer("v2.0.0", "v1.99.99"), false);
  assert.equal(newer("v1.8.2", "v1.8.2"), false);
  assert.equal(newer("dev", "v1.8.2"), true);
  assert.equal(newer("v1.8.2", "firmware-v1.3.2"), false);
});

test("confirms an update only from the version actually running", () => {
  assert.equal(reached("v1.10.5", "v1.10.5"), true);
  assert.equal(reached("v1.10.6", "v1.10.5"), true);
  assert.equal(reached("v1.10.4", "v1.10.5"), false);
  assert.equal(reached(null, "v1.10.5"), false);
});

test("does not offer a release until every signed container artifact is ready", () => {
  assert.deepEqual(releaseDecision("v1.10.3", "v1.10.4", false), {
    state: "preparing",
    updateAvailable: false,
  });
  assert.deepEqual(releaseDecision("v1.10.3", "v1.10.4", true), {
    state: "available",
    updateAvailable: true,
  });
  assert.deepEqual(releaseDecision("v1.10.4", "v1.10.4", false), {
    state: "current",
    updateAvailable: false,
  });
});

test("requires an exact control token", () => {
  assert.equal(equalToken("a".repeat(64)), true);
  assert.equal(equalToken("a".repeat(63)), false);
  assert.equal(equalToken("b".repeat(64)), false);
});

test("validates and evaluates timezone-aware maintenance schedules", () => {
  assert.equal(
    validateConfig({ mode: "automatic", maintenanceTime: "02:30", timezone: "Europe/Berlin" }),
    true
  );
  assert.equal(validateConfig({ mode: "manual", maintenanceTime: "23:59", timezone: "UTC" }), true);
  assert.equal(
    validateConfig({ mode: "automatic", maintenanceTime: "24:00", timezone: "UTC" }),
    false
  );
  assert.equal(
    validateConfig({ mode: "automatic", maintenanceTime: "02:30", timezone: "Not/AZone" }),
    false
  );
  assert.deepEqual(zonedClock(new Date("2026-08-11T00:30:00Z"), "Europe/Berlin"), {
    date: "2026-08-11",
    time: "02:30",
  });
});

test("reports its own image version so a stale updater is visible", () => {
  const status = publicStatus();
  // Built without the ARG in tests, so the field exists but is null — exactly
  // what an older updater looks like to the server, which must tolerate it.
  assert.ok("updaterVersion" in status, "status must always carry updaterVersion");
  assert.ok("updaterUpdateAvailable" in status, "status must always carry updaterUpdateAvailable");
  assert.equal(status.releaseCheckStatus, "ok");
  assert.equal(status.releaseCheckError, null);
  assert.equal(status.releaseCheckRetryAt, null);
  assert.equal(status.updaterSelfUpdateCapable, true);
  assert.equal(status.updaterSelfUpdateEnabled, true);
  assert.equal(status.updaterUpdateAvailable, false, "must not claim an update before a check ran");
});

test("treats an unknown own version as older than any release", () => {
  // A build without a baked version must still be reported as behind rather
  // than silently current.
  assert.equal(newer(null, "v1.9.6"), true);
  assert.equal(newer("0.0.0-dev", "v1.9.6"), true);
  assert.equal(newer("v1.9.6", "v1.9.6"), false);
  assert.equal(newer("v1.9.7", "v1.9.6"), false);
});

test("selects the newest stable server release without being masked by firmware", () => {
  assert.equal(
    stableServerReleaseTag([
      { tag_name: "firmware-v1.4.2", draft: false, prerelease: false },
      { tag_name: "v1.10.1", draft: false, prerelease: false },
      { tag_name: "v1.10.2", draft: false, prerelease: false },
      { tag_name: "v2.0.0", draft: false, prerelease: true },
      { tag_name: "v9.0.0", draft: true, prerelease: false },
    ]),
    "v1.10.2"
  );
  assert.equal(
    stableServerReleaseTag([{ tag_name: "firmware-v1.4.2", draft: false, prerelease: false }]),
    null
  );
  // Keep custom RELEASE_API endpoints pointing at one release compatible.
  assert.equal(
    stableServerReleaseTag({ tag_name: "v1.10.2", draft: false, prerelease: false }),
    "v1.10.2"
  );
});

test("retries transient GitHub failures and accepts the next valid release", async () => {
  const responses = [
    new Response("gateway timeout", { status: 504 }),
    Response.json({ tag_name: "v1.13.0", draft: false, prerelease: false }),
  ];
  const delays = [];
  const tag = await fetchReleaseVersion(
    "https://example.test/releases/latest",
    async () => responses.shift(),
    async (delay) => delays.push(delay)
  );
  assert.equal(tag, "v1.13.0");
  assert.deepEqual(delays, [500]);
});

test("rejects an implausibly empty release response after bounded retries", async () => {
  let attempts = 0;
  await assert.rejects(
    fetchReleaseVersion(
      "https://example.test/releases/latest",
      async () => {
        attempts += 1;
        return Response.json([]);
      },
      async () => {}
    ),
    (error) => error?.code === "invalid-response"
  );
  assert.equal(attempts, 3);
});

test("honors GitHub rate-limit reset metadata without busy retrying", async () => {
  const now = Date.parse("2026-08-17T12:00:00.000Z");
  const retryAt = retryAtFromHeaders(
    new Headers({ "retry-after": "120", "x-ratelimit-reset": "1" }),
    now
  );
  assert.equal(retryAt, "2026-08-17T12:02:00.000Z");
  let attempts = 0;
  await assert.rejects(
    fetchReleaseVersion(
      "https://example.test/releases/latest",
      async () => {
        attempts += 1;
        return new Response(null, { status: 429, headers: { "retry-after": "120" } });
      },
      async () => {},
      () => now
    ),
    (error) => error?.code === "rate-limited" && error?.retryAt === retryAt
  );
  assert.equal(attempts, 1);
});

/* ── A platform that deploys the stack itself ──────────────────────────────── */

test("recognises Coolify by the label of its own container or of one in the project", async () => {
  const seen = [];
  const answers = (own, project) => (_command, args) => {
    seen.push(args.join(" "));
    return Promise.resolve(args[0] === "inspect" ? own : project);
  };

  assert.equal(await detectManagedBy(answers("true", "")), "coolify");
  assert.equal(await detectManagedBy(answers("", "true\ntrue")), "coolify");
  assert.equal(await detectManagedBy(answers("", "\ntrue")), "coolify");
  assert.equal(await detectManagedBy(answers("", "")), null);
  assert.equal(await detectManagedBy(answers("false", "\n\n")), null);
  // Not a prefix match: only the exact value counts.
  assert.equal(await detectManagedBy(answers("truely", "")), null);
  // A daemon that cannot be reached says nothing, it does not throw.
  assert.equal(
    await detectManagedBy(() => Promise.reject(new Error("docker daemon is unreachable"))),
    null
  );

  // Only containers of THIS project, never host-wide.
  assert.ok(seen.some((call) => call.startsWith("inspect") && call.includes("coolify.managed")));
  const listings = seen.filter((call) => call.startsWith("ps"));
  assert.ok(listings.length > 0);
  for (const call of listings) {
    assert.ok(call.includes("label=com.docker.compose.project=vellum"), call);
    assert.ok(call.includes("coolify.managed"), call);
  }
});

test("refuses to check or install under Coolify, without asking GitHub or touching a container", async () => {
  const requested = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    requested.push(String(url));
    return Promise.reject(new Error("no release lookup may happen"));
  };
  process.env.FAKE_OWN_LABEL = "";
  process.env.FAKE_PROJECT_LABELS = "true\ntrue";
  rmSync(progressFile, { force: true });
  forgetDockerCalls();

  try {
    await check();
    assert.equal(status.managedBy, "coolify");
    assert.equal(status.state, "failed");
    assert.equal(status.updateAvailable, false);
    assert.match(status.lastError, /Coolify/);
    assert.equal(publicStatus().managedBy, "coolify");

    // A caller that thinks an update is waiting must still be refused, and the
    // labels are re-read at that moment rather than trusted from the check.
    Object.assign(status, {
      state: "available",
      updateAvailable: true,
      availableVersion: "v9.9.9",
      managedBy: null,
    });
    assert.equal(await apply(), true);
    assert.equal(status.managedBy, "coolify");
    assert.equal(status.state, "failed");

    assert.deepEqual(requested, []);
    for (const call of dockerCalls()) assert.match(call, /^(inspect|ps) /, call);
    assert.equal(existsSync(progressFile), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("lets an installation without the labels through to the release check", async () => {
  process.env.FAKE_OWN_LABEL = "";
  process.env.FAKE_PROJECT_LABELS = "";
  Object.assign(status, {
    state: "available",
    updateAvailable: true,
    availableVersion: "v9.9.9",
    managedBy: "coolify",
  });
  rmSync(progressFile, { force: true });

  // It fails for its own reason — the deployment worker does not exist here —
  // which is what proves the flag is derived afresh and not sticky.
  assert.equal(await apply(), true);
  assert.equal(status.managedBy, null);
  assert.doesNotMatch(status.lastError ?? "", /Coolify/);
  assert.equal(JSON.parse(readFileSync(progressFile, "utf8")).phase, "verifying");
});

test("answers the control API with the platform and refuses to install or schedule", async () => {
  process.env.FAKE_OWN_LABEL = "true";
  process.env.FAKE_PROJECT_LABELS = "";
  await check();
  const server = startServer();
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const authorized = { authorization: `Bearer ${process.env.UPDATER_TOKEN}` };

  try {
    const statusResponse = await fetch(`${base}/v1/status`, { headers: authorized });
    assert.equal(statusResponse.status, 200);
    assert.equal((await statusResponse.json()).managedBy, "coolify");

    forgetDockerCalls();
    for (const [path, body] of [
      ["/v1/apply", undefined],
      ["/v1/config", JSON.stringify({ mode: "manual", maintenanceTime: "02:00", timezone: "UTC" })],
    ]) {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { ...authorized, "content-type": "application/json" },
        ...(body ? { body } : {}),
      });
      assert.equal(response.status, 409, path);
      assert.equal((await response.json()).error, "managed_by_platform", path);
    }
    assert.deepEqual(dockerCalls(), []);

    const unauthorized = await fetch(`${base}/v1/status`);
    assert.equal(unauthorized.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
