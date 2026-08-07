# syntax=docker/dockerfile:1
# Base image pinned by digest for reproducible, supply-chain-verifiable builds.
# node:26-alpine (resolve a new digest with: docker buildx imagetools inspect node:26-alpine)
FROM node:26-alpine@sha256:e88a35be04478413b7c71c455cd9865de9b9360e1f43456be5951032d7ac1a66 AS base

# Node 26 no longer bundles Corepack. Bootstrap the exact pnpm version in a
# build-only stage so pnpm and its global install layer stay out of the runtime
# image.
FROM base AS package-manager
RUN npm install --global --ignore-scripts pnpm@11.20.0

# ── Dependencies (reproducible install from the lockfile) ───────────────────
FROM package-manager AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts/setup-git-hooks.mjs ./scripts/setup-git-hooks.mjs
# Frozen install gives exact-lockfile reproducibility. pnpm-workspace.yaml keeps
# dependency build scripts denied by default and explicitly permits only the
# reviewed native/tooling packages. Standard Docker layer caching keeps this
# reusable without requiring BuildKit support on the deployment host.
RUN pnpm config set store-dir /pnpm/store --global && \
    pnpm install --frozen-lockfile

# ── Build ───────────────────────────────────────────────────────────────────
FROM package-manager AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
# Placeholder env for the build step ONLY. Passed inline to the build command
# (not as persistent `ENV` layers) so secret-named throwaway values never land in
# image metadata — silencing BuildKit's SecretsUsedInArgOrEnv warning. All are
# server-only (never inlined into the client bundle); `next build` merely needs
# them present to pass env validation. Real values are injected at runtime.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build \
    ENCRYPTION_KEY=build-time-placeholder-at-least-32-chars \
    SESSION_SECRET=build-time-placeholder-at-least-32-chars \
    ADMIN_API_KEY=build-time-placeholder-at-least-32-chars \
    ADMIN_USER=build \
    ADMIN_PASS=build-placeholder \
    pnpm build

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# tini as PID 1: forwards signals and reaps zombies (Node alone does neither well).
RUN apk add --no-cache tini

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/assets ./assets
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# LIVENESS check: healthy if the HTTP server RESPONDS at all. A 503 from a
# transient DB outage still means the process is alive — and restarting the
# container wouldn't fix an external DB — so we must not flap/restart on it. Only
# an unreachable or hung server (fetch rejects, or the --timeout kills the probe)
# is unhealthy. DB/readiness is observed separately via /api/v1/health's body.
# Uses Node's global fetch (no extra dependency).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health').then(()=>process.exit(0)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
# Apply pending DB migrations (idempotent, self-baselining), then start the
# server. FAIL-OPEN: a transient DB outage at boot must not stop the server from
# starting — same reasoning as the liveness HEALTHCHECK above. If migrations
# can't run, the app still boots and degrades gracefully until the schema
# catches up on a later start. `scripts/` and `drizzle/` are copied above, and
# `pg` is present in the traced standalone node_modules.
CMD ["sh", "-c", "node scripts/migrate.mjs || echo 'vellum: DB migration step failed — starting server anyway'; exec node server.js"]
