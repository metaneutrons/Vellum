// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { readFileSync } from "node:fs";
import { classifyReleaseCommit } from "./classify-release-commit.mjs";
import { firmwareBetaVersion } from "./firmware-beta-version.mjs";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const config = readJson("release-please-config.json");
const manifest = readJson(".release-please-manifest.json");
const packageJson = readJson("package.json");
const workflow = readFileSync(".github/workflows/release-please.yml", "utf8");
const firmwareWorkflow = readFileSync(".github/workflows/firmware.yml", "utf8");
const dockerWorkflow = readFileSync(".github/workflows/docker.yml", "utf8");
const updaterWorkflow = readFileSync(".github/workflows/updater.yml", "utf8");
const deploymentAssetsWorkflow = readFileSync(".github/workflows/deployment-assets.yml", "utf8");
const dependabotConfig = readFileSync(".github/dependabot.yml", "utf8");
const productionCompose = readFileSync("deploy/docker-compose.yml", "utf8");
const deploymentEnv = readFileSync("deploy/vellum.env.example", "utf8");
const updaterControl = readFileSync("deploy/updater/control.mjs", "utf8");
const updaterScript = readFileSync("deploy/updater/update.sh", "utf8");
const firmwareKconfig = readFileSync("firmware/main/Kconfig.projbuild", "utf8");
const firmwareMakefile = readFileSync("firmware/Makefile", "utf8");
const testsecureDefaults = readFileSync("firmware/sdkconfig.defaults.testsecure", "utf8");
const securebootDefaults = readFileSync("firmware/sdkconfig.defaults.secureboot", "utf8");
const productionDefaults = readFileSync("firmware/sdkconfig.defaults.prod", "utf8");
const d1001Defaults = readFileSync("firmware/sdkconfig.defaults.p4", "utf8");
const d1001Partitions = readFileSync("firmware/partitions.d1001.csv", "utf8");
const failures = [];

const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

const titlePattern = "chore${scope}: release${component} ${version}";
const server = config.packages?.["."];
const firmware = config.packages?.firmware;

expect(
  config["separate-pull-requests"] === true,
  "server and firmware must use separate release PRs"
);
expect(
  config["pull-request-title-pattern"] === titlePattern,
  "release PR titles must expose scope, component, and version"
);

expect(server?.["release-type"] === "node", "server release type must be node");
expect(server?.["package-name"] === "vellum", "server package name must be vellum");
expect(server?.component === "server", "server component must be explicit");
expect(server?.["include-component-in-tag"] === false, "server tags must remain vX.Y.Z");
/* The server component releases the container image and its deployment assets.
 * Anything that cannot change what those contain has no business bumping its
 * version, and release-please attributes a commit to EVERY component whose paths
 * it touches -- so a firmware commit that also edited a doc used to ask for a
 * server release carrying no server change at all. Two of those were closed
 * unmerged (#304, #306) before this list grew.
 *
 * A commit drops out of a component only when ALL of its files are excluded
 * (`commit-exclude.ts`, `.every(...)`), which is why these are listed rather than
 * relied upon individually.
 *
 * deploy/ is deliberately NOT here: its compose file and env example ship as
 * release assets, so a change there does belong to a server release. */
const serverExcluded = ["firmware", "docs", ".github", ".githooks", ".claude"];
for (const path of serverExcluded) {
  expect(
    server?.["exclude-paths"]?.includes(path),
    `server releases must exclude ${path}/** — see the note above`
  );
}

expect(firmware?.["release-type"] === "simple", "firmware release type must be simple");
expect(
  firmware?.["package-name"] === "vellum-firmware",
  "firmware package name must be vellum-firmware"
);
expect(firmware?.component === "firmware", "firmware component must be explicit");
expect(
  firmware?.["include-component-in-tag"] === true,
  "firmware tags must include the firmware component"
);
expect(firmware?.["tag-separator"] === "-", "firmware tag separator must be '-'");
expect(
  firmware?.["extra-files"]?.some(
    (entry) => entry?.type === "generic" && entry?.path === "main/Kconfig.projbuild"
  ),
  "release-please must update the firmware Kconfig version"
);

expect(
  manifest["."] === packageJson.version,
  `server manifest version ${manifest["."]} must match package.json ${packageJson.version}`
);
const firmwareVersion = firmwareKconfig.match(
  /default\s+"([^"]+)"\s+#\s+x-release-please-version/
)?.[1];
expect(
  manifest.firmware === firmwareVersion,
  `firmware manifest version ${manifest.firmware} must match Kconfig ${firmwareVersion ?? "<missing>"}`
);

expect(
  d1001Defaults.includes("CONFIG_ESPTOOLPY_FLASHSIZE_32MB=y") &&
    d1001Defaults.includes('CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="partitions.d1001.csv"'),
  "D1001 builds must use the board's 32 MiB flash and dedicated partition table"
);
expect(
  d1001Partitions.includes("ota_0,     app,  ota_0,   0x20000,   0x800000,") &&
    d1001Partitions.includes("ota_1,     app,  ota_1,   0x820000,  0x800000,") &&
    d1001Partitions.includes("storage,   data, fat,     0x1020000, 0xfe0000,"),
  "D1001 partition table must retain two 8 MiB OTA slots and end at 32 MiB"
);
expect(
  firmwareWorkflow.includes("PART=firmware/partitions.d1001.csv"),
  "firmware CI must validate D1001 images against the D1001 partition budget"
);
for (const contract of [
  "partitionLayout",
  "securityProfile: 'development'",
  "requiresSecureBoot: false",
  "requiresFlashEncryption: false",
]) {
  expect(firmwareWorkflow.includes(contract), `firmware manifests must carry ${contract}`);
}
expect(
  firmwareWorkflow.includes("complete factory enrollment pipeline exists") &&
    firmwareWorkflow.includes("exit 1"),
  "incomplete CI Secure Boot publishing must fail closed"
);

for (const invariant of [
  'CONFIG_VELLUM_SECURITY_PROFILE="testsecure"',
  "CONFIG_VELLUM_NVS_HMAC_INTEGRITY=y",
  "CONFIG_SECURE_SIGNED_APPS_NO_SECURE_BOOT=y",
  "CONFIG_SECURE_BOOT_BUILD_SIGNED_BINARIES=y",
  'CONFIG_SECURE_BOOT_SIGNING_KEY="keys/testsecure_signing_key.pem"',
]) {
  expect(testsecureDefaults.includes(invariant), `testsecure must retain ${invariant}`);
}
expect(
  !testsecureDefaults.includes("CONFIG_SECURE_BOOT=y") &&
    !testsecureDefaults.includes("CONFIG_SECURE_FLASH_ENC_ENABLED=y") &&
    !testsecureDefaults.includes("CONFIG_NVS_ENCRYPTION=y"),
  "testsecure must remain fully reversible and must not enable eFuse-backed security"
);
for (const [profile, contents] of [
  ["secureboot", securebootDefaults],
  ["production", productionDefaults],
]) {
  expect(
    contents.includes("CONFIG_VELLUM_NVS_HMAC_INTEGRITY=y"),
    `${profile} must retain HMAC-NVS integrity`
  );
}
for (const gate of [
  "IRREVERSIBLE_SECURITY_ENROLLMENT",
  "HSM_SIGNING_VERIFIED",
  "TEST_DEVICES_VALIDATED",
  "RECOVERY_RUNBOOK_APPROVED",
  "MANUFACTURING_PROCESS_APPROVED",
]) {
  expect(
    firmwareMakefile.includes(gate) && firmwareWorkflow.includes(gate),
    `${gate} must guard both local and CI irreversible firmware paths`
  );
}
expect(
  firmwareMakefile.includes("I_ACKNOWLEDGE_EFUSE_BURNS_ARE_IRREVERSIBLE") &&
    firmwareWorkflow.includes("I_ACKNOWLEDGE_EFUSE_BURNS_ARE_IRREVERSIBLE"),
  "irreversible firmware paths must require the exact acknowledgement token"
);

expect(
  workflow.includes("config-file: release-please-config.json"),
  "release workflow must use the manifest configuration"
);
expect(
  workflow.includes("manifest-file: .release-please-manifest.json"),
  "release workflow must use the version manifest"
);
expect(
  workflow.includes("Require release automation token") &&
    workflow.includes("token: ${{ secrets.RELEASE_PAT }}") &&
    !workflow.includes("secrets.RELEASE_PAT || secrets.GITHUB_TOKEN"),
  "release automation must fail closed without RELEASE_PAT"
);

const releaseCommitFixtures = [
  ["chore(main): release firmware 1.3.3 (#174)", "firmware"],
  ["chore(firmware): release firmware 2.0.0", "firmware"],
  [
    "Merge pull request #174 from metaneutrons/release-please--branches--main--components--firmware",
    "firmware",
  ],
  ["chore(main): release 1.9.4 (#175)", "server"],
  ["chore(main): release server 2.0.0", "server"],
  [
    "Merge pull request #175 from metaneutrons/release-please--branches--main--components--server",
    "server",
  ],
  ["fix(firmware): mention chore(main): release firmware 9.9.9 in docs", "none"],
  ["fix: release-please--branches is not a component marker", "none"],
];
for (const [message, expected] of releaseCommitFixtures) {
  expect(
    classifyReleaseCommit(message) === expected,
    `release commit classifier must map ${JSON.stringify(message)} to ${expected}`
  );
}
expect(
  firmwareWorkflow.includes("node scripts/classify-release-commit.mjs"),
  "firmware workflow must use the shared release commit classifier"
);
expect(
  firmwareWorkflow.includes("needs.version.outputs.release_component == 'none'"),
  "firmware workflow must suppress all Release Please push builds"
);
expect(
  firmwareWorkflow.includes("node scripts/firmware-beta-version.mjs"),
  "firmware beta builds must use the tested next-patch version helper"
);
expect(
  !dockerWorkflow.includes("push:\n") &&
    dockerWorkflow.includes("release:\n    types: [published]") &&
    dockerWorkflow.includes("workflow_dispatch:") &&
    dockerWorkflow.includes("!startsWith(github.event.release.tag_name, 'firmware')"),
  "Docker publishing must be limited to server releases and explicit recovery dispatches"
);
expect(
  !updaterWorkflow.includes("push:\n") &&
    updaterWorkflow.includes("release:\n    types: [published]") &&
    updaterWorkflow.includes("workflow_dispatch:") &&
    updaterWorkflow.includes("!startsWith(github.event.release.tag_name, 'firmware')"),
  "updater publishing must be limited to server releases and explicit recovery dispatches"
);

const betaFixture = firmwareBetaVersion("1.4.2", 13, "2028a59");
expect(
  betaFixture.version === "1.4.3-beta.13+2028a59",
  "post-1.4.2 beta builds must target the next patch, never 1.4.2-beta"
);
expect(
  betaFixture.tag === "firmware-v1.4.3-beta.13-2028a59",
  "beta firmware tags must be SemVer-derived and git-ref safe"
);

expect(
  deploymentAssetsWorkflow.includes("release:\n    types: [published]"),
  "deployment assets must be published with each GitHub release"
);
expect(
  deploymentAssetsWorkflow.includes("workflow_dispatch:"),
  "deployment assets must support backfilling an existing server release"
);
expect(
  deploymentAssetsWorkflow.includes(
    "github.event_name == 'workflow_dispatch' && github.sha || env.RELEASE_TAG"
  ),
  "deployment assets must use the tag normally and the current ref for backfills"
);
expect(
  deploymentAssetsWorkflow.includes(
    'server_image="ghcr.io/${GITHUB_REPOSITORY_OWNER,,}/vellum:${RELEASE_TAG}"'
  ) && deploymentAssetsWorkflow.includes("VELLUM_IMAGE=${server_image}"),
  "deployment assets must pin the initial server image to the release tag"
);
expect(
  deploymentAssetsWorkflow.includes(
    'updater_image="ghcr.io/${GITHUB_REPOSITORY_OWNER,,}/vellum-updater:${RELEASE_TAG}"'
  ) && deploymentAssetsWorkflow.includes("UPDATER_IMAGE=${updater_image}"),
  "deployment assets must pin the updater image to the release tag"
);
expect(
  deploymentAssetsWorkflow.includes("Wait for signed release images") &&
    deploymentAssetsWorkflow.includes("cosign verify"),
  "deployment assets must wait for both signed release images"
);
for (const asset of ["docker-compose.yml", "vellum.env.example", "install.sh", "SHA256SUMS"]) {
  expect(
    deploymentAssetsWorkflow.includes(`dist/${asset}`),
    `deployment release must upload ${asset}`
  );
}
expect(
  dependabotConfig.includes('package-ecosystem: "docker-compose"') &&
    dependabotConfig.includes('directory: "/deploy"'),
  "Dependabot must monitor production Compose image pins"
);
for (const path of [
  "./data/postgres:/var/lib/postgresql",
  "./data/backups:/backups",
  "./data/updater:/state",
  "./docker-compose.yml:/stack/docker-compose.yml:ro",
  "./.env:/stack/.env",
]) {
  expect(
    productionCompose.includes(path),
    `production Compose must keep ${path} inside the portable stack directory`
  );
}
expect(
  productionCompose.includes("HOST_STACK_DIR: ${HOST_STACK_DIR:-${PWD}}"),
  "updater must capture the host project directory before running Compose in-container"
);
expect(
  (productionCompose.match(/^\s+- \$\{COMPOSE_ENV_FILE:-\.\/\.env\}$/gm) ?? []).length === 2,
  "server and updater must load the stack-local env file through a client-visible path"
);
expect(
  productionCompose.includes("COMPOSE_ENV_FILE: /stack/.env"),
  "in-container Compose must read env_file from its mounted stack path"
);
expect(
  productionCompose.includes("image: ${VELLUM_IMAGE:?set VELLUM_IMAGE in .env}"),
  "production Compose must reject a missing server image pin"
);
expect(
  productionCompose.includes("image: ${UPDATER_IMAGE:?set UPDATER_IMAGE in .env}"),
  "production Compose must reject a missing updater image pin"
);
expect(
  productionCompose.includes("AUTO_UPDATE_UPDATER: ${AUTO_UPDATE_UPDATER:-true}"),
  "production Compose must enable health-checked updater self-updates by default"
);
expect(
  deploymentEnv.includes("AUTO_UPDATE_UPDATER=true"),
  "release environment template must enable updater self-updates by default"
);
for (const [name, contents] of [
  ["control API", updaterControl],
  ["update script", updaterScript],
]) {
  expect(
    contents.includes("api.github.com/repos/metaneutrons/Vellum/releases/latest"),
    `updater ${name} must use the bounded authoritative latest-release endpoint`
  );
  expect(
    !contents.includes("/releases?per_page=100"),
    `updater ${name} must not download the unbounded release collection`
  );
}
expect(
  firmwareWorkflow.includes("--latest=false") && firmwareWorkflow.includes("make_latest: false"),
  "firmware releases must never take GitHub's Latest badge"
);
expect(
  dockerWorkflow.includes('-F "make_latest=true"'),
  "server releases must own GitHub's Latest badge"
);
for (const variable of ["VELLUM_DATA_DIR", "VELLUM_COMPOSE_FILE", "VELLUM_ENV_FILE"]) {
  expect(
    !deploymentEnv.includes(`${variable}=`),
    `production environment template must not require obsolete host path ${variable}`
  );
}

if (failures.length > 0) {
  process.stderr.write(`Release configuration is invalid:\n- ${failures.join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Release configuration invariants are satisfied.\n");
}
