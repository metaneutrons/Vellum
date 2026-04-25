FROM node:22-alpine AS base

# Install dependencies only
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm rebuild

# Build the application
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
# Dummy env vars for build (validated at runtime)
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
ENV ENCRYPTION_KEY=build-time-placeholder-at-least-32-chars
ENV ADMIN_API_KEY=build-time-placeholder-at-least-32-chars
ENV ADMIN_USER=build
ENV ADMIN_PASS=build-placeholder
RUN npm run build

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
