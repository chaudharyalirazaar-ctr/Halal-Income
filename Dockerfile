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
ENV PORT=3000
EXPOSE 3000

VOLUME ["/app/backend/data"]

WORKDIR /app/backend
CMD ["node", "src/server.js"]
