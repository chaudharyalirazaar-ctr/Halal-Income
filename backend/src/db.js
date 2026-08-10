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

  -- Self-service recovery for a forgotten security PIN — the logged-in user
  -- (proven by session cookie + this code landing in their own inbox) can
  -- set a fresh PIN without knowing the old one. See POST /api/auth/pin/forgot
  -- and /api/auth/pin/reset.
  CREATE TABLE IF NOT EXISTS pin_reset_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
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
// worked before this migration changes behavior). From here on, `role` only
// distinguishes super_admin (everything, incl. managing other admins'
// access) from everyone else ('none') — granular capabilities for
// non-super admins live in the `permissions` column added below instead of
// as fixed role names, so an owner can compose exactly the access each
// helper needs (e.g. "KYC review only" or "withdrawals + KYC" or "project
// manager") rather than picking from a short fixed list.
// Existing admins are grandfathered in as super_admin so nobody loses access
// when this migration first runs.
if (!userColumns.some((c) => c.name === "role")) {
  db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'none'");
  db.exec("UPDATE users SET role = 'super_admin' WHERE is_admin = 1");
}

// Granular per-admin capabilities (JSON array of strings, e.g.
// '["approve_kyc","approve_withdrawals"]'). super_admin bypasses this
// entirely (has every capability implicitly) — see requirePermission() in
// middleware/auth.js. Backfills the two earlier fixed roles
// (kyc_reviewer/finance_admin, from before this column existed) into their
// equivalent permission sets so nobody's access silently narrows when this
// migration first runs, then resets `role` on those rows to 'none' since
// granular permissions are now the source of truth for non-super admins.
if (!userColumns.some((c) => c.name === "permissions")) {
  db.exec("ALTER TABLE users ADD COLUMN permissions TEXT NOT NULL DEFAULT '[]'");
  db.prepare(
    `UPDATE users SET permissions = '["approve_kyc"]', role = 'none' WHERE role = 'kyc_reviewer'`
  ).run();
  db.prepare(
    `UPDATE users SET permissions = '["approve_deposits","approve_withdrawals","approve_investments","approve_redemptions"]', role = 'none' WHERE role = 'finance_admin'`
  ).run();
}

// Phone number, collected at signup. Nullable so existing accounts created
// before this migration aren't broken by a NOT NULL default.
if (!userColumns.some((c) => c.name === "phone")) {
  db.exec("ALTER TABLE users ADD COLUMN phone TEXT");
}

// Security PIN — a single 4-digit PIN per account, used two different ways
// depending on who the account belongs to: a regular user must enter it to
// submit a withdrawal request; an admin must enter it to approve or reject
// any pending request. Nullable — nobody has one until they set it via
// POST /api/auth/pin, and the relevant action is blocked with a clear error
// until they do (see lib/pin.js's requirePin middleware).
if (!userColumns.some((c) => c.name === "security_pin_hash")) {
  db.exec("ALTER TABLE users ADD COLUMN security_pin_hash TEXT");
}

// Rejection reasons — every reject action on these five queues can now
// carry an admin-written explanation the affected user sees, so a mistaken
// or disputed rejection is something they can actually understand and
// resubmit against instead of a silent no.
[
  ["kyc_submissions", "rejection_reason"],
  ["deposit_requests", "rejection_reason"],
  ["withdrawal_requests", "rejection_reason"],
  ["investment_requests", "rejection_reason"],
  ["referral_redemptions", "rejection_reason"],
].forEach(([table, column]) => {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
  }
});

// Project update posts — short admin-written notes ("August production run
// complete, profit distributed") shown to investors on their Balance page,
// so the numbers changing isn't the only signal an investor ever gets.
// Public to view (matches how projects themselves are public on
// invest.html) — only admins with manage_projects can post one.
db.exec(`
  CREATE TABLE IF NOT EXISTS project_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    admin_id INTEGER REFERENCES users(id),
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Support ticket escalation — "this didn't answer my question" from the AI
// assistant widget (see routes/support.js). user_id is nullable: the AI
// assistant is public/no-login, so an anonymous visitor can escalate too,
// identified only by the email they type in. conversation is a JSON string
// of the {role, content} chat transcript at the moment they escalated, kept
// for admin context since the AI assistant itself never persists history.
db.exec(`
  CREATE TABLE IF NOT EXISTS support_tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    message TEXT NOT NULL,
    conversation TEXT,
    status TEXT NOT NULL DEFAULT 'open', -- open | in_progress | resolved
    admin_reply TEXT,
    replied_by INTEGER REFERENCES users(id),
    replied_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Tracks the last time each named background job ran (see lib/scheduler.js).
// Persisted in the DB rather than kept in memory so a server restart (very
// common in dev, and on every Railway deploy in production) doesn't cause a
// daily job to fire again immediately just because in-memory state reset.
db.exec(`
  CREATE TABLE IF NOT EXISTS scheduler_state (
    job_name TEXT PRIMARY KEY,
    last_run_at TEXT NOT NULL
  );
`);

// token_version: bumped by POST /api/auth/logout-all to invalidate every
// outstanding session JWT at once ("log out of all devices") without needing
// a server-side session store — the JWT's own `v` claim just has to match
// this value or the token is treated as invalid. See middleware/auth.js.
// last_login_ip: compared on each login to flag a login from a new location
// for an SMS alert (see lib/sms.js) — nullable so the very first login on an
// account never falsely triggers one.
// kyc_reminder_sent_at: last time a re-verification reminder was sent, so
// the scheduled job (lib/kycReminders.js) nudges periodically rather than
// re-notifying every single day once someone's KYC is old.
if (!userColumns.some((c) => c.name === "token_version")) {
  db.exec("ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0");
}
if (!userColumns.some((c) => c.name === "last_login_ip")) {
  db.exec("ALTER TABLE users ADD COLUMN last_login_ip TEXT");
}
if (!userColumns.some((c) => c.name === "kyc_reminder_sent_at")) {
  db.exec("ALTER TABLE users ADD COLUMN kyc_reminder_sent_at TEXT");
}

// profit_reminder_sent_at: last time an admin was nudged that this project's
// active investments haven't had profit distributed in a while (see
// lib/profitReminders.js) — same "don't re-notify every day" purpose as
// kyc_reminder_sent_at above.
const projectColumns = db.prepare("PRAGMA table_info(projects)").all();
if (!projectColumns.some((c) => c.name === "profit_reminder_sent_at")) {
  db.exec("ALTER TABLE projects ADD COLUMN profit_reminder_sent_at TEXT");
}

function generateReferralCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

module.exports = { db, generateReferralCode };
