# Deploying Halal Income

This app is a single Node process: it serves the static site (this
repo's root) and the API (`backend/`) from the same origin and port,
so there's no separate frontend build or CORS setup needed anywhere.

This guide gets it live on a real domain. **It does not deploy anything for
you** — you choose the host, create the account, and run these steps
yourself.

## Before you deploy: read this part

**Persistent storage is the one thing that will bite you if skipped.**
Everything that matters — the SQLite database, KYC documents, payment/deposit
proofs, backup files — lives under `backend/data/`. Most hosting platforms
(including most "just push your Dockerfile" PaaS free tiers) give you an
**ephemeral filesystem** by default: it resets to whatever was in the image
every time you redeploy or the container restarts. If `backend/data/` isn't
on a persistent volume, you will silently lose every user, investment, and
uploaded document on your next deploy.

Two ways to handle this:
- **Attach a persistent volume/disk** mounted at `backend/data/` (every
  platform below has some form of this — "Volumes" on Railway, "Disks" on
  Render, a real disk on a VPS).
- Or, at minimum, **download a full backup before every redeploy**
  (Admin panel → Backup & restore → Download full backup) and restore it
  after — this works but is manual and easy to forget. A persistent volume
  is strongly preferred.

## Required environment variables

Copy `backend/.env.example` to `backend/.env` (or set these as your
platform's environment variables — same names) and fill in real values:

| Variable | Required | Notes |
|---|---|---|
| `JWT_SECRET` | **Yes** | Long random string signing session cookies. Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. Changing it logs everyone out. |
| `NODE_ENV` | **Yes** | Set to `production`. Enables secure (HTTPS-only) cookies and hides debug fields like email codes from API responses. |
| `PORT` | No | Defaults to 3000. Most platforms inject their own `PORT` automatically — leave unset and let them. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | For first setup only | Used once by `npm run seed:admin` to create your first admin account. |
| `RESEND_API_KEY` / `EMAIL_FROM` | Recommended | Without this, verification codes/reset links/approval emails only log to the server console instead of actually sending — fine for testing, not for real users. Sign up free at resend.com. |
| `ANTHROPIC_API_KEY` | Optional | Powers the FAQ page's AI assistant widget. Leave blank to disable that one feature. |

## HTTPS

This app itself only speaks plain HTTP. In production it must sit behind
something that terminates HTTPS — this is usually automatic:
- **Railway / Render**: HTTPS is handled for you on their default domain and
  on any custom domain you attach. Nothing to configure.
- **A bare VPS**: put [Caddy](https://caddyserver.com/) or nginx + Let's
  Encrypt in front of the Node process (Caddy is a one-line config for
  automatic HTTPS: `yourdomain.com { reverse_proxy localhost:3000 }`).

`NODE_ENV=production` must be set for session cookies to be marked
`Secure` — without it, cookies won't be sent back over HTTPS by the browser
and logins will silently fail in production.

## Option A — Railway or Render (recommended, least setup)

`package.json` lives in `backend/`, not the repo root, so both platforms need
to be told that explicitly — otherwise their build step won't find a Node
app to install/run at all.

1. Push this repo to a GitHub repo (private is fine).
2. Create a new project on [Railway](https://railway.app) or
   [Render](https://render.com) and connect that GitHub repo.
3. **Set the Root Directory to `backend`** (Railway: Service → Settings →
   "Root Directory"; Render: set during the "New Web Service" wizard, or
   Settings → "Root Directory" afterward). This makes the platform run
   `npm install` and `npm start` from inside `backend/`, which is what its
   `package.json` expects.
4. Set the environment variables from the table above in the platform's
   dashboard.
5. **Attach a persistent volume/disk** mounted at the absolute path where
   `backend/data/` ends up on disk — commonly `/app/backend/data` on
   Railway's default Nixpacks builder, but confirm the real path yourself:
   open the platform's Shell tab after the first deploy and run
   `pwd && ls backend/data` (or just `pwd` if you set Root Directory, in
   which case the mount path is `/app/data` relative to that root — check
   which one matches what you see). Railway: "Volumes" tab; Render: "Disks"
   tab, under the service's Settings.
6. Deploy. Once it's live, use the platform's Shell tab and run:
   ```bash
   npm run seed:admin
   ```
   (no `cd backend` needed if Root Directory is already set to `backend`)
   to create your first admin account.
6. Attach your custom domain in the platform's dashboard if you have one.

## Option B — Docker on any VPS (DigitalOcean, Hetzner, AWS EC2, etc.)

A `Dockerfile` is included at the repo root.

```bash
# On the server, after cloning this repo:
docker build -t halal-income .
docker run -d \
  --name halal-income \
  --restart unless-stopped \
  -p 3000:3000 \
  -v /srv/halal-income-data:/app/backend/data \
  --env-file backend/.env \
  halal-income

# First-time only: create your admin account inside the running container
docker exec -it halal-income sh -c "cd /app/backend && npm run seed:admin"
```

The `-v /srv/halal-income-data:/app/backend/data` flag is the persistent
volume — `/srv/halal-income-data` is a real directory on the host machine
that survives container rebuilds. Put a reverse proxy (Caddy/nginx) in front
of port 3000 for HTTPS as described above.

## Option C — Plain Node on a VPS (no Docker)

```bash
# On the server:
git clone <your-repo-url>
cd halal-income/backend
npm install
cp .env.example .env   # then edit .env with real values
npm run seed:admin

# Keep it running across reboots/crashes with a process manager, e.g. pm2:
npm install -g pm2
pm2 start src/server.js --name halal-income
pm2 save
pm2 startup   # follow the printed instructions to enable on-boot start
```

Put Caddy/nginx in front for HTTPS as described above. `backend/data/` is
already a real directory on the VPS's own disk, so no extra volume setup is
needed here — just make sure it's included in whatever you back up.

## After deploying

- Visit `/health` — it should return `{"ok":true}` with no auth required.
  Point your host's uptime monitor at this URL.
- Log in as the admin account you seeded and confirm the admin panel loads.
- Download a real backup (Admin panel → Backup & restore) and store it
  somewhere off the server, before you have real user data to lose.
- If you set `RESEND_API_KEY`, sign up a test account and confirm the
  verification email actually arrives (check spam the first time).

