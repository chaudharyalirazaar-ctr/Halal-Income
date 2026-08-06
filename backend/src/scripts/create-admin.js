// Creates an admin account (or promotes an existing one) from ADMIN_EMAIL /
// ADMIN_PASSWORD in .env. Run with: npm run seed:admin
require("dotenv").config();

const bcrypt = require("bcryptjs");
const { db, generateReferralCode } = require("../db");

const email = (process.env.ADMIN_EMAIL || "").toLowerCase().trim();
const password = process.env.ADMIN_PASSWORD || "";

if (!email || !password) {
  console.error("Set ADMIN_EMAIL and ADMIN_PASSWORD in backend/.env first.");
  process.exit(1);
}
if (password.length < 8) {
  console.error("ADMIN_PASSWORD must be at least 8 characters.");
  process.exit(1);
}

const existing = db.prepare("SELECT * FROM users WHERE email = ?").get(email);

if (existing) {
  // is_admin alone only satisfies requireAdmin — routes locked down further
  // with requireRole("kyc_reviewer" / "finance_admin" / etc., see
  // middleware/auth.js) also check the `role` column, so this needs setting
  // explicitly too or a freshly seeded/promoted admin gets 403'd on backup
  // downloads, KYC approvals, and every other role-gated action.
  db.prepare("UPDATE users SET is_admin = 1, role = 'super_admin', password_hash = ? WHERE id = ?")
    .run(bcrypt.hashSync(password, 10), existing.id);
  console.log(`Promoted existing user ${email} to super_admin and reset their password.`);
} else {
  let code = generateReferralCode();
  while (db.prepare("SELECT 1 FROM users WHERE referral_code = ?").get(code)) {
    code = generateReferralCode();
  }
  db.prepare(`
    INSERT INTO users (name, email, password_hash, dob, is_admin, role, email_verified, kyc_status, referral_code)
    VALUES ('Admin', ?, ?, '1990-01-01', 1, 'super_admin', 1, 'verified', ?)
  `).run(email, bcrypt.hashSync(password, 10), code);
  console.log(`Created super_admin account for ${email}.`);
}
