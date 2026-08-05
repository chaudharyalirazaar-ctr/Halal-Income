# Halal Income — backend

A real backend for the Halal Income website, replacing the `localStorage`-based
demo behavior that used to live in `auth.js`, `balance.js`, `referral.js`,
`verify.js`, and `analytics.js`. Built with Express and Node's built-in
`node:sqlite` (no native modules, no separate database server to install).

This server also serves the website itself (the HTML/CSS/JS files one level
up), so the whole site runs from a single process on a single port — no CORS
setup needed, and session cookies just work.

## Setup

Requires Node.js 22.5+ (uses the built-in `node:sqlite` module — no native
compilation, no separate database install). Check your version with
`node -v` first if you're not sure.

```bash
cd backend
npm install
cp .env.example .env
```

Open `.env` and set:
- `JWT_SECRET` — a long random string (a command to generate one is in the file's comments)
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` — credentials for the first admin account

Then create that admin account (needed to review KYC submissions, approve
withdrawals/redemptions, log investments and profit, and view analytics):

```bash
npm run seed:admin
```

Start the server:

```bash
npm start
```

Visit **http://localhost:3000** — that's the whole site, backed by the real API.

Run `npm run dev` instead of `npm start` during development — it restarts the
server automatically when you edit backend files.

## AI assistant (FAQ page)

The "Talk to AI assistant" button on `index.html` and `faq.html` opens a real
chat backed by `POST /api/assistant/chat` (Claude, via `@anthropic-ai/sdk`).
It only needs `ANTHROPIC_API_KEY` in `.env` — get one at
https://console.anthropic.com/settings/keys. Until it's set, the widget shows
a "not configured" message instead of erroring.

The system prompt (`backend/src/routes/assistant.js`) is grounded only in
facts the site actually states — several FAQ/profit-share answers on the live
site are still placeholder text ("Replace with your client's real terms...")
rather than real answers, so those specific topics (capital withdrawal terms,
the exact Shariah-compliance structure, regulatory status) are explicitly
listed as "not yet finalized" and the assistant is instructed to say so
rather than invent or guess. It also declines to give personalized
investment advice. Update the system prompt once those pages have real
content. The endpoint is public (no login) but rate-limited per IP (20
messages / 10 minutes) since each request costs money against the API key.

## What's real vs. what's still a stub

- **Real**: password hashing (bcrypt), sessions (httpOnly JWT cookie),
  signup/login/logout, KYC file upload and manual admin review, investment
  and profit-claim tracking backed by SQLite, withdrawal and referral-point
  redemption requests with an admin approval queue, analytics computed
  from actual signups/investments/earnings in the database, and an AI FAQ
  assistant (below) grounded in the site's real published content.
- **Stub, by design, until you're ready**: sending the email verification
  code. It's logged to the server console (and returned as `devCode` in the
  API response outside production) instead of actually emailed. Wire up a
  real provider (SMTP, SendGrid, etc.) in `src/routes/verify.js`'s
  `/send-code` handler, and set `NODE_ENV=production` so the code stops being
  returned in the response.
- **Never automatic, on purpose**: actually sending money. Withdrawals and
  referral-point redemptions create a request row that an admin reviews and
  marks `paid` — moving real funds (bank transfer, USDT payout, etc.) is a
  manual step you do outside this app. See "Admin workflow" below.

## Admin workflow

There's no admin UI yet — these are plain JSON API calls (e.g. via `curl` or
Postman), made while logged in as the admin account:

| Action | Endpoint |
|---|---|
| List users | `GET /api/admin/users` |
| List pending KYC submissions | `GET /api/admin/kyc/pending` |
| View a submitted KYC document | `GET /api/admin/kyc/:id/document` |
| Approve / reject KYC | `POST /api/admin/kyc/:id/approve` / `/reject` |
| Log a new investment for a user | `POST /api/admin/investments` `{ userId, project, amount }` |
| Distribute profit for an investment | `POST /api/admin/investments/:id/distribute-profit` `{ amount }` |
| Mark an investment completed | `POST /api/admin/investments/:id/complete` |
| List pending withdrawal requests | `GET /api/admin/withdrawals/pending` |
| Approve (mark paid) / reject a withdrawal | `POST /api/admin/withdrawals/:id/approve` / `/reject` |
| List pending referral redemptions | `GET /api/admin/referral-redemptions/pending` |
| Approve (mark paid) / reject a redemption | `POST /api/admin/referral-redemptions/:id/approve` / `/reject` |

"Approve" on withdrawals/redemptions only marks the record `paid` in the
database — you still have to actually send the money and then click approve
to record that you did.

## API reference (user-facing)

All endpoints are under `/api`. Auth uses an httpOnly cookie set by
login/signup — no token handling needed in the frontend beyond `credentials:
"same-origin"` on `fetch()` calls (already wired up in the site's JS).

- `POST /api/auth/signup` `{ name, email, dob, password, referralCode? }`
- `POST /api/auth/login` `{ email, password }`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/verify/status` → `{ email: bool, kyc: "none"|"pending"|"verified"|"rejected" }`
- `POST /api/verify/send-code`
- `POST /api/verify/confirm-code` `{ code }`
- `POST /api/verify/kyc` — multipart, field name `document` (jpeg/png/webp/pdf, ≤10MB)
- `GET /api/investments` → investments + totals for the logged-in user
- `POST /api/investments/:id/claim`
- `POST /api/investments/:id/withdraw` — requires KYC verified
- `GET /api/referral` → referral code/link, referred users, points, USDT value
- `POST /api/referral/redeem`
- `GET /api/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD` — admin only

## Data

Everything lives in `backend/data/` (gitignored): `halal-income.sqlite` and
uploaded KYC files under `kyc-uploads/`. Delete `halal-income.sqlite` to reset
to a clean database (you'll need to re-run `npm run seed:admin`).

## Deploying for real

Before this goes live with real users/money:
1. Set `NODE_ENV=production` and a strong random `JWT_SECRET`.
2. Wire up a real email provider for verification codes.
3. Put the server behind HTTPS (the session cookie is marked `secure` in
   production, so it won't be sent over plain HTTP).
4. Consider moving KYC file storage to encrypted cloud storage rather than
   local disk, and restricting who can access the `data/` directory.
5. Build an admin UI, or at least document the admin API calls above for
   whoever will be doing KYC/withdrawal review day to day.
