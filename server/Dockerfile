# syntax=docker/dockerfile:1
FROM node:20-alpine AS base

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY web/package*.json ./web/

# Install ALL dependencies (needed for build)
RUN npm ci && cd web && npm ci

# Copy source code
COPY . .

# Build the frontend (adjust if using React, Vite, etc.)
RUN cd web && npm run build

# Production stage
FROM node:20-alpine AS production
WORKDIR /app

# Copy built app from base
COPY --from=base /app /app

# Remove dev dependencies (optional, for smaller image)
RUN npm ci --production && rm -rf web/node_modules

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "src/index.js"]
