const jwt = require("jsonwebtoken");
const { db } = require("../db");

const COOKIE_NAME = "session";
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-insecure-secret-change-me";

const getTokenVersion = db.prepare("SELECT token_version FROM users WHERE id = ?");

// The JWT carries the account's token_version at the moment it was issued
// (`v`). "Log out of all devices" (POST /api/auth/logout-all) just bumps
// that column — every outstanding token everywhere, including the one in
// this very cookie, stops matching and is treated as invalid from then on.
// No server-side session store needed for that: the version comparison in
// loadUserFromToken() below is the whole mechanism.
function issueSessionCookie(res, userId) {
  const row = getTokenVersion.get(userId);
  const token = jwt.sign({ userId, v: row ? row.token_version : 0 }, JWT_SECRET, { expiresIn: "30d" });
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
    if (!user) return null;
    if ((payload.v || 0) !== (user.token_version || 0)) return null; // invalidated by logout-all
    return user;
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

// Narrows requireAdmin to super_admin only — used for the handful of
// actions that are too sensitive to hand to a helper regardless of which
// specific permissions they've been granted: full backup/restore, viewing
// the audit log, and managing other admins' access. Call as requireRole()
// with no arguments, mounted after router.use(requireAdmin) so req.user is
// already set.
function requireRole() {
  return (req, res, next) => {
    if (req.user.role === "super_admin") return next();
    return res.status(403).json({ error: "Only a super admin can do this." });
  };
}

function parsePermissions(user) {
  try {
    const parsed = JSON.parse(user.permissions || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Gates a route behind one specific capability (e.g. "approve_kyc",
// "approve_withdrawals", "manage_projects" — see PATCH /admin/users/:id/
// permissions for the full list). super_admin bypasses this and has every
// capability implicitly. Mounted after router.use(requireAdmin).
function requirePermission(permission) {
  return (req, res, next) => {
    if (req.user.role === "super_admin" || parsePermissions(req.user).includes(permission)) {
      return next();
    }
    return res.status(403).json({ error: "You don't have permission for this action." });
  };
}

// Strips the password hash and 2FA secret before a user row goes into any
// API response, and parses `permissions` from its stored JSON string into a
// real array so the frontend never has to JSON.parse it itself.
function publicUser(user) {
  if (!user) return null;
  const { password_hash, two_factor_secret, security_pin_hash, ...rest } = user;
  return { ...rest, permissions: parsePermissions(user), pinSet: !!security_pin_hash };
}

module.exports = {
  COOKIE_NAME,
  issueSessionCookie,
  clearSessionCookie,
  attachUser,
  requireAuth,
  requireAdmin,
  requireRole,
  requirePermission,
  parsePermissions,
  publicUser,
};
