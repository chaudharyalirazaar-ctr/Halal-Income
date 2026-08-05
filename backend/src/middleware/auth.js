const jwt = require("jsonwebtoken");
const { db } = require("../db");

const COOKIE_NAME = "session";
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-insecure-secret-change-me";

function issueSessionCookie(res, userId) {
  const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: "30d" });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

const getUserById = db.prepare("SELECT * FROM users WHERE id = ?");

function loadUserFromToken(req) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = getUserById.get(payload.userId);
    return user || null;
  } catch {
    return null;
  }
}

// Attaches req.user if a valid session cookie is present; never rejects.
function attachUser(req, res, next) {
  req.user = loadUserFromToken(req);
  next();
}

// Rejects with 401 if there is no valid logged-in user.
function requireAuth(req, res, next) {
  const user = loadUserFromToken(req);
  if (!user) return res.status(401).json({ error: "Not logged in." });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.user.is_admin) return res.status(403).json({ error: "Admin access required." });
    next();
  });
}

// Narrows requireAdmin to specific roles — super_admin always passes
// regardless of which roles are listed, since it's the "can do everything"
// role. Call as requireRole("kyc_reviewer") or requireRole("finance_admin"),
// mounted after router.use(requireAdmin) so req.user is already set.
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (req.user.role === "super_admin" || allowedRoles.includes(req.user.role)) return next();
    return res.status(403).json({ error: "You don't have permission for this action." });
  };
}

// Strips the password hash and 2FA secret before a user row goes into any API response.
function publicUser(user) {
  if (!user) return null;
  const { password_hash, two_factor_secret, ...rest } = user;
  return rest;
}

module.exports = {
  COOKIE_NAME,
  issueSessionCookie,
  clearSessionCookie,
  attachUser,
  requireAuth,
  requireAdmin,
  requireRole,
  publicUser,
};
