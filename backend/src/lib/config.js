const crypto = require("node:crypto");

// The value shipped in .env.example. It's in the public repo, so treating it
// as a real secret would be the same as having no secret at all.
const PLACEHOLDER_SECRET = "change-this-to-a-long-random-string";
const MIN_SECRET_LENGTH = 32;

// Session cookies are signed with this. It used to fall back to a hardcoded
// string when JWT_SECRET was unset — which meant anyone who read this repo
// could forge a cookie for any user id, including a super admin, with no
// password, 2FA or PIN. There is deliberately no fallback now:
//
//   production  — refuse to start. A finance app running on a guessable
//                 signing key is worse than a failed deploy, and failing at
//                 boot makes the misconfiguration impossible to miss.
//   development — generate a random secret per run. Local work keeps
//                 working with no setup, sessions just don't survive a
//                 restart, and there is never a fixed publicly-known key.
function resolveJwtSecret() {
  const fromEnv = process.env.JWT_SECRET;
  const usable = fromEnv && fromEnv !== PLACEHOLDER_SECRET && fromEnv.length >= MIN_SECRET_LENGTH;

  if (process.env.NODE_ENV === "production") {
    if (!usable) {
      console.error(
        "\n[config] FATAL: JWT_SECRET is missing, still set to the .env.example placeholder,\n" +
          `         or shorter than ${MIN_SECRET_LENGTH} characters.\n\n` +
          "         Session cookies are signed with it, so a weak or publicly-known value\n" +
          "         lets anyone forge an admin session. Refusing to start.\n\n" +
          "         Generate one with:\n" +
          `           node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"\n\n` +
          "         then set it as JWT_SECRET in your host's environment variables.\n" +
          "         (Changing it logs every existing session out — that's expected.)\n"
      );
      process.exit(1);
    }
    return fromEnv;
  }

  if (usable) return fromEnv;

  const ephemeral = crypto.randomBytes(48).toString("hex");
  console.warn(
    "[config] JWT_SECRET is unset or still the placeholder — using a random one for this run. " +
      "Logins won't survive a server restart. Set a real JWT_SECRET in backend/.env to keep them."
  );
  return ephemeral;
}

const JWT_SECRET = resolveJwtSecret();

module.exports = { JWT_SECRET };
