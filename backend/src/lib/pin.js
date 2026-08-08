const bcrypt = require("bcryptjs");

const PIN_RE = /^\d{4}$/;

function isValidPinFormat(pin) {
  return PIN_RE.test(String(pin || ""));
}

// Gates a route behind the logged-in user's own security PIN (sent as
// `pin` in the request body). Used for two different actions depending on
// who's calling it — a user submitting a withdrawal, or an admin approving/
// rejecting any pending request — but it's the same check either way: your
// own account's PIN, checked against your own account's hash.
// Mounted after requireAuth (req.user must already be set).
function requirePin(req, res, next) {
  if (!req.user.security_pin_hash) {
    return res.status(400).json({
      error: "Set a security PIN first (see your account settings) before you can do this.",
      code: "PIN_NOT_SET",
    });
  }

  const { pin } = req.body || {};
  if (!pin || !bcrypt.compareSync(String(pin), req.user.security_pin_hash)) {
    return res.status(403).json({ error: "Incorrect PIN.", code: "PIN_INCORRECT" });
  }

  next();
}

module.exports = { requirePin, isValidPinFormat, PIN_RE };
