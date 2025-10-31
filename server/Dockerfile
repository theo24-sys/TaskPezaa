# syntax=docker/dockerfile:1
FROM node:20-alpine AS base

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY web/package*.json ./web/

# Install all deps
RUN npm ci && cd web && npm ci

# Copy source
COPY . .

# Build frontend
RUN cd web && npm run build

# Production
FROM node:20-alpine AS production
WORKDIR /app
COPY --from=base /app /app
RUN npm ci --production && rm -rf web/node_modules

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server/src/index.js"]