# The Transitopia server (apps/server): API, pollers, recorder, dispatcher, jobs and the daily data
# build. Built from the repository root: docker build -f infra/server.Dockerfile .
#
# The official Node.js image carries its own ICU and time zone data; the server refuses to start if
# that data is too old for the region (region.json timezoneChecks), so keep the Node version current.

FROM node:26-slim AS rclone
# Keep in step with infra/backup/Dockerfile.
ARG RCLONE_VERSION=1.75.0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && ARCH="$(dpkg --print-architecture)" \
  && curl -fsSL -o /tmp/rclone.zip "https://downloads.rclone.org/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-${ARCH}.zip" \
  && unzip -j /tmp/rclone.zip '*/rclone' -d /usr/local/bin

# tippecanoe, for the plan and overview tiles (packages/transit-core/DESIGN.md#plan-tiles) and the cycling tiles: built from
# source, since Debian's package is too old to write PMTiles.
FROM node:26-slim AS tippecanoe
# Keep in step with .github/actions/setup-tippecanoe.
ARG TIPPECANOE_VERSION=2.79.0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl build-essential libsqlite3-dev zlib1g-dev \
  && curl -fsSL "https://github.com/felt/tippecanoe/archive/refs/tags/${TIPPECANOE_VERSION}.tar.gz" | tar xz -C /tmp \
  && make -C "/tmp/tippecanoe-${TIPPECANOE_VERSION}" -j"$(nproc)" tippecanoe \
  && install -m 755 "/tmp/tippecanoe-${TIPPECANOE_VERSION}/tippecanoe" /usr/local/bin/tippecanoe

FROM node:26-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libsqlite3-0 zlib1g \
  && rm -rf /var/lib/apt/lists/*
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
COPY --from=tippecanoe /usr/local/bin/tippecanoe /usr/local/bin/tippecanoe
WORKDIR /app
# Dependencies first, for the layer cache. Every workspace's package.json is needed for npm ci.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/cycling-core/package.json packages/cycling-core/
COPY packages/data/package.json packages/data/
COPY packages/db/package.json packages/db/
COPY packages/map-style/package.json packages/map-style/
COPY packages/shared/package.json packages/shared/
COPY packages/transit-core/package.json packages/transit-core/
COPY packages/transit-map/package.json packages/transit-map/
COPY pipelines/package.json pipelines/
COPY config/package.json config/
RUN npm ci --no-audit --no-fund && npm cache clean --force
COPY . .
# var/ (recordings, downloads, build output) is a volume, owned by the unprivileged user.
RUN mkdir -p var && chown node:node var
USER node
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/rt/status').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--import", "tsx", "apps/server/src/main.ts"]
