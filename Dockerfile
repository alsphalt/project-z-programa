# DARKNOTE CONTROL CENTER
#
# One long-running Node process (`next start`), because the terminal relay, the
# console buffer and the SSE hub are in-process by design (see README → "Honest
# limits"). Scale it vertically or run one replica per server; do not put two
# replicas behind a load balancer and expect a coherent console tail.
#
#   docker build -t darknote .
#   docker run -p 3000:3000 --env-file .env.local darknote

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# `npm ci` needs the lockfile only; this layer is cached until dependencies move.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The build must not need a database or a panel: every route that touches them is
# dynamic, and the schema is traced into the output for runtime reading.
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    DARKNOTE_DATA_DIR=/data

# `node_modules` is kept because `next start` needs the full dependency tree at
# runtime (pg, ws, pglite, monaco copy step) — this is not a standalone build.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/db ./db
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/tsconfig.json ./tsconfig.json

# Runtime data (embedded database when DATABASE_URL is empty, private backup
# store). Mount a volume here, or point DATABASE_URL at Neon and keep this small.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
