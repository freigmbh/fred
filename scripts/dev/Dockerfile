FROM node:24.19.0-bookworm
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable && corepack prepare pnpm@11.21.0 --activate
WORKDIR /app
RUN mkdir -p /state && chown node:node /app /state
USER node
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node apps/controller/package.json apps/controller/package.json
COPY --chown=node:node apps/worker/package.json apps/worker/package.json
COPY --chown=node:node packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile
COPY --chown=node:node . .
WORKDIR /app/apps/worker
CMD ["node", "--import", "tsx/esm", "src/dev/main.ts"]
