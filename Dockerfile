FROM node:26-alpine AS base

# Install dependencies only
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --ignore-scripts && npm rebuild

# Build the application
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
# Placeholder env for the build step ONLY. These are passed inline to the build
# command (not as persistent `ENV` layers) so secret-named throwaway values never
# land in image metadata — silencing BuildKit's SecretsUsedInArgOrEnv warning.
# All of these are server-only (never inlined into the client bundle); `next build`
# merely needs them present to pass env validation. Real values are injected at
# runtime via the container environment.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build \
    ENCRYPTION_KEY=build-time-placeholder-at-least-32-chars \
    SESSION_SECRET=build-time-placeholder-at-least-32-chars \
    ADMIN_API_KEY=build-time-placeholder-at-least-32-chars \
    ADMIN_USER=build \
    ADMIN_PASS=build-placeholder \
    npm run build

# Production image
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

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

CMD ["node", "server.js"]
