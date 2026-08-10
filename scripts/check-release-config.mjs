// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { readFileSync } from "node:fs";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const config = readJson("release-please-config.json");
const manifest = readJson(".release-please-manifest.json");
const packageJson = readJson("package.json");
const workflow = readFileSync(".github/workflows/release-please.yml", "utf8");
const firmwareKconfig = readFileSync("firmware/main/Kconfig.projbuild", "utf8");
const failures = [];

const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

const titlePattern = "chore${scope}: release${component} ${version}";
const server = config.packages?.["."];
const firmware = config.packages?.firmware;

expect(config["separate-pull-requests"] === true,
  "server and firmware must use separate release PRs");
expect(config["pull-request-title-pattern"] === titlePattern,
  "release PR titles must expose scope, component, and version");

expect(server?.["release-type"] === "node", "server release type must be node");
expect(server?.["package-name"] === "vellum", "server package name must be vellum");
expect(server?.component === "server", "server component must be explicit");
expect(server?.["include-component-in-tag"] === false,
  "server tags must remain vX.Y.Z");
expect(server?.["exclude-paths"]?.includes("firmware"),
  "server releases must exclude firmware/**");

expect(firmware?.["release-type"] === "simple", "firmware release type must be simple");
expect(firmware?.["package-name"] === "vellum-firmware",
  "firmware package name must be vellum-firmware");
expect(firmware?.component === "firmware", "firmware component must be explicit");
expect(firmware?.["include-component-in-tag"] === true,
  "firmware tags must include the firmware component");
expect(firmware?.["tag-separator"] === "-", "firmware tag separator must be '-'");
expect(firmware?.["extra-files"]?.some((entry) =>
  entry?.type === "generic" && entry?.path === "main/Kconfig.projbuild"),
"release-please must update the firmware Kconfig version");

expect(manifest["."] === packageJson.version,
  `server manifest version ${manifest["."]} must match package.json ${packageJson.version}`);
const firmwareVersion = firmwareKconfig.match(
  /default\s+"([^"]+)"\s+#\s+x-release-please-version/,
)?.[1];
expect(manifest.firmware === firmwareVersion,
  `firmware manifest version ${manifest.firmware} must match Kconfig ${firmwareVersion ?? "<missing>"}`);

expect(workflow.includes("config-file: release-please-config.json"),
  "release workflow must use the manifest configuration");
expect(workflow.includes("manifest-file: .release-please-manifest.json"),
  "release workflow must use the version manifest");

if (failures.length > 0) {
  process.stderr.write(`Release configuration is invalid:\n- ${failures.join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Release configuration invariants are satisfied.\n");
}
