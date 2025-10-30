# syntax=docker/dockerfile:1
FROM node:20-alpine AS base
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production
COPY src ./src
COPY sql ./sql
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node","src/index.js"]
