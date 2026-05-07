# GameFAQs Server Dockerfile
# Debian-slim base: sqlite-vec ships glibc-linked prebuilt binaries that won't
# load on Alpine's musl. node:20-bookworm-slim is ~25 MB larger and works.

# --- Stage 1: build TypeScript ---------------------------------------------
FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build

# --- Stage 2: runtime ------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

# p7zip-full for 7z extraction; wget for the HEALTHCHECK below.
RUN apt-get update \
  && apt-get install -y --no-install-recommends p7zip-full wget \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install only production deps in the runtime stage so dev deps never enter
# the final image at all (vs. installing+pruning in a single layer, which
# leaves them in earlier cached layers).
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=builder /app/dist ./dist

RUN mkdir -p /data/db /tmp/gamefaqs

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/db/gamefaqs.db
ENV TEMP_DIR=/tmp/gamefaqs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health/live || exit 1

CMD ["node", "dist/server.js"]
