# TManage self-host image (54-19), built on the operator's own machine from the release bundle.
#
# The bundle is the same tmanage-hostinger.zip `pnpm deploy:hostinger` makes for the cloud: built
# packages, the Next.js build, the migrations, server.mjs, a package-lock.json and an .npmrc with
# ignore-scripts=true. Nothing is compiled here; `npm ci` fetches the Linux native binaries
# (@node-rs/argon2, sharp, swc) for this platform, exactly as Hostinger's `npm install` does.
#
#   docker compose build      (the `tmanage` CLI runs it; the bundle sits next to this file)
#
# Base images by tag; pin a digest (`node:22-bookworm-slim@sha256:…`) in NODE_IMAGE for a
# byte-identical rebuild.
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS install
RUN apt-get update \
  && apt-get install -y --no-install-recommends unzip ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY tmanage-bundle.zip /tmp/bundle.zip
RUN unzip -q /tmp/bundle.zip -d /app \
  && rm /tmp/bundle.zip \
  && npm ci --omit=dev --no-audit --no-fund \
  && npm cache clean --force

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
  PORT=3000 \
  WORKER_INPROCESS=1 \
  STORAGE_LOCAL_ROOT=/var/lib/tmanage/storage \
  NEXT_TELEMETRY_DISABLED=1
# The code is root-owned and read-only to the app. Writable: the storage volume, .run (the private
# socket between server.mjs and the web child, web-transport.mjs) and Next's runtime cache.
COPY --from=install /app /app
RUN mkdir -p /var/lib/tmanage/storage /app/.run /app/web/.next/cache \
  && chown node:node /var/lib/tmanage/storage /app/.run /app/web/.next/cache
WORKDIR /app
USER node
EXPOSE 3000
VOLUME ["/var/lib/tmanage/storage"]
# /healthz answers 503 "starting" until migrations and both halves are up, then 200.
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server.mjs"]
