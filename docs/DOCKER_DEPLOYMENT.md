# Production Docker deployment

The recommended installation is one self-contained directory at a location you
choose. It holds the Compose definition, its automatically loaded `.env`, and
all persistent bind-mounted data. There is no repository checkout and no fixed
Linux host path; the same stack works with Docker Engine or Docker Desktop.

## Install

```bash
curl -fsSL https://github.com/metaneutrons/Vellum/releases/latest/download/install.sh \
  | bash -s -- --dir /srv/vellum --url https://vellum.example.com
```

Both flags are optional, and so is every question the installer asks. Given
neither, it installs into `./vellum` and offers two prompts — public URL and
timezone — that Enter skips; `--yes`, or no attached terminal, skips them outright.
Prompts are read from `/dev/tty`, not stdin, so they work when the script is piped
from `curl`.

Leaving `VELLUM_PUBLIC_URL` unset is enough to sign in at
`http://127.0.0.1:3000/admin` and look around. Set it before putting Vellum behind
HTTPS or enabling Entra ID — unset, the server validates browser mutations against
the request origin instead of a canonical one (`src/lib/request-origin.ts`).

The installer checks the prerequisites up front (Docker, Compose v2, curl,
openssl, a checksum tool, a reachable daemon), verifies `docker-compose.yml` and
`vellum.env.example` against the release `SHA256SUMS`, generates all six secrets,
writes a `0600` `.env`, starts the stack, waits for `/api/v1/health`, and prints
the generated owner password once.

| Flag | Effect |
|---|---|
| `--dir <path>` | Installation directory (default `./vellum`) |
| `--url <origin>` | Public HTTPS origin, no path. Omit to decide later |
| `--tz <zone>` | IANA timezone for the maintenance window; defaults to the host's |
| `--admin-user <name>` | Bootstrap owner name (default `admin`) |
| `--version <tag>` | Install a specific release instead of the latest |
| `--from <dir>` | Use assets already on disk — air-gapped hosts |
| `--dry-run` | Prepare the directory and `.env`, start nothing |
| `--yes` | Take every default without prompting |
| `--force` | Overwrite an existing `.env` (destructive) |

It refuses to overwrite an existing `.env` without `--force`, so it cannot
silently replace the secrets of a live stack. It is a first-install tool: later
server upgrades belong to the updater.

To review the script first, download `install.sh` and `SHA256SUMS` from the same
release and check it with
`grep ' install.sh$' SHA256SUMS | sha256sum --check` before running it.

### Or configure it yourself

The stack is a single file. Download `docker-compose.yml` and
`vellum.env.example` from the release (or take them from `deploy/`), replace every
placeholder with an independently generated `openssl rand -hex 32`, save the
template as `.env` with mode `0600`, and run `docker compose up -d`.

Replacing the placeholders is enforced, not merely advised: the template values
are the same length as real secrets, so the server and the updater both reject
the shipped placeholder text outright and refuse to start. An unedited `.env`
fails closed with the offending variable named, rather than booting with secrets
that are public repository content.

`DATABASE_URL` is derived from `POSTGRES_USER`, `POSTGRES_PASSWORD` and
`POSTGRES_DB` by the Compose file, so the database password is defined in exactly
one place. It previously had to be typed identically into both
`POSTGRES_PASSWORD` and `DATABASE_URL`, and a mismatch produced a stack that
started and then failed to authenticate against its own database — a runtime
failure far from the typo. Two consequences:

- If you set `POSTGRES_PASSWORD` by hand, keep it URL-safe (no `@ : / % #`), since
  it is interpolated into a `postgresql://` URL. The installer's generated
  password is hex.
- To use a database outside this stack, set `DATABASE_URL` in `.env`; an explicit
  value overrides the derived one.

The host needs no repository checkout. `releases/latest/download` resolves to
the latest stable Vellum Server release; `--version vX.Y.Z` pins a particular one
(or `releases/download/vX.Y.Z` when installing by hand). `SHA256SUMS` detects a
truncated or mismatched download before anything is installed. Each release's
environment template pins `VELLUM_IMAGE` and `UPDATER_IMAGE` to that exact
release tag. Later server upgrades remain controlled by the verified updater,
which can also hand its own verified replacement to a detached helper.

Compose creates this layout on first start:

```text
vellum/
├── docker-compose.yml
├── .env
└── data/
    ├── postgres/
    ├── backups/
    └── updater/
```

You may place the directory anywhere the Docker-operating account can access,
including `/srv/vellum`, `/docker/vellum`, or a home directory. Compose resolves
the bind mounts relative to `docker-compose.yml`, so no paths need editing when
the stopped stack is moved or restored. Keep `.env` private. The server port
remains loopback-only at `127.0.0.1:3000` on Linux and macOS.

The updater captures that host-side stack directory when Compose first creates
it and passes it back with `--project-directory` for later server and updater
replacements. This is necessary because the updater's Docker client runs inside a
container while controlling the host daemon: without the explicit host path,
relative sources would incorrectly resolve below `/stack` on the host. Moving a
stopped stack remains portable—run `docker compose up -d` once from the new
directory and the recreated updater captures the new location.

For bootstrap supply-chain verification, inspect the published Sigstore identity
with `cosign verify` and set `VELLUM_IMAGE` and `UPDATER_IMAGE` to the verified
`ghcr.io/...@sha256:...` manifest digests. Subsequent server releases are always
pulled by exact tag and verified by the updater before deployment.

Compose rejects missing server or updater image settings instead of silently
falling back to mutable tags. Avoid changing either setting to `latest`. Normal
updater operation recreates only the `server` service from a verified exact tag.

PostgreSQL is pinned to its major release and an immutable image digest. Never
replace it with `postgres:latest`: that could turn a routine pull into an
unsupported major database upgrade. Dependabot proposes reviewed digest updates
for the Compose file; applying a new Compose release to an existing host remains
an explicit maintenance operation.

The server listens only on host loopback port 3000. Terminate TLS in the host's
reverse proxy and keep the service internal as required by the site network.

## Update behavior

The updater checks GitHub's latest stable Vellum **server** release every 15
minutes. Firmware, draft, prerelease, malformed, and downgrade tags are rejected.
Before changing the server it:

1. pulls the exact version tag rather than trusting `latest`;
2. verifies the image's keyless Sigstore identity against Vellum's Docker release workflow;
3. writes an atomic PostgreSQL custom-format backup;
4. recreates only the server container;
5. requires both HTTP readiness and database connectivity;
6. persists the verified exact server tag for later Compose operations;
7. restores both the previous container and image pin if deployment or pin
   persistence fails.

Administrators with `system.update` permission choose the behavior under
**System → Vellum Server**:

- **Manual:** Vellum announces the release and waits for confirmation.
- **Automatic:** Vellum installs an available release at the configured daily
  maintenance time in the configured IANA timezone, for example
  `02:00 Europe/Berlin`.

The setting is persisted in `data/updater/config.json` and survives
container replacement. `AUTO_APPLY`, `MAINTENANCE_TIME`, and `TZ` in Compose are
bootstrap defaults used only until a Web UI setting has been saved. A missed
maintenance window is not executed late; it waits for the next daily window.
Read-only operators can see status but cannot change settings or trigger an
update. Every check, install, and configuration change is audited. The Web UI
talks through a narrow internal API; the server and browser never receive access
to the Docker socket.

During an update the HTTP connection can briefly disappear while the server
container is replaced. The UI polls and recovers automatically.

## Operations

Force a release check from inside the updater container:

```bash
sudo docker exec vellum-updater node -e \
  "fetch('http://127.0.0.1:8080/v1/check',{method:'POST',headers:{authorization:'Bearer '+process.env.UPDATER_TOKEN}}).then(r=>r.text()).then(console.log)"
```

The control port is intentionally not published by the Compose stack. To disable updates:

```bash
docker compose stop updater
```

Backups are retained in `data/backups/` for 14 days. These database dumps are
the safe artifacts to back up while the stack is running; copying the live
`data/postgres/` directory does not guarantee a consistent database. A failed
server deployment rolls the image back automatically but never restores a
database backup automatically; database restore is an explicit operator action.
Server migrations must therefore follow expand/contract compatibility across
adjacent releases. Container startup is fail-closed: a server accepts traffic
only after its checksummed migrations commit successfully.

The updater cannot recreate its own running container directly — that would kill
the process performing the swap. With the default `AUTO_UPDATE_UPDATER=true`,
after a *healthy* server update it verifies the matching updater image against
the `updater.yml` Sigstore
identity, then hands the swap to a **detached one-shot helper** and exits. The
helper is not a child process, so it survives its parent being replaced, and it
runs from the currently deployed image on purpose — a helper built from the new
image could not roll back a broken one. It recreates the service, waits for the
container to report healthy, persists the `UPDATER_IMAGE` pin, and on failure
restores the previous image. The outcome is written to the state volume so the
replacement updater can report it in **System → Vellum Server**.

An updater from before this mechanism cannot bootstrap the helper itself. For
that one legacy transition, **System → Vellum Server** shows these commands:

```bash
docker compose pull updater
docker compose up -d --no-deps updater
```

After that one-time bootstrap, updater releases install automatically. To keep
them manual instead, set `AUTO_UPDATE_UPDATER=false` in `.env`; the Web UI then
states that policy instead of incorrectly claiming self-update is unsupported.

### Recover an older stack with poisoned `/stack` mounts

Updater versions from before host-project-directory preservation could recreate
the server or updater from inside the container and accidentally resolve the
relative bind sources on the Docker host below `/stack`. The characteristic log
message is `/stack/.env is a directory`. Retrying in the Web UI cannot repair
this condition because both deployment and rollback use the same invalid mount.

Recover it once from the **real host stack directory**:

1. Stop retrying the Web UI update and create a fresh PostgreSQL custom-format
   backup in `data/backups/`.
2. Back up `.env` and `docker-compose.yml` without changing their ownership or
   permissions.
3. Download `docker-compose.yml` and `SHA256SUMS` from the target stable Vellum
   Server release and verify the Compose file against that checksum manifest.
4. If the deployed Compose file is unmodified, replace it with the verified
   release file. Otherwise, diff the two and carry forward the release changes
   while preserving site-specific reverse-proxy labels, ports, and networks.
   Validate the result with `docker compose config --quiet`; never overwrite a
   customized production file blindly. Set both `VELLUM_IMAGE` and
   `UPDATER_IMAGE` in `.env` to the exact same `vX.Y.Z` release tag.
5. From the host stack directory run `docker compose pull server updater`, then
   `docker compose up -d --no-deps server updater`.
6. Require both services to be healthy and inspect their mounts. Every stack
   source must point below the real stack directory; none may start with
   `/stack` on the host.
7. Only after that verification, remove the orphaned host `/stack` directory.

The PostgreSQL service is deliberately not recreated by this recovery. If any
health or mount check fails, retain `/stack`, the backups, and the previous files
for diagnosis instead of attempting cleanup.

Docker socket access is root-equivalent. It exists only in the dedicated updater
container, whose filesystem is read-only, whose API is unpublished, and which
drops all Linux capabilities except one. Do not attach untrusted workloads to the
stack's default network.

That one exception is `DAC_OVERRIDE`, and it is required rather than leftover
slack. `.env` deliberately stays `0600` and is owned by the host account that
deployed the stack; the updater container runs as root and must both read that
mounted file and write the newly deployed `VELLUM_IMAGE` pin back into it. With
all capabilities dropped, root has no override for file permissions it does not
own, so every update attempt fails closed at the updater's
"environment file is not readable/writable" preflight. Keep `.env` at `0600`,
keep the `.env` mount writable, and keep `DAC_OVERRIDE` — do not substitute a
`0644` file or a read-only mount. The container only ever sees its own narrow
stack mounts.

Server and updater start pinned to the same release version; each release's
environment template sets both `VELLUM_IMAGE` and `UPDATER_IMAGE` to that
release's exact tag. Successful updates persist both verified image pins in
`.env`, so a later `docker compose up` cannot silently downgrade either service.
