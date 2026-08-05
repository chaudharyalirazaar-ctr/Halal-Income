const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const dataDir = path.join(__dirname, "..", "data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, "halal-income.sqlite"));

db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    dob TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    email_verified INTEGER NOT NULL DEFAULT 0,
    kyc_status TEXT NOT NULL DEFAULT 'none', -- none | pending | verified | rejected
    referral_code TEXT NOT NULL UNIQUE,
    referred_by INTEGER REFERENCES users(id),
    wallet_balance REAL NOT NULL DEFAULT 0,   -- deposited + claimed profit, available to invest or withdraw
    total_withdrawn REAL NOT NULL DEFAULT 0,  -- sum of withdrawal_requests marked 'paid'
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS email_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS kyc_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    original_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | verified | rejected
    reviewed_by INTEGER REFERENCES users(id),
    reviewed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    target_amount REAL NOT NULL,
    start_date TEXT NOT NULL, -- YYYY-MM-DD
    end_date TEXT NOT NULL,   -- YYYY-MM-DD
    status TEXT NOT NULL DEFAULT 'open', -- open | closed
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS investments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project TEXT NOT NULL,
    project_id INTEGER REFERENCES projects(id),
    amount REAL NOT NULL,
    profit_this_period REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active', -- active | completed
    claimed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Investing now draws from the user's wallet balance (funded by approved
  -- deposits) rather than needing its own payment proof — the payment_method/
  -- transaction_id/proof_* columns are kept only for rows created before this
  -- change and are left blank on new ones. See deposit_requests below for
  -- where payment proof now lives.
  CREATE TABLE IF NOT EXISTS investment_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    amount REAL NOT NULL,
    payment_method TEXT NOT NULL DEFAULT '',
    transaction_id TEXT NOT NULL DEFAULT '',
    proof_file_path TEXT NOT NULL DEFAULT '',
    proof_original_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
    requested_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT,
    processed_by INTEGER REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS deposit_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount REAL NOT NULL,
    payment_method TEXT NOT NULL DEFAULT '',
    transaction_id TEXT NOT NULL DEFAULT '' UNIQUE, -- payment reference; enforced unique so it can never be reused
    proof_file_path TEXT NOT NULL DEFAULT '',
    proof_original_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
    requested_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT,
    processed_by INTEGER REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS earnings_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    investment_id INTEGER NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount REAL NOT NULL,
    event_date TEXT NOT NULL DEFAULT (date('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS withdrawal_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    investment_id INTEGER REFERENCES investments(id),
    amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | paid
    requested_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT,
    processed_by INTEGER REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS referral_redemptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    points INTEGER NOT NULL,
    usdt_amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | paid
    requested_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT,
    processed_by INTEGER REFERENCES users(id)
  );

  -- In-app notifications (bell icon). link is an optional relative URL
  -- (e.g. "/balance.html") the frontend can navigate to when clicked.
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    link TEXT,
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Every admin action that changes money or account state gets one row here.
  -- details is a free-form JSON string with whatever context is useful for
  -- that action type (amounts, prior status, etc.) — kept loose on purpose so
  -- new admin actions can log without a schema change.
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER REFERENCES users(id),
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id INTEGER,
    details TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migrations: existing databases created before a feature won't have these
// columns from CREATE TABLE IF NOT EXISTS alone.
const investmentColumns = db.prepare("PRAGMA table_info(investments)").all();
if (!investmentColumns.some((c) => c.name === "project_id")) {
  db.exec("ALTER TABLE investments ADD COLUMN project_id INTEGER REFERENCES projects(id)");
}

const userColumns = db.prepare("PRAGMA table_info(users)").all();
if (!userColumns.some((c) => c.name === "wallet_balance")) {
  db.exec("ALTER TABLE users ADD COLUMN wallet_balance REAL NOT NULL DEFAULT 0");
}

const investmentRequestColumns = db.prepare("PRAGMA table_info(investment_requests)").all();
const requestColumnNames = new Set(investmentRequestColumns.map((c) => c.name));
if (!requestColumnNames.has("payment_method")) {
  db.exec("ALTER TABLE investment_requests ADD COLUMN payment_method TEXT NOT NULL DEFAULT ''");
}
if (!requestColumnNames.has("transaction_id")) {
  db.exec("ALTER TABLE investment_requests ADD COLUMN transaction_id TEXT NOT NULL DEFAULT ''");
}
if (!requestColumnNames.has("proof_file_path")) {
  db.exec("ALTER TABLE investment_requests ADD COLUMN proof_file_path TEXT NOT NULL DEFAULT ''");
}
if (!requestColumnNames.has("proof_original_name")) {
  db.exec("ALTER TABLE investment_requests ADD COLUMN proof_original_name TEXT NOT NULL DEFAULT ''");
}
// Investing no longer needs its own payment proof (that moved to deposits —
// see deposit_requests below), so transaction_id on investment_requests is
// no longer required to be unique. Drop whatever unique index an earlier
// version of this migration created, so multiple new rows with the default
// '' don't collide. No-op on databases that never had it.
db.exec("DROP INDEX IF EXISTS idx_investment_requests_transaction_id");

// TOTP 2FA fields (nullable secret; enabled flag is what login actually gates on).
if (!userColumns.some((c) => c.name === "two_factor_secret")) {
  db.exec("ALTER TABLE users ADD COLUMN two_factor_secret TEXT");
}
if (!userColumns.some((c) => c.name === "two_factor_enabled")) {
  db.exec("ALTER TABLE users ADD COLUMN two_factor_enabled INTEGER NOT NULL DEFAULT 0");
}

// Multi-admin roles, layered on top of the existing is_admin flag rather than
// replacing it (requireAdmin still just checks is_admin, so nothing that
// worked before this migration changes behavior). role narrows what an admin
// can do: super_admin (everything, incl. managing other admins' roles),
// kyc_reviewer (KYC queue only), finance_admin (deposits/withdrawals/
// investment-requests/backup-restore), or 'none' for non-admin users.
// Existing admins are grandfathered in as super_admin so nobody loses access
// when this migration first runs.
if (!userColumns.some((c) => c.name === "role")) {
  db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'none'");
  db.exec("UPDATE users SET role = 'super_admin' WHERE is_admin = 1");
}

function generateReferralCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

module.exports = { db, generateReferralCode };
