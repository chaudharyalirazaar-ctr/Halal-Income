require("dotenv").config();

const path = require("node:path");
const express = require("express");
const cookieParser = require("cookie-parser");

const { attachUser } = require("./middleware/auth");
const authRoutes = require("./routes/auth");
const verifyRoutes = require("./routes/verify");
const investmentRoutes = require("./routes/investments");
const referralRoutes = require("./routes/referral");
const analyticsRoutes = require("./routes/analytics");
const adminRoutes = require("./routes/admin");
const assistantRoutes = require("./routes/assistant");
const projectsRoutes = require("./routes/projects");
const walletRoutes = require("./routes/wallet");
const notificationsRoutes = require("./routes/notifications");
const supportRoutes = require("./routes/support");
const scheduler = require("./lib/scheduler");
const { runNightlyBackup } = require("./lib/scheduledBackup");
const { runKycReverificationReminders } = require("./lib/kycReminders");
const { runProfitDistributionReminders } = require("./lib/profitReminders");

// Node's default behavior is to crash the entire process on an unhandled
// promise rejection. In an Express 4 app, any `async (req, res) => {...}`
// route handler that throws WITHOUT a local try/catch produces exactly that —
// which would take down every logged-in user's session over one bad request,
// not just fail that request. Every async handler in this codebase has been
// given a local try/catch, but this is a deliberate last-resort safety net
// in case a future one is missed: log it and keep the server running, rather
// than silently going down for everyone.
process.on("unhandledRejection", (reason) => {
  console.error("[server] Unhandled promise rejection (server is staying up):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[server] Uncaught exception (server is staying up):", err);
});

const app = express();
const siteRoot = path.join(__dirname, "..", "..");

// Trust the first proxy hop (Railway's edge / any single reverse proxy in
// front of this app) so req.ip reflects the real client IP from
// X-Forwarded-For. Without this, Express ignores that header by default,
// and express-rate-limit (used throughout this app) throws a validation
// error on every rate-limited request once it detects a forwarded-for
// header it wasn't told to trust — in production this manifested as
// requests to rate-limited routes (login, deposits, admin actions, the
// backup download, etc.) hanging instead of completing. Harmless locally
// (no proxy in front of it there, so the header is simply absent).
app.set("trust proxy", 1);

app.disable("x-powered-by");

// Baseline security headers. Hand-rolled rather than pulling in helmet: it's
// five headers, and being able to read exactly what's set (and why) beats a
// dependency whose defaults would need auditing anyway.
app.use((req, res, next) => {
  // Stop browsers from MIME-sniffing a response into something executable —
  // relevant here because admins download user-uploaded KYC docs and payment
  // proofs through this origin.
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Clickjacking: nothing here should ever be framed by another site.
  res.setHeader("X-Frame-Options", "DENY");
  // Don't leak full URLs (which can carry reset tokens) to third parties.
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=()");
  // CSP as defence-in-depth behind output escaping, not instead of it.
  // 'unsafe-inline' is currently required for both scripts and styles: the
  // pages carry inline <script> blocks and inline style="..." attributes
  // throughout. That weakens script-src specifically, so the other
  // directives are the ones doing real work here — locking down where
  // scripts/frames/forms can point, which still blocks the most common
  // injection payloads (external script loads, exfiltration endpoints,
  // injected iframes). Tightening script-src to a nonce means extracting
  // every inline block to a file first; worth doing, but a separate change.
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; ")
  );
  next();
});

app.use(express.json());
app.use(cookieParser());
app.use(attachUser);

// Unauthenticated, no DB access — just confirms the process is up and
// responding. Point your host's uptime monitor / container healthcheck here.
app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/verify", verifyRoutes);
app.use("/api/investments", investmentRoutes);
app.use("/api/referral", referralRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/assistant", assistantRoutes);
app.use("/api/projects", projectsRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/support", supportRoutes);

// Serve the existing static website (index.html, styles.css, *.js, etc.)
// from the same origin/port so session cookies work without any CORS setup.
// The backend folder itself (secrets, the sqlite file, uploaded KYC
// documents) lives inside siteRoot, so it must be blocked from this static
// mount explicitly — KYC files are only ever served via the admin-only
// /api/admin/kyc/:id/document route.
app.use((req, res, next) => {
  if (req.path.toLowerCase().startsWith("/backend")) return res.status(404).end();
  next();
});
app.use(express.static(siteRoot));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server." });
});

// Background jobs — nightly backup, KYC re-verification nudges, "time to
// distribute profit" nudges. See lib/scheduler.js for how "daily" actually
// works (DB-persisted last-run time, so a restart/redeploy doesn't
// re-trigger everything).
scheduler.registerDailyJob("nightly-backup", runNightlyBackup);
scheduler.registerDailyJob("kyc-reverification-reminders", runKycReverificationReminders);
scheduler.registerDailyJob("profit-distribution-reminders", runProfitDistributionReminders);
scheduler.start();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Halal Income server running at http://localhost:${PORT}`);
});
