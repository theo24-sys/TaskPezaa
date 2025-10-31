# syntax=docker/dockerfile:1
FROM node:20-alpine AS base

# ---- Build everything -------------------------------------------------
WORKDIR /app

# Copy package files (root + web)
COPY package*.json ./
COPY web/package*.json ./web/

# Install **all** deps (needed for building the front-end)
RUN npm ci && cd web && npm ci

# Copy the whole repo
COPY . .

# Build the front-end (Vite → dist, CRA → build)
RUN cd web && npm run build

# ---- Production image -------------------------------------------------
FROM node:20-alpine AS production
WORKDIR /app

# Copy only what we need
COPY --from=base /app /app

# Remove dev deps & web node_modules (smaller image)
RUN npm ci --production && rm -rf web/node_modules

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/index.js"]