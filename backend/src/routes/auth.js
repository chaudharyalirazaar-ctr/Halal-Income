const express = require("express");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { db, generateReferralCode } = require("../db");
const { issueSessionCookie, clearSessionCookie, requireAuth, publicUser } = require("../middleware/auth");
const { sendEmail, layout } = require("../lib/mailer");
const { generateSecret, verifyToken, qrCodeDataUrl } = require("../lib/twoFactor");
const { isValidPinFormat } = require("../lib/pin");
const { sendSms } = require("../lib/sms");

const router = express.Router();

const { JWT_SECRET } = require("../lib/config");

const RESET_TOKEN_TTL_MINUTES = 30;
const PENDING_2FA_COOKIE = "pending2fa";
const PENDING_2FA_TTL_MINUTES = 5;

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Try again later." },
});

const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again later." },
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many accounts created from this network. Try again later." },
});

// A security PIN is only 4 digits (10,000 possibilities) and a PIN-reset code
// only 6 (1,000,000) — small enough to exhaust quickly if guesses are
// unlimited, and the PIN is what stands between a hijacked session and a
// withdrawal (or, on an admin account, approving one). Keyed per-user rather
// than per-IP: these routes are all behind requireAuth, so this bounds
// attempts against a given account instead of punishing everyone behind one
// shared IP.
const pinAttemptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `user:${req.user.id}` : req.ip),
  message: { error: "Too many PIN attempts. Wait 15 minutes and try again." },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Loose on purpose — accepts international formats (+, spaces, dashes,
// parentheses) without pinning to one country's numbering plan. Just makes
// sure there are enough digits to plausibly be a real phone number.
const PHONE_RE = /^[+\d][\d\s()-]{6,19}$/;

const insertUser = db.prepare(`
  INSERT INTO users (name, email, password_hash, dob, phone, referral_code, referred_by)
  VALUES (@name, @email, @password_hash, @dob, @phone, @referral_code, @referred_by)
`);
const getUserByEmail = db.prepare("SELECT * FROM users WHERE email = ?");
const getUserByReferralCode = db.prepare("SELECT * FROM users WHERE referral_code = ?");
const insertResetToken = db.prepare(`
  INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)
`);
const getResetToken = db.prepare(`
  SELECT * FROM password_reset_tokens WHERE token = ? AND consumed = 0
`);
const consumeResetToken = db.prepare("UPDATE password_reset_tokens SET consumed = 1 WHERE id = ?");
const setPasswordHash = db.prepare("UPDATE users SET password_hash = ? WHERE id = ?");

// Courtesy security alert: a login from a different IP than last time could
// be the account owner on a new network, or could be someone else entirely
// — an SMS either way costs nothing and lets the real owner notice fast if
// it wasn't them. Deliberately simple (IP change only, no device
// fingerprinting) rather than not shipping it at all; skips the very first
// login on an account (last_login_ip is null) so signup never falsely fires.
const setLastLoginIp = db.prepare("UPDATE users SET last_login_ip = ? WHERE id = ?");

function checkNewLoginLocation(user, req) {
  const currentIp = req.ip;
  if (user.last_login_ip && user.last_login_ip !== currentIp && user.phone) {
    sendSms({
      to: user.phone,
      body: `Halal Income: a login to your account was just detected from a new location. If this wasn't you, change your password immediately.`,
    });
  }
  setLastLoginIp.run(currentIp, user.id);
}

function isAdult(dobStr) {
  const dob = new Date(dobStr);
  if (Number.isNaN(dob.getTime())) return false;
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 18);
  return dob <= cutoff;
}

router.post("/signup", signupLimiter, (req, res) => {
  const { name, email, dob, phone, password, referralCode } = req.body || {};

  if (!name || !email || !dob || !phone || !password) {
    return res.status(400).json({ error: "Name, email, phone number, date of birth, and password are all required." });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }
  if (!PHONE_RE.test(String(phone).trim())) {
    return res.status(400).json({ error: "Enter a valid phone number." });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  if (!isAdult(dob)) {
    return res.status(400).json({ error: "You must be 18 or older to create an account." });
  }
  if (getUserByEmail.get(email.toLowerCase())) {
    return res.status(409).json({ error: "An account with that email already exists." });
  }

  let referredBy = null;
  if (referralCode) {
    const referrer = getUserByReferralCode.get(String(referralCode).toUpperCase());
    if (referrer) referredBy = referrer.id;
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  let code = generateReferralCode();
  while (getUserByReferralCode.get(code)) code = generateReferralCode();

  const result = insertUser.run({
    name: String(name).trim(),
    email: email.toLowerCase(),
    password_hash: passwordHash,
    dob,
    phone: String(phone).trim(),
    referral_code: code,
    referred_by: referredBy,
  });

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid);
  issueSessionCookie(res, user.id);
  res.status(201).json({ user: publicUser(user) });
});

router.post("/login", loginLimiter, (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  const user = getUserByEmail.get(String(email).toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Incorrect email or password." });
  }

  // Password alone isn't enough for an account with 2FA turned on — issue a
  // short-lived, purpose-scoped token (not a real session) and make the
  // client complete /2fa/verify-login before it gets a real session cookie.
  if (user.two_factor_enabled) {
    const pendingToken = jwt.sign({ userId: user.id, purpose: "2fa_pending" }, JWT_SECRET, {
      expiresIn: `${PENDING_2FA_TTL_MINUTES}m`,
    });
    res.cookie(PENDING_2FA_COOKIE, pendingToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: PENDING_2FA_TTL_MINUTES * 60 * 1000,
    });
    return res.json({ requires2fa: true });
  }

  checkNewLoginLocation(user, req);
  issueSessionCookie(res, user.id);
  res.json({ user: publicUser(user) });
});

function loadPending2fa(req) {
  const token = req.cookies && req.cookies[PENDING_2FA_COOKIE];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.purpose !== "2fa_pending") return null;
    return payload.userId;
  } catch {
    return null;
  }
}

router.post("/2fa/verify-login", loginLimiter, (req, res) => {
  const userId = loadPending2fa(req);
  if (!userId) return res.status(401).json({ error: "Your login session expired. Log in again." });

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user || !user.two_factor_enabled) return res.status(400).json({ error: "2FA is not enabled on this account." });

  const { code } = req.body || {};
  if (!verifyToken(code, user.two_factor_secret)) {
    return res.status(401).json({ error: "Incorrect authenticator code." });
  }

  res.clearCookie(PENDING_2FA_COOKIE);
  checkNewLoginLocation(user, req);
  issueSessionCookie(res, user.id);
  res.json({ user: publicUser(user) });
});

// ---- 2FA setup / enable / disable (for an already-logged-in user) ---------

router.get("/2fa/status", requireAuth, (req, res) => {
  res.json({ enabled: !!req.user.two_factor_enabled });
});

const setTwoFactorSecret = db.prepare("UPDATE users SET two_factor_secret = ? WHERE id = ?");
const enableTwoFactor = db.prepare("UPDATE users SET two_factor_enabled = 1 WHERE id = ?");
const disableTwoFactor = db.prepare("UPDATE users SET two_factor_enabled = 0, two_factor_secret = NULL WHERE id = ?");

// Generates (and stores, but does not yet enable) a new secret. Calling this
// again before /enable just overwrites the pending secret — fine, since
// nothing is protected by it until /enable succeeds.
router.post("/2fa/setup", requireAuth, async (req, res) => {
  try {
    const secret = generateSecret();
    setTwoFactorSecret.run(secret, req.user.id);
    const qr = await qrCodeDataUrl(req.user.email, secret);
    res.json({ secret, qrCodeDataUrl: qr });
  } catch (err) {
    console.error("[auth] 2FA setup failed:", err);
    res.status(500).json({ error: "Couldn't generate a 2FA secret. Please try again." });
  }
});

router.post("/2fa/enable", requireAuth, (req, res) => {
  const { code } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!user.two_factor_secret) {
    return res.status(400).json({ error: "Call /2fa/setup first to generate a secret." });
  }
  if (!verifyToken(code, user.two_factor_secret)) {
    return res.status(400).json({ error: "Incorrect code. Check your authenticator app and try again." });
  }
  enableTwoFactor.run(req.user.id);
  res.json({ ok: true });
});

router.post("/2fa/disable", requireAuth, (req, res) => {
  const { password } = req.body || {};
  if (!password || !bcrypt.compareSync(password, req.user.password_hash)) {
    return res.status(401).json({ error: "Incorrect password." });
  }
  disableTwoFactor.run(req.user.id);
  res.json({ ok: true });
});

// ---- Security PIN ----------------------------------------------------------
// One 4-digit PIN per account, required to submit a withdrawal (for regular
// users) or to approve/reject any pending request (for admins) — see
// backend/src/lib/pin.js's requirePin middleware for where it's enforced.

const setSecurityPin = db.prepare("UPDATE users SET security_pin_hash = ? WHERE id = ?");
const clearSecurityPin = db.prepare("UPDATE users SET security_pin_hash = NULL WHERE id = ?");

router.get("/pin/status", requireAuth, (req, res) => {
  res.json({ isSet: !!req.user.security_pin_hash });
});

// Setting a PIN for the first time needs only the current password (proves
// it's really the account owner). Changing an existing PIN needs the
// CURRENT PIN instead — a stolen/guessed password alone shouldn't be enough
// to silently swap out the PIN that's supposed to protect withdrawals and
// approvals.
router.post("/pin", requireAuth, pinAttemptLimiter, (req, res) => {
  const { pin, currentPassword, currentPin } = req.body || {};

  if (!isValidPinFormat(pin)) {
    return res.status(400).json({ error: "PIN must be exactly 4 digits." });
  }

  if (req.user.security_pin_hash) {
    if (!currentPin || !bcrypt.compareSync(String(currentPin), req.user.security_pin_hash)) {
      return res.status(401).json({ error: "Incorrect current PIN." });
    }
  } else {
    if (!currentPassword || !bcrypt.compareSync(currentPassword, req.user.password_hash)) {
      return res.status(401).json({ error: "Incorrect password." });
    }
  }

  setSecurityPin.run(bcrypt.hashSync(String(pin), 10), req.user.id);
  res.json({ ok: true });
});

router.post("/pin/remove", requireAuth, pinAttemptLimiter, (req, res) => {
  const { currentPin } = req.body || {};
  if (!req.user.security_pin_hash) return res.status(400).json({ error: "No PIN is set." });
  if (!currentPin || !bcrypt.compareSync(String(currentPin), req.user.security_pin_hash)) {
    return res.status(401).json({ error: "Incorrect current PIN." });
  }
  clearSecurityPin.run(req.user.id);
  res.json({ ok: true });
});

// ---- Forgot PIN (self-service recovery) ------------------------------------
// Setting/changing a PIN normally requires the current PIN — by design, so a
// stolen password alone can't silently swap it out. But that leaves no way
// back in if you genuinely forget it. This is the recovery path: since
// you're already logged in (proven by session cookie), a one-time code sent
// to your own email is a reasonable second factor to let you set a fresh PIN
// without the old one — same trust model as the account's email verification
// codes, just for a different purpose.

const PIN_RESET_CODE_TTL_MINUTES = 10;

const pinForgotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again later." },
});

const insertPinResetCode = db.prepare(`
  INSERT INTO pin_reset_codes (user_id, code, expires_at) VALUES (?, ?, ?)
`);
const getLatestPinResetCode = db.prepare(`
  SELECT * FROM pin_reset_codes WHERE user_id = ? AND consumed = 0 ORDER BY id DESC LIMIT 1
`);
const consumePinResetCode = db.prepare("UPDATE pin_reset_codes SET consumed = 1 WHERE id = ?");

router.post("/pin/forgot", requireAuth, pinForgotLimiter, (req, res) => {
  if (!req.user.security_pin_hash) {
    return res.status(400).json({ error: "No PIN is set yet — just set one directly." });
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const expiresAt = new Date(Date.now() + PIN_RESET_CODE_TTL_MINUTES * 60 * 1000).toISOString();
  insertPinResetCode.run(req.user.id, code, expiresAt);

  sendEmail({
    to: req.user.email,
    subject: `Your PIN reset code: ${code}`,
    html: layout(
      "Reset your security PIN",
      `<p>Someone (hopefully you) requested to reset the PIN on your account. Enter this code to set a new one:</p>
       <p style="font-size: 28px; font-weight: 700; letter-spacing: 4px; margin: 16px 0;">${code}</p>
       <p>This code expires in ${PIN_RESET_CODE_TTL_MINUTES} minutes. If you didn't request this, you can ignore it — your current PIN still works.</p>`
    ),
  });

  const response = { sent: true };
  if (process.env.NODE_ENV !== "production") response.devCode = code;
  res.json(response);
});

router.post("/pin/reset", requireAuth, pinAttemptLimiter, (req, res) => {
  const { code, pin } = req.body || {};
  if (!isValidPinFormat(pin)) {
    return res.status(400).json({ error: "PIN must be exactly 4 digits." });
  }

  const latest = getLatestPinResetCode.get(req.user.id);
  if (!latest) return res.status(400).json({ error: "No pending reset code. Request a new one." });
  if (new Date(latest.expires_at) < new Date()) {
    return res.status(400).json({ error: "That code has expired. Request a new one." });
  }
  if (!code || String(code).trim() !== latest.code) {
    return res.status(400).json({ error: "Incorrect code." });
  }

  consumePinResetCode.run(latest.id);
  setSecurityPin.run(bcrypt.hashSync(String(pin), 10), req.user.id);
  res.json({ ok: true });
});

router.post("/forgot-password", forgotPasswordLimiter, (req, res) => {
  const { email } = req.body || {};
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }

  // Always respond the same way whether or not the account exists, so this
  // endpoint can't be used to discover which emails have accounts.
  const genericResponse = { sent: true };
  const user = getUserByEmail.get(String(email).toLowerCase());
  if (!user) return res.json(genericResponse);

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000).toISOString();
  insertResetToken.run(user.id, token, expiresAt);

  const resetLink = `${req.protocol}://${req.get("host")}/reset-password.html?token=${token}`;

  // sendEmail() logs to the console instead of actually sending if
  // RESEND_API_KEY isn't set — see backend/src/lib/mailer.js.
  sendEmail({
    to: user.email,
    subject: "Reset your Halal Income password",
    html: layout(
      "Reset your password",
      `<p>We received a request to reset your password. This link expires in ${RESET_TOKEN_TTL_MINUTES} minutes:</p>
       <p style="margin: 20px 0;">
         <a href="${resetLink}" style="background:#1F4A3D;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block;">Reset password</a>
       </p>
       <p style="font-size: 13px; color: #555;">If you didn't request this, you can safely ignore this email.</p>`
    ),
  });

  if (process.env.NODE_ENV !== "production") genericResponse.devResetLink = resetLink;
  res.json(genericResponse);
});

router.post("/reset-password", (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) {
    return res.status(400).json({ error: "Reset token and new password are required." });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  const row = getResetToken.get(token);
  if (!row || new Date(row.expires_at) < new Date()) {
    return res.status(400).json({ error: "This reset link is invalid or has expired. Request a new one." });
  }

  setPasswordHash.run(bcrypt.hashSync(password, 10), row.user_id);
  consumeResetToken.run(row.id);
  res.json({ ok: true });
});

router.post("/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Invalidates every session token on this account at once — see the
// token_version comment in middleware/auth.js for the mechanism. Includes
// the current device too (matches what "log out of all devices" implies);
// the caller needs to log back in here just like anywhere else afterward.
const bumpTokenVersion = db.prepare("UPDATE users SET token_version = token_version + 1 WHERE id = ?");
router.post("/logout-all", requireAuth, (req, res) => {
  bumpTokenVersion.run(req.user.id);
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

module.exports = router;
