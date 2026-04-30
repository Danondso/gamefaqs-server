# GameFAQs Server Dockerfile
# Debian-slim base: sqlite-vec ships glibc-linked prebuilt binaries that won't
# load on Alpine's musl. node:20-bookworm-slim is ~25 MB larger and works.

FROM node:20-bookworm-slim

# p7zip-full for 7z extraction; wget for the HEALTHCHECK below.
RUN apt-get update \
  && apt-get install -y --no-install-recommends p7zip-full wget \
  && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev dependencies for building)
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Remove dev dependencies to reduce image size
RUN npm prune --production

# Create directories for data persistence
RUN mkdir -p /data/db /tmp/gamefaqs

# Environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/db/gamefaqs.db
ENV TEMP_DIR=/tmp/gamefaqs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health/live || exit 1

# Run server
CMD ["node", "dist/server.js"]
