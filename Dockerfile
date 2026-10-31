# Slim Node 22 (matches package.json engines) plus only Chromium's headless shell, which is all
# `browse` uses (chromium.launch({ headless: true })). No Firefox or WebKit.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

# Compilers only in the builder, in case better-sqlite3 has no prebuilt binary.
FROM base AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM base
# Chromium first, before any app files, so this slow layer stays cached across code changes.
# Must equal the playwright version in package.json; the check below fails the build otherwise.
ARG PLAYWRIGHT_VERSION=1.64.1
RUN npx -y playwright@${PLAYWRIGHT_VERSION} install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* /root/.cache /root/.npm
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
# --chown at copy time; a later chown -R would duplicate node_modules into another layer.
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
RUN node -e "const v=require('playwright/package.json').version; if(v!=='${PLAYWRIGHT_VERSION}'){console.error('playwright is '+v+' but the Dockerfile installs Chromium for ${PLAYWRIGHT_VERSION}; update PLAYWRIGHT_VERSION');process.exit(1)}" \
 && mkdir -p /data && chown node:node /data /app
# Not root: Chromium refuses to sandbox as root, and the SQLite/auth files shouldn't be root-owned.
USER node
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "dist/index.js"]
