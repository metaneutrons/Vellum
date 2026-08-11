# Production Docker deployment

The recommended installation is one self-contained directory at a location you
choose. It holds the Compose definition, its automatically loaded `.env`, and
all persistent bind-mounted data. There is no repository checkout and no fixed
Linux host path; the same stack works with Docker Engine or Docker Desktop.

## Install

```bash
# Choose any writable location for the complete Vellum installation.
mkdir -p "$HOME/vellum"
cd "$HOME/vellum"

release="https://github.com/metaneutrons/Vellum/releases/latest/download"
curl --fail --silent --show-error --location \
  --remote-name "$release/docker-compose.yml"
curl --fail --silent --show-error --location \
  --remote-name "$release/vellum.env.example"
curl --fail --silent --show-error --location \
  --remote-name "$release/SHA256SUMS"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum --check SHA256SUMS
else
  shasum --algorithm 256 --check SHA256SUMS
fi
mv vellum.env.example .env
rm SHA256SUMS
chmod 600 .env

# Generate every placeholder secret independently, including UPDATER_TOKEN:
openssl rand -hex 32
${EDITOR:-vi} .env

docker compose pull
docker compose up -d
```

The host needs no repository checkout. `releases/latest/download` resolves to
the latest stable Vellum Server release; replace it with
`releases/download/vX.Y.Z` to pin a particular release. `SHA256SUMS` detects a
truncated or mismatched download before anything is installed. Each release's
environment template also pins `VELLUM_IMAGE` to that exact server tag for the
initial deployment; later upgrades remain controlled by the verified updater.

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

For bootstrap supply-chain verification, inspect the published Sigstore identity
with `cosign verify` and set `VELLUM_IMAGE` and `UPDATER_IMAGE` to the verified
`ghcr.io/...@sha256:...` manifest digests. Subsequent server releases are always
pulled by exact tag and verified by the updater before deployment.

Avoid an unreviewed full-stack `docker compose up --pull always`: it can replace
the exact, verified server image with a mutable tag. Normal updater operation
recreates only the `server` service from a verified exact tag.

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
6. restores the previous server image automatically if readiness fails.

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
adjacent releases.

The updater image itself is not allowed to replace its own container. Update it
explicitly after reviewing a release:

```bash
docker compose pull updater
docker compose up -d --no-deps updater
```

Docker socket access is root-equivalent. It exists only in the dedicated updater
container, whose filesystem is read-only, capabilities are dropped, and API is
unpublished. Do not attach untrusted workloads to the stack's default network.
