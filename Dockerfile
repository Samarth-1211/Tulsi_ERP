# syntax=docker/dockerfile:1

# ---- Build stage --------------------------------------------------------
FROM node:20-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma
# postinstall runs `prisma generate`, which needs prisma/schema.prisma
# already present — hence copying prisma/ before npm ci.
RUN npm ci

COPY . .
RUN npm run build

# ---- Runtime stage -------------------------------------------------------
FROM node:20-alpine AS runtime
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package*.json ./

EXPOSE 3000
CMD ["node", "dist/src/main"]