# syntax=docker/dockerfile:1

# MailCheap as one standalone Next.js server, without dev dependencies, running as the unprivileged node user.
# Build: docker build -t mailcheap .   Run: docker-compose.yml, or the README's Docker section.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
# The public pages, the search index and next.config read these while building, so they're set for the build too.
# Leave MAILCHEAP_CLOUD unset for a self-hosted server. No secret is needed: instrumentation.js checks the config when
# the server starts.
ARG APP_URL=http://localhost:3000
ARG MAILCHEAP_CLOUD=
ARG IMAGES_CDN_URL=
ENV NEXT_TELEMETRY_DISABLED=1 \
	NEXT_OUTPUT=standalone \
	APP_URL=${APP_URL} \
	MAILCHEAP_CLOUD=${MAILCHEAP_CLOUD} \
	IMAGES_CDN_URL=${IMAGES_CDN_URL}
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:${NODE_VERSION}-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
	NEXT_TELEMETRY_DISABLED=1 \
	PORT=3000 \
	HOSTNAME=0.0.0.0

# The standalone server serves public/ and .next/static once they sit next to it. assets/ has the fonts the share
# images read from disk.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/assets ./assets

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "server.js"]
