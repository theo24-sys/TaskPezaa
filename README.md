<<<<<<< HEAD
# TaskPesa Kenya — Render Deployment (Web + API)

MVP using Node/Express API + PostgreSQL (Render) and a lightweight browser client.

## Quick Start (Local Dev)
1) Create a local Postgres or use Render PostgreSQL.
2) Copy `.env.example` to `.env` and fill values.
3) Run SQL in `server/sql/schema.sql` on your database.
4) From `server/`: `npm install && npm run dev`.
5) Open `web/index.html` via a simple static server (or live server).

## Deployment (Render)
- Create a Render PostgreSQL instance and set DATABASE_URL.
- Create a Web Service for `server/` (Node), set env vars.
- Optionally create a Static Site for `web/`.
- Or serve `web/` from the API under `/`.

## Features
- Fixed-price tasks, 10-day packages, Friday withdrawals with 8% fee.
- Daily task refresh logic and plan expiry.
- Admin endpoints to add tasks and approve withdrawals.

## APK
Later, wrap `web/` using Capacitor to produce an APK.
=======
# TaskPezaa
>>>>>>> 05b9202c09f4f2d21520c5525403af7a41903bf5
