# Playwright's image matches the pinned playwright version and ships Chromium + its system deps,
# so `browse` works headless in the container. Node comes with it (24 at the time of writing).
FROM mcr.microsoft.com/playwright:v1.64.1-noble AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

# better-sqlite3 has no prebuilt binary for every Node version, so the builder can compile it.
FROM base AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM base
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Not root: Chromium refuses to sandbox as root, and the SQLite/auth files shouldn't be root-owned.
RUN mkdir -p /data && chown -R pwuser:pwuser /data /app
USER pwuser
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "dist/index.js"]
