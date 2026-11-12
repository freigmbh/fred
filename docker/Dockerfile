FROM node:24.19.0-bookworm-slim AS base
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable && corepack prepare pnpm@11.21.0 --activate
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/controller/package.json apps/controller/
COPY apps/worker/package.json apps/worker/
COPY apps/ui/package.json apps/ui/
COPY packages/contracts/package.json packages/contracts/
RUN pnpm install --frozen-lockfile
COPY . .
# Declared late, so a new version reuses the cached dependency layers.
ARG FRED_VERSION=
RUN node scripts/build.mjs --bundles

FROM base AS runtime-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/controller/package.json apps/controller/
COPY apps/worker/package.json apps/worker/
COPY packages/contracts/package.json packages/contracts/
RUN pnpm install --frozen-lockfile

FROM base AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=runtime-deps /app ./
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/controller/package.json apps/controller/tsconfig.json apps/controller/
COPY apps/controller/convex apps/controller/convex
COPY --from=build /app/apps/worker/dist apps/worker/dist
COPY scripts/setup-env.mjs scripts/container-deploy.mjs scripts/
COPY docker/runtime.sh /usr/local/bin/fred
ARG FRED_VERSION=
ARG FRED_RELEASE_SHA=
ENV NODE_ENV=production FRED_VERSION=${FRED_VERSION} FRED_RELEASE_SHA=${FRED_RELEASE_SHA}
LABEL org.opencontainers.image.title="FRED" org.opencontainers.image.version="${FRED_VERSION}" org.opencontainers.image.revision="${FRED_RELEASE_SHA}"
USER node
ENTRYPOINT ["fred"]
CMD ["worker"]

FROM nginxinc/nginx-unprivileged:1.30.5-alpine AS web
USER root
RUN rm /etc/nginx/conf.d/default.conf
COPY docker/nginx/conf.d/ /etc/nginx/conf.d/
COPY docker/nginx/docker-entrypoint.d/ /docker-entrypoint.d/
COPY docker/nginx/fred/ /etc/nginx/fred/
COPY --from=build /app/apps/ui/dist /usr/share/nginx/html
ARG FRED_VERSION=
ARG FRED_RELEASE_SHA=
LABEL org.opencontainers.image.title="FRED admin UI" org.opencontainers.image.version="${FRED_VERSION}" org.opencontainers.image.revision="${FRED_RELEASE_SHA}"
USER nginx
