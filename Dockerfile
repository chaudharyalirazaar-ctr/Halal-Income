# Halal Income — single-container image. The Node server serves both the
# static site (this directory) and the API (backend/), so there's only one
# process to run.
#
# IMPORTANT — persistent data: everything that matters (the SQLite database,
# uploaded KYC documents, payment/deposit proofs, backups) lives under
# backend/data/. That directory MUST be mounted as a persistent volume in
# production — without it, every redeploy or container restart silently
# wipes all users, investments, and uploaded files. See DEPLOY.md.

FROM node:22-alpine

WORKDIR /app

# Install dependencies first (better layer caching — this layer only
# rebuilds when package*.json actually changes, not on every code edit).
COPY backend/package*.json backend/
RUN cd backend && npm install --omit=dev

# Now copy the rest of the site + backend source.
COPY . .

ENV NODE_ENV=production
# PORT is intentionally NOT set here — the host (Railway, Render, etc.)
# injects its own at runtime, and server.js already falls back to 3000
# via `process.env.PORT || 3000` if nothing is injected (e.g. local
# `docker run` testing).
EXPOSE 3000

# NOTE: no `VOLUME` instruction here — Railway's Dockerfile builder rejects
# it outright ("docker VOLUME ... is not supported, use Railway Volumes").
# Persistent storage for this path is instead configured through the host's
# own volume/disk feature (Railway: "Volumes" tab; Render: "Disks" tab;
# plain Docker: the `-v` flag) — see DEPLOY.md. The directory still needs to
# exist and be writable at /app/backend/data regardless of which host you use.

WORKDIR /app/backend
CMD ["node", "src/server.js"]
