# syntax=docker/dockerfile:1
# docker:29-cli multi-arch manifest, pinned for reproducible updater builds.
FROM docker:29-cli@sha256:27a51d5ab1cd38d9eeaba7b415b8c07bc10c31e1cf1ec8d78f6413fcfab3f44f

RUN apk add --no-cache \
      bash \
      ca-certificates \
      coreutils \
      cosign \
      curl \
      docker-cli-compose \
      jq \
      nodejs \
    && update-ca-certificates

# The updater cannot replace its own container (see docs/DOCKER_DEPLOYMENT.md), so
# it must at least be able to REPORT which version it is — otherwise the one
# component holding the Docker socket ages unnoticed. Baked at build time rather
# than inspected via the socket: no extra privilege, works even if the socket is
# unavailable.
ARG UPDATER_VERSION=0.0.0-dev
ENV UPDATER_VERSION=${UPDATER_VERSION}

COPY update.sh /usr/local/bin/vellum-update
COPY control.mjs /usr/local/lib/vellum-updater/control.mjs

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/v1/status',{headers:{authorization:'Bearer '+process.env.UPDATER_TOKEN}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "/usr/local/lib/vellum-updater/control.mjs"]
