# syntax=docker/dockerfile:1

# Node 24 LTS (Node 20 reached end-of-life in April 2026). Pinned to an exact
# release so builds are reproducible; bump deliberately.
ARG NODE_IMAGE=node:24.19.0-alpine

# ---- Build stage --------------------------------------------------------
FROM ${NODE_IMAGE} AS build
# openssl: Prisma engines. bcrypt ships a prebuilt musl binary, so no compiler
# toolchain is needed (add python3 make g++ here if a native module ever must build).
RUN apk add --no-cache openssl
WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma
# postinstall runs `prisma generate`, which needs prisma/schema.prisma
# already present — hence copying prisma/ before npm ci.
RUN --mount=type=cache,target=/root/.npm npm ci

COPY . .
RUN npm run build
# Runtime needs only production packages (the prisma CLI is one of them, for
# migrations). The generated client in node_modules/.prisma is kept.
RUN npm prune --omit=dev

# ---- Runtime stage -------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production

# Code stays root-owned (read-only for the app user); only uploads is writable.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package*.json ./
# Uploaded files (mount a volume here — see DEPLOYMENT.md).
RUN mkdir -p /app/uploads && chown node:node /app/uploads

# Never run the app as root.
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health" >/dev/null || exit 1

# Apply pending migrations, then start. A failed migration stops the container
# instead of serving an app whose code and schema disagree. `exec` makes node
# the process that receives SIGTERM, so Nest's shutdown hooks run.
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && exec node dist/src/main"]
