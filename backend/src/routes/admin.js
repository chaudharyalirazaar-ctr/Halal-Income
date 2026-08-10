const express = require("express");
const path = require("node:path");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const { db } = require("../db");
const { requireAdmin, requireRole, requirePermission, parsePermissions } = require("../middleware/auth");
const { sendXlsx, sendPdf } = require("../lib/exporters");
const { createBackupZip, restoreFromZip } = require("../lib/backup");
const { sendEmail, layout } = require("../lib/mailer");
const { notify } = require("../lib/notifications");
const { logAction } = require("../lib/audit");
const { requirePin } = require("../lib/pin");

const router = express.Router();
const dataDir = path.join(__dirname, "..", "..", "data");

router.use(requireAdmin);

// A tighter limiter for the handful of routes that move money or overwrite
// the whole site's data — separate from the general per-IP limits on public
// auth/wallet routes, since these are already behind admin auth but still
// worth bounding (a compromised admin session, a buggy retry loop, etc.).
const sensitiveActionLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many actions in a short time. Wait a few minutes and try again." },
});

// ---- Users -----------------------------------------------------------

const listUsers = db.prepare(`
  SELECT id, name, email, phone, is_admin, role, permissions, email_verified, kyc_status, referral_code, wallet_balance, total_withdrawn, created_at,
    (security_pin_hash IS NOT NULL) AS pin_set
  FROM users ORDER BY created_at DESC
`);
const getUserByIdForRole = db.prepare("SELECT * FROM users WHERE id = ?");
const setUserAccess = db.prepare("UPDATE users SET role = ?, permissions = ?, is_admin = ? WHERE id = ?");

function userWithParsedPermissions(u) {
  return u ? { ...u, permissions: parsePermissions(u) } : u;
}

router.get("/users", (req, res) => {
  res.json({ users: listUsers.all().map(userWithParsedPermissions) });
});

// Every capability that can be granted to a non-super admin individually.
// "Team & permissions" in admin.html composes these into whatever mix an
// owner wants for a given helper — a KYC-only reviewer, a withdrawals
// approver, a project manager, someone who can see everything but approve
// nothing, or any combination.
const VALID_PERMISSIONS = [
  "approve_kyc",
  "approve_deposits",
  "approve_withdrawals",
  "approve_investments",
  "approve_redemptions",
  "manage_projects",
];

// Only super_admin can grant/change another admin's access — this is the
// one action in the whole panel that can create another admin, so it's the
// most locked-down. isSuperAdmin grants everything implicitly and ignores
// whatever specific permissions were also sent; otherwise is_admin is
// derived from whether any permission was granted at all (a plain admin
// with zero permissions can still view every admin page — that's the
// "sees all data, approves nothing" role — but isn't flagged as an admin
// at all unless they have at least one permission or super_admin).
router.patch("/users/:id/permissions", requireRole(), (req, res) => {
  const { isSuperAdmin, permissions, canViewOnly } = req.body || {};
  const target = getUserByIdForRole.get(req.params.id);
  if (!target) return res.status(404).json({ error: "User not found." });

  const requestedPermissions = Array.isArray(permissions) ? permissions : [];
  const invalid = requestedPermissions.filter((p) => !VALID_PERMISSIONS.includes(p));
  if (invalid.length) {
    return res.status(400).json({ error: `Unknown permission(s): ${invalid.join(", ")}` });
  }

  if (target.id === req.user.id && !isSuperAdmin) {
    return res.status(400).json({ error: "You can't remove your own super admin access. Have another super admin do it." });
  }

  const role = isSuperAdmin ? "super_admin" : "none";
  const finalPermissions = isSuperAdmin ? [] : requestedPermissions;
  const isAdmin = isSuperAdmin || finalPermissions.length > 0 || !!canViewOnly ? 1 : 0;

  setUserAccess.run(role, JSON.stringify(finalPermissions), isAdmin, target.id);
  logAction(req.user.id, "user.access_change", "user", target.id, {
    from: { role: target.role, permissions: parsePermissions(target) },
    to: { role, permissions: finalPermissions, isAdmin: !!isAdmin },
  });
  res.json({ user: userWithParsedPermissions(listUsers.all().find((u) => u.id === target.id)) });
});

// Fallback for when a user can't use the self-service email-code recovery
// (POST /api/auth/pin/forgot) — e.g. they've also lost access to their
// email. Clears the PIN entirely; they set a fresh one themselves the normal
// way (which only needs their password once no PIN is set). super_admin
// only, and logged, since this is the one other action besides granting
// access itself that can affect another account's security.
const clearUserPin = db.prepare("UPDATE users SET security_pin_hash = NULL WHERE id = ?");

router.post("/users/:id/reset-pin", requireRole(), (req, res) => {
  const target = getUserByIdForRole.get(req.params.id);
  if (!target) return res.status(404).json({ error: "User not found." });
  if (!target.security_pin_hash) return res.status(400).json({ error: "This user doesn't have a PIN set." });

  clearUserPin.run(target.id);
  logAction(req.user.id, "user.pin_reset", "user", target.id, {});
  notify(target.id, "pin_reset", "An admin reset your security PIN. Set a new one from your account page.", "/balance.html");
  sendEmail({
    to: target.email,
    subject: "Your security PIN was reset",
    html: layout(
      "PIN reset",
      `<p>An admin reset the security PIN on your account, at your request. Log in and set a new one — you'll just need your password this time.</p>
       <p>If you didn't request this, contact us immediately.</p>`
    ),
  });

  res.json({ ok: true });
});

// ---- KYC review --------------------------------------------------------

const listPendingKyc = db.prepare(`
  SELECT k.*, u.name AS user_name, u.email AS user_email
  FROM kyc_submissions k JOIN users u ON u.id = k.user_id
  WHERE k.status = 'pending'
  ORDER BY k.created_at ASC
`);
const getKycSubmission = db.prepare("SELECT * FROM kyc_submissions WHERE id = ?");
const setKycSubmissionStatus = db.prepare(`
  UPDATE kyc_submissions SET status = ?, rejection_reason = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?
`);
const setUserKycStatus = db.prepare("UPDATE users SET kyc_status = ? WHERE id = ?");

router.get("/kyc/pending", (req, res) => {
  res.json({ submissions: listPendingKyc.all() });
});

router.get("/kyc/:id/document", (req, res) => {
  const submission = getKycSubmission.get(req.params.id);
  if (!submission) return res.status(404).json({ error: "Submission not found." });
  res.sendFile(path.join(dataDir, submission.file_path));
});

router.post("/kyc/:id/approve", requirePermission("approve_kyc"), requirePin, (req, res) => {
  const submission = getKycSubmission.get(req.params.id);
  if (!submission) return res.status(404).json({ error: "Submission not found." });

  setKycSubmissionStatus.run("verified", null, req.user.id, submission.id);
  setUserKycStatus.run("verified", submission.user_id);

  const user = getUserById.get(submission.user_id);
  logAction(req.user.id, "kyc.approve", "kyc_submission", submission.id, { user_id: submission.user_id });
  notify(submission.user_id, "kyc_approved", "Your identity verification (KYC) was approved.", "/verify.html");
  if (user) {
    sendEmail({
      to: user.email,
      subject: "Your identity verification was approved",
      html: layout(
        "KYC verification approved",
        `<p>Good news — your identity verification document has been reviewed and approved. Withdrawals are now available on your account.</p>`
      ),
    });
  }

  res.json({ ok: true });
});

router.post("/kyc/:id/reject", requirePermission("approve_kyc"), requirePin, (req, res) => {
  const submission = getKycSubmission.get(req.params.id);
  if (!submission) return res.status(404).json({ error: "Submission not found." });

  const reason = req.body && req.body.reason ? String(req.body.reason).trim().slice(0, 1000) : null;
  setKycSubmissionStatus.run("rejected", reason, req.user.id, submission.id);
  setUserKycStatus.run("rejected", submission.user_id);

  const user = getUserById.get(submission.user_id);
  logAction(req.user.id, "kyc.reject", "kyc_submission", submission.id, { user_id: submission.user_id, reason });
  notify(
    submission.user_id,
    "kyc_rejected",
    reason
      ? `Your identity verification (KYC) was rejected: ${reason}. You can resubmit on the Verify page.`
      : "Your identity verification (KYC) was rejected. Please resubmit.",
    "/verify.html"
  );
  if (user) {
    sendEmail({
      to: user.email,
      subject: "Your identity verification needs another look",
      html: layout(
        "KYC verification rejected",
        `<p>Your identity verification document couldn't be approved.${reason ? ` Reason: <strong>${reason}</strong>.` : ""}</p>
         <p>Please log in and resubmit a clear photo or scan of a valid government-issued ID.</p>`
      ),
    });
  }

  res.json({ ok: true });
});

// ---- Investments & profit distribution ---------------------------------

const insertInvestment = db.prepare(`
  INSERT INTO investments (user_id, project, amount) VALUES (?, ?, ?)
`);
const getInvestment = db.prepare("SELECT * FROM investments WHERE id = ?");
const addProfit = db.prepare(`
  UPDATE investments SET profit_this_period = profit_this_period + ? WHERE id = ?
`);
const insertEarningsEvent = db.prepare(`
  INSERT INTO earnings_events (investment_id, user_id, amount) VALUES (?, ?, ?)
`);
const markInvestmentCompleted = db.prepare("UPDATE investments SET status = 'completed' WHERE id = ?");

router.post("/investments", (req, res) => {
  const { userId, project, amount } = req.body || {};
  if (!userId || !project || !(amount > 0)) {
    return res.status(400).json({ error: "userId, project, and a positive amount are required." });
  }
  const result = insertInvestment.run(userId, String(project).trim(), Number(amount));
  res.status(201).json({ investment: getInvestment.get(result.lastInsertRowid) });
});

router.post("/investments/:id/distribute-profit", (req, res) => {
  const { amount } = req.body || {};
  const investment = getInvestment.get(req.params.id);
  if (!investment) return res.status(404).json({ error: "Investment not found." });
  if (!(amount > 0)) return res.status(400).json({ error: "A positive amount is required." });

  addProfit.run(Number(amount), investment.id);
  insertEarningsEvent.run(investment.id, investment.user_id, Number(amount));
  res.json({ ok: true });
});

router.post("/investments/:id/complete", (req, res) => {
  const investment = getInvestment.get(req.params.id);
  if (!investment) return res.status(404).json({ error: "Investment not found." });
  markInvestmentCompleted.run(investment.id);
  res.json({ ok: true });
});

// ---- Withdrawal requests -------------------------------------------------

const listPendingWithdrawals = db.prepare(`
  SELECT w.*, u.name AS user_name, u.email AS user_email
  FROM withdrawal_requests w JOIN users u ON u.id = w.user_id
  WHERE w.status = 'pending'
  ORDER BY w.requested_at ASC
`);
const getWithdrawal = db.prepare("SELECT * FROM withdrawal_requests WHERE id = ?");
const setWithdrawalStatus = db.prepare(`
  UPDATE withdrawal_requests SET status = ?, rejection_reason = ?, processed_at = datetime('now'), processed_by = ? WHERE id = ?
`);
const addToTotalWithdrawn = db.prepare("UPDATE users SET total_withdrawn = total_withdrawn + ? WHERE id = ?");
const refundInvestmentProfit = db.prepare(`
  UPDATE investments SET profit_this_period = profit_this_period + ? WHERE id = ?
`);
const deductWalletBalance = db.prepare("UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ?");
const getUserById = db.prepare("SELECT * FROM users WHERE id = ?");

router.get("/withdrawals/pending", (req, res) => {
  res.json({ withdrawals: listPendingWithdrawals.all() });
});

router.post("/withdrawals/:id/approve", requirePermission("approve_withdrawals"), sensitiveActionLimiter, requirePin, (req, res) => {
  const w = getWithdrawal.get(req.params.id);
  if (!w) return res.status(404).json({ error: "Withdrawal request not found." });
  if (w.status !== "pending") return res.status(400).json({ error: "Already processed." });

  // Older, per-investment withdrawal requests (investment_id set) already
  // had their amount removed from the investment at request time under the
  // old design. General wallet withdrawals (investment_id null) haven't
  // touched the balance yet — deduct it now, at approval, with a fresh check
  // in case it changed since the request was made (e.g. another withdrawal
  // or investment got approved first).
  if (!w.investment_id) {
    const user = getUserById.get(w.user_id);
    if (!user || user.wallet_balance < w.amount) {
      return res.status(400).json({ error: "This user's balance is no longer sufficient for this withdrawal." });
    }
    deductWalletBalance.run(w.amount, w.user_id);
  }

  setWithdrawalStatus.run("paid", null, req.user.id, w.id);
  addToTotalWithdrawn.run(w.amount, w.user_id);

  logAction(req.user.id, "withdrawal.approve", "withdrawal_request", w.id, { user_id: w.user_id, amount: w.amount });
  notify(w.user_id, "withdrawal_approved", `Your withdrawal of $${w.amount} was approved and marked paid.`, "/balance.html");
  const payee = getUserById.get(w.user_id);
  if (payee) {
    sendEmail({
      to: payee.email,
      subject: "Your withdrawal has been paid",
      html: layout("Withdrawal approved", `<p>Your withdrawal request of <strong>$${w.amount}</strong> has been approved and marked as paid.</p>`),
    });
  }

  res.json({ ok: true, message: "Marked paid. Actually sending funds still has to happen outside this app." });
});

router.post("/withdrawals/:id/reject", requirePermission("approve_withdrawals"), sensitiveActionLimiter, requirePin, (req, res) => {
  const w = getWithdrawal.get(req.params.id);
  if (!w) return res.status(404).json({ error: "Withdrawal request not found." });
  if (w.status !== "pending") return res.status(400).json({ error: "Already processed." });

  const reason = req.body && req.body.reason ? String(req.body.reason).trim().slice(0, 1000) : null;
  setWithdrawalStatus.run("rejected", reason, req.user.id, w.id);
  if (w.investment_id) refundInvestmentProfit.run(w.amount, w.investment_id);

  logAction(req.user.id, "withdrawal.reject", "withdrawal_request", w.id, { user_id: w.user_id, amount: w.amount, reason });
  notify(
    w.user_id,
    "withdrawal_rejected",
    reason
      ? `Your withdrawal request of $${w.amount} was rejected: ${reason}. You can submit a new request from your Balance page.`
      : `Your withdrawal request of $${w.amount} was rejected.`,
    "/balance.html"
  );
  const payee = getUserById.get(w.user_id);
  if (payee) {
    sendEmail({
      to: payee.email,
      subject: "Your withdrawal request was rejected",
      html: layout(
        "Withdrawal rejected",
        `<p>Your withdrawal request of <strong>$${w.amount}</strong> was rejected.${reason ? ` Reason: <strong>${reason}</strong>.` : ""} Contact our team if you have questions, or submit a new request from your Balance page.</p>`
      ),
    });
  }

  res.json({ ok: true });
});

// ---- Referral redemptions -------------------------------------------------

const listPendingRedemptions = db.prepare(`
  SELECT r.*, u.name AS user_name, u.email AS user_email
  FROM referral_redemptions r JOIN users u ON u.id = r.user_id
  WHERE r.status = 'pending'
  ORDER BY r.requested_at ASC
`);
const getRedemption = db.prepare("SELECT * FROM referral_redemptions WHERE id = ?");
const setRedemptionStatus = db.prepare(`
  UPDATE referral_redemptions SET status = ?, rejection_reason = ?, processed_at = datetime('now'), processed_by = ? WHERE id = ?
`);

router.get("/referral-redemptions/pending", (req, res) => {
  res.json({ redemptions: listPendingRedemptions.all() });
});

router.post("/referral-redemptions/:id/approve", requirePermission("approve_redemptions"), sensitiveActionLimiter, requirePin, (req, res) => {
  const r = getRedemption.get(req.params.id);
  if (!r) return res.status(404).json({ error: "Redemption not found." });
  if (r.status !== "pending") return res.status(400).json({ error: "Already processed." });

  setRedemptionStatus.run("paid", null, req.user.id, r.id);

  logAction(req.user.id, "redemption.approve", "referral_redemption", r.id, { user_id: r.user_id, usdt_amount: r.usdt_amount });
  notify(r.user_id, "redemption_approved", `Your referral redemption of ${r.usdt_amount} USDT was approved and marked paid.`, "/referral.html");
  const user = getUserById.get(r.user_id);
  if (user) {
    sendEmail({
      to: user.email,
      subject: "Your referral redemption has been paid",
      html: layout("Redemption approved", `<p>Your referral redemption of <strong>${r.usdt_amount} USDT</strong> (${r.points} points) has been approved and marked as paid.</p>`),
    });
  }

  res.json({ ok: true, message: "Marked paid. Actually sending USDT still has to happen outside this app." });
});

router.post("/referral-redemptions/:id/reject", requirePermission("approve_redemptions"), sensitiveActionLimiter, requirePin, (req, res) => {
  const r = getRedemption.get(req.params.id);
  if (!r) return res.status(404).json({ error: "Redemption not found." });
  if (r.status !== "pending") return res.status(400).json({ error: "Already processed." });

  const reason = req.body && req.body.reason ? String(req.body.reason).trim().slice(0, 1000) : null;
  setRedemptionStatus.run("rejected", reason, req.user.id, r.id);

  logAction(req.user.id, "redemption.reject", "referral_redemption", r.id, { user_id: r.user_id, usdt_amount: r.usdt_amount, reason });
  notify(
    r.user_id,
    "redemption_rejected",
    reason
      ? `Your referral redemption of ${r.usdt_amount} USDT was rejected: ${reason}.`
      : `Your referral redemption of ${r.usdt_amount} USDT was rejected.`,
    "/referral.html"
  );
  const user = getUserById.get(r.user_id);
  if (user) {
    sendEmail({
      to: user.email,
      subject: "Your referral redemption was rejected",
      html: layout(
        "Redemption rejected",
        `<p>Your referral redemption of <strong>${r.usdt_amount} USDT</strong> was rejected.${reason ? ` Reason: <strong>${reason}</strong>.` : ""} Contact our team if you have questions.</p>`
      ),
    });
  }

  res.json({ ok: true });
});

// ---- Projects & investment requests --------------------------------------

const listProjectsAdmin = db.prepare(`
  SELECT p.*,
    (SELECT COALESCE(SUM(amount), 0) FROM investments WHERE project_id = p.id) AS raised,
    (SELECT COALESCE(SUM(amount), 0) FROM investment_requests WHERE project_id = p.id AND status = 'pending') AS reserved
  FROM projects p
  ORDER BY p.created_at DESC
`);
const insertProject = db.prepare(`
  INSERT INTO projects (title, description, target_amount, start_date, end_date, created_by)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const getProject = db.prepare("SELECT * FROM projects WHERE id = ?");
const updateProjectFields = db.prepare(`
  UPDATE projects SET
    title = @title, description = @description, target_amount = @target_amount,
    start_date = @start_date, end_date = @end_date, status = @status,
    updated_at = datetime('now')
  WHERE id = @id
`);

router.get("/projects", (req, res) => {
  res.json({ projects: listProjectsAdmin.all() });
});

router.post("/projects", requirePermission("manage_projects"), (req, res) => {
  const { title, description, targetAmount, startDate, endDate } = req.body || {};
  if (!title || !targetAmount || !startDate || !endDate) {
    return res.status(400).json({ error: "title, targetAmount, startDate, and endDate are required." });
  }
  if (!(targetAmount > 0)) {
    return res.status(400).json({ error: "targetAmount must be a positive number." });
  }
  if (String(endDate) < String(startDate)) {
    return res.status(400).json({ error: "End date must be after the start date." });
  }

  const result = insertProject.run(
    String(title).trim(),
    String(description || "").trim(),
    Number(targetAmount),
    startDate,
    endDate,
    req.user.id
  );
  res.status(201).json({ project: getProject.get(result.lastInsertRowid) });
});

// Also used to extend/shorten the end date, edit details, or open/close a
// project — send only the fields you want to change.
router.patch("/projects/:id", requirePermission("manage_projects"), (req, res) => {
  const existing = getProject.get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Project not found." });

  const { title, description, targetAmount, startDate, endDate, status } = req.body || {};
  const next = {
    id: existing.id,
    title: title !== undefined ? String(title).trim() : existing.title,
    description: description !== undefined ? String(description).trim() : existing.description,
    target_amount: targetAmount !== undefined ? Number(targetAmount) : existing.target_amount,
    start_date: startDate || existing.start_date,
    end_date: endDate || existing.end_date,
    status: status || existing.status,
  };

  if (!(next.target_amount > 0)) {
    return res.status(400).json({ error: "targetAmount must be a positive number." });
  }
  if (String(next.end_date) < String(next.start_date)) {
    return res.status(400).json({ error: "End date must be after the start date." });
  }
  if (next.status !== "open" && next.status !== "closed") {
    return res.status(400).json({ error: "status must be 'open' or 'closed'." });
  }

  updateProjectFields.run(next);
  res.json({ project: getProject.get(existing.id) });
});

const listPendingInvestmentRequests = db.prepare(`
  SELECT ir.*, u.name AS user_name, u.email AS user_email, u.kyc_status, u.wallet_balance,
         p.title AS project_title
  FROM investment_requests ir
  JOIN users u ON u.id = ir.user_id
  JOIN projects p ON p.id = ir.project_id
  WHERE ir.status = 'pending'
  ORDER BY ir.requested_at ASC
`);
const getInvestmentRequest = db.prepare("SELECT * FROM investment_requests WHERE id = ?");
const setInvestmentRequestStatus = db.prepare(`
  UPDATE investment_requests SET status = ?, rejection_reason = ?, processed_at = datetime('now'), processed_by = ? WHERE id = ?
`);
const insertInvestmentFromRequest = db.prepare(`
  INSERT INTO investments (user_id, project, project_id, amount) VALUES (?, ?, ?, ?)
`);

router.get("/investment-requests/pending", (req, res) => {
  res.json({ requests: listPendingInvestmentRequests.all() });
});

router.get("/investment-requests/:id/proof", (req, res) => {
  const request = getInvestmentRequest.get(req.params.id);
  if (!request || !request.proof_file_path) return res.status(404).json({ error: "Proof not found." });
  res.sendFile(path.join(dataDir, request.proof_file_path));
});

router.post("/investment-requests/:id/approve", requirePermission("approve_investments"), sensitiveActionLimiter, requirePin, (req, res) => {
  const request = getInvestmentRequest.get(req.params.id);
  if (!request) return res.status(404).json({ error: "Investment request not found." });
  if (request.status !== "pending") return res.status(400).json({ error: "Already processed." });

  // Re-check the user's balance at approval time — it was only "reserved" at
  // request time, not yet deducted, so it can have genuinely changed since
  // (e.g. a different pending request for the same user got approved first).
  const user = getUserById.get(request.user_id);
  if (!user || user.wallet_balance < request.amount) {
    return res.status(400).json({ error: "This user's balance is no longer sufficient for this request." });
  }

  const project = getProject.get(request.project_id);
  deductWalletBalance.run(request.amount, request.user_id);
  setInvestmentRequestStatus.run("approved", null, req.user.id, request.id);
  insertInvestmentFromRequest.run(
    request.user_id,
    project ? project.title : "Investment",
    request.project_id,
    request.amount
  );

  logAction(req.user.id, "investment_request.approve", "investment_request", request.id, {
    user_id: request.user_id, amount: request.amount, project_id: request.project_id,
  });
  notify(
    request.user_id,
    "investment_approved",
    `Your investment of $${request.amount} in ${project ? project.title : "a project"} was approved.`,
    "/balance.html"
  );
  sendEmail({
    to: user.email,
    subject: "Your investment request was approved",
    html: layout(
      "Investment approved",
      `<p>Your investment of <strong>$${request.amount}</strong> in <strong>${project ? project.title : "a project"}</strong> has been approved and added to your account.</p>`
    ),
  });

  res.json({ ok: true });
});

router.post("/investment-requests/:id/reject", requirePermission("approve_investments"), sensitiveActionLimiter, requirePin, (req, res) => {
  const request = getInvestmentRequest.get(req.params.id);
  if (!request) return res.status(404).json({ error: "Investment request not found." });
  if (request.status !== "pending") return res.status(400).json({ error: "Already processed." });

  const reason = req.body && req.body.reason ? String(req.body.reason).trim().slice(0, 1000) : null;
  setInvestmentRequestStatus.run("rejected", reason, req.user.id, request.id);

  const project = getProject.get(request.project_id);
  const user = getUserById.get(request.user_id);
  logAction(req.user.id, "investment_request.reject", "investment_request", request.id, {
    user_id: request.user_id, amount: request.amount, project_id: request.project_id, reason,
  });
  notify(
    request.user_id,
    "investment_rejected",
    reason
      ? `Your investment request of $${request.amount} was rejected: ${reason}.`
      : `Your investment request of $${request.amount} was rejected.`,
    "/invest.html"
  );
  if (user) {
    sendEmail({
      to: user.email,
      subject: "Your investment request was rejected",
      html: layout(
        "Investment rejected",
        `<p>Your investment request of <strong>$${request.amount}</strong>${project ? ` in <strong>${project.title}</strong>` : ""} was rejected.${reason ? ` Reason: <strong>${reason}</strong>.` : ""} The reserved amount is available in your balance again.</p>`
      ),
    });
  }

  res.json({ ok: true });
});

// ---- Deposits --------------------------------------------------------------

const listPendingDeposits = db.prepare(`
  SELECT d.*, u.name AS user_name, u.email AS user_email
  FROM deposit_requests d
  JOIN users u ON u.id = d.user_id
  WHERE d.status = 'pending'
  ORDER BY d.requested_at ASC
`);
const getDeposit = db.prepare("SELECT * FROM deposit_requests WHERE id = ?");
const setDepositStatus = db.prepare(`
  UPDATE deposit_requests SET status = ?, rejection_reason = ?, processed_at = datetime('now'), processed_by = ? WHERE id = ?
`);
const addToWalletBalance = db.prepare("UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?");

router.get("/deposits/pending", (req, res) => {
  res.json({ deposits: listPendingDeposits.all() });
});

router.get("/deposits/:id/proof", (req, res) => {
  const deposit = getDeposit.get(req.params.id);
  if (!deposit || !deposit.proof_file_path) return res.status(404).json({ error: "Proof not found." });
  res.sendFile(path.join(dataDir, deposit.proof_file_path));
});

router.post("/deposits/:id/approve", requirePermission("approve_deposits"), sensitiveActionLimiter, requirePin, (req, res) => {
  const deposit = getDeposit.get(req.params.id);
  if (!deposit) return res.status(404).json({ error: "Deposit request not found." });
  if (deposit.status !== "pending") return res.status(400).json({ error: "Already processed." });

  setDepositStatus.run("approved", null, req.user.id, deposit.id);
  addToWalletBalance.run(deposit.amount, deposit.user_id);

  logAction(req.user.id, "deposit.approve", "deposit_request", deposit.id, { user_id: deposit.user_id, amount: deposit.amount });
  notify(deposit.user_id, "deposit_approved", `Your deposit of $${deposit.amount} was approved and added to your balance.`, "/balance.html");
  const user = getUserById.get(deposit.user_id);
  if (user) {
    sendEmail({
      to: user.email,
      subject: "Your deposit has been approved",
      html: layout("Deposit approved", `<p>Your deposit of <strong>$${deposit.amount}</strong> has been approved and added to your wallet balance.</p>`),
    });
  }

  res.json({ ok: true });
});

router.post("/deposits/:id/reject", requirePermission("approve_deposits"), sensitiveActionLimiter, requirePin, (req, res) => {
  const deposit = getDeposit.get(req.params.id);
  if (!deposit) return res.status(404).json({ error: "Deposit request not found." });
  if (deposit.status !== "pending") return res.status(400).json({ error: "Already processed." });

  const reason = req.body && req.body.reason ? String(req.body.reason).trim().slice(0, 1000) : null;
  setDepositStatus.run("rejected", reason, req.user.id, deposit.id);

  logAction(req.user.id, "deposit.reject", "deposit_request", deposit.id, { user_id: deposit.user_id, amount: deposit.amount, reason });
  notify(
    deposit.user_id,
    "deposit_rejected",
    reason
      ? `Your deposit of $${deposit.amount} was rejected: ${reason}. You can submit a new deposit from your Balance page.`
      : `Your deposit of $${deposit.amount} was rejected.`,
    "/balance.html"
  );
  const user = getUserById.get(deposit.user_id);
  if (user) {
    sendEmail({
      to: user.email,
      subject: "Your deposit was rejected",
      html: layout(
        "Deposit rejected",
        `<p>Your deposit of <strong>$${deposit.amount}</strong> was rejected.${reason ? ` Reason: <strong>${reason}</strong>.` : ""} Please check your payment proof and transaction ID, then try again.</p>`
      ),
    });
  }

  res.json({ ok: true });
});

// ---- Full site backup / restore ------------------------------------------

const backupUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB — this bundles the DB + every uploaded file
  fileFilter: (req, file, cb) => {
    const okMime = ["application/zip", "application/x-zip-compressed", "application/octet-stream"];
    if (!okMime.includes(file.mimetype) && !file.originalname.toLowerCase().endsWith(".zip")) {
      return cb(new Error("Upload a .zip backup file."));
    }
    cb(null, true);
  },
});

router.get("/backup", requireRole(), (req, res) => {
  const buffer = createBackupZip(db);
  const dateStamp = new Date().toISOString().slice(0, 10);
  logAction(req.user.id, "backup.download", "site", null);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="halal-income-backup-${dateStamp}.zip"`);
  res.send(buffer);
});

// Restoring replaces every user's data at once — reserved for super_admin
// specifically (requireRole() with no args still lets super_admin through,
// but no other role), unlike the finance/kyc actions above.
router.post("/restore", requireRole(), (req, res) => {
  backupUpload.single("backup")(req, res, (uploadErr) => {
    if (uploadErr) return res.status(400).json({ error: uploadErr.message });
    if (!req.file) return res.status(400).json({ error: "A .zip backup file is required." });

    let result;
    try {
      result = restoreFromZip(db, req.file.buffer);
    } catch (err) {
      // Nothing live was touched if this throws before the "point of no
      // return" inside restoreFromZip — safe to just report the error.
      return res.status(400).json({ error: err.message });
    }

    // NOTE: can't use logAction() here — restoreFromZip() already closed the
    // live `db` handle as its last step (see backend/src/lib/backup.js), and
    // the database file on disk has already been swapped for the restored
    // one anyway, so an audit row written now wouldn't land anywhere
    // meaningful. Console line is the honest record for this one action.
    console.log(`[admin] Restore performed by admin #${req.user.id}. Safety backup: ${result.safetyBackupPath}`);

    res.json({
      ok: true,
      message:
        "Restore complete. A backup of your previous data was saved to backend/data/pre-restore-backups/ first, just in case. " +
        "The server is stopping now — start it again (npm start) to load the restored data.",
      safetyBackupPath: result.safetyBackupPath,
    });

    // The live db handle is now closed (restoreFromZip's last step), and
    // every other route module still holds its own reference to that closed
    // handle — there is no clean in-process way to pick up the restored
    // file. Exiting is the honest signal that a restart is required; let the
    // response above flush to the client first.
    setTimeout(() => process.exit(0), 200);
  });
});

// ---- Analytics dashboard ---------------------------------------------------
// A bird's-eye view of the platform: how much money is in it, how it's moved
// over the last 6 months, and how each project is filling up. All read-only
// aggregates — no route params, so no risk of leaking a specific user's data
// beyond what the per-section tables below already show.

const analyticsTotals = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM users) AS total_users,
    (SELECT COALESCE(SUM(wallet_balance), 0) FROM users) AS total_wallet_balance,
    (SELECT COALESCE(SUM(amount), 0) FROM investments) AS total_invested,
    (SELECT COALESCE(SUM(total_withdrawn), 0) FROM users) AS total_withdrawn,
    (SELECT COALESCE(SUM(amount), 0) FROM deposit_requests WHERE status = 'approved') AS total_deposited
`);
const analyticsPendingCounts = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM kyc_submissions WHERE status = 'pending') AS kyc,
    (SELECT COUNT(*) FROM deposit_requests WHERE status = 'pending') AS deposits,
    (SELECT COUNT(*) FROM withdrawal_requests WHERE status = 'pending') AS withdrawals,
    (SELECT COUNT(*) FROM investment_requests WHERE status = 'pending') AS investment_requests,
    (SELECT COUNT(*) FROM referral_redemptions WHERE status = 'pending') AS redemptions
`);
// Last 6 calendar months (including the current one), oldest first.
const monthlyDeposits = db.prepare(`
  SELECT strftime('%Y-%m', requested_at) AS month, COALESCE(SUM(amount), 0) AS total
  FROM deposit_requests WHERE status = 'approved' GROUP BY month
`);
const monthlyWithdrawals = db.prepare(`
  SELECT strftime('%Y-%m', requested_at) AS month, COALESCE(SUM(amount), 0) AS total
  FROM withdrawal_requests WHERE status = 'paid' GROUP BY month
`);
const projectFunding = db.prepare(`
  SELECT p.id, p.title, p.target_amount, p.status,
    (SELECT COALESCE(SUM(amount), 0) FROM investments WHERE project_id = p.id) AS raised
  FROM projects p ORDER BY p.created_at DESC
`);

router.get("/analytics", (req, res) => {
  const totals = analyticsTotals.get();
  const pending = analyticsPendingCounts.get();

  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  const depositsByMonth = Object.fromEntries(monthlyDeposits.all().map((r) => [r.month, r.total]));
  const withdrawalsByMonth = Object.fromEntries(monthlyWithdrawals.all().map((r) => [r.month, r.total]));
  const monthly = months.map((month) => ({
    month,
    deposits: depositsByMonth[month] || 0,
    withdrawals: withdrawalsByMonth[month] || 0,
  }));

  const projects = projectFunding.all().map((p) => ({
    ...p,
    percent: p.target_amount > 0 ? Math.min(100, Math.round((p.raised / p.target_amount) * 100)) : 0,
  }));

  res.json({ totals, pending, monthly, projects });
});

// ---- Audit log -------------------------------------------------------------
// Read-only trail of every money-moving or account-changing admin action.
// super_admin only — a lower-privileged admin reviewing what other admins
// did isn't the intent of this feature.

const countAuditLog = db.prepare("SELECT COUNT(*) AS total FROM audit_log");
const pageAuditLog = db.prepare(`
  SELECT a.*, u.name AS admin_name, u.email AS admin_email
  FROM audit_log a LEFT JOIN users u ON u.id = a.admin_id
  ORDER BY a.id DESC LIMIT ? OFFSET ?
`);

router.get("/audit-log", requireRole(), (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
  const total = countAuditLog.get().total;
  const entries = pageAuditLog.all(pageSize, (page - 1) * pageSize).map((e) => ({
    ...e,
    details: e.details ? JSON.parse(e.details) : null,
  }));
  res.json({ entries, total, page, pageSize });
});

// ---- Data exports (Excel / PDF) -----------------------------------------

const EXPORTS = {
  kyc: {
    title: "KYC Submissions",
    query: db.prepare(`
      SELECT k.id, u.name AS user_name, u.email AS user_email, k.original_name,
             k.status, k.created_at, k.reviewed_at
      FROM kyc_submissions k JOIN users u ON u.id = k.user_id
      ORDER BY k.created_at DESC
    `),
    columns: [
      { header: "ID", key: "id", width: 8 },
      { header: "Name", key: "user_name", width: 22 },
      { header: "Email", key: "user_email", width: 28 },
      { header: "Document", key: "original_name", width: 22 },
      { header: "Status", key: "status", width: 14 },
      { header: "Submitted", key: "created_at", width: 20 },
      { header: "Reviewed", key: "reviewed_at", width: 20 },
    ],
  },
  withdrawals: {
    title: "Withdrawal Requests",
    query: db.prepare(`
      SELECT w.id, u.name AS user_name, u.email AS user_email, w.amount,
             w.status, w.requested_at, w.processed_at
      FROM withdrawal_requests w JOIN users u ON u.id = w.user_id
      ORDER BY w.requested_at DESC
    `),
    columns: [
      { header: "ID", key: "id", width: 8 },
      { header: "Name", key: "user_name", width: 22 },
      { header: "Email", key: "user_email", width: 28 },
      { header: "Amount", key: "amount", width: 14 },
      { header: "Status", key: "status", width: 14 },
      { header: "Requested", key: "requested_at", width: 20 },
      { header: "Processed", key: "processed_at", width: 20 },
    ],
  },
  redemptions: {
    title: "Referral Redemptions",
    query: db.prepare(`
      SELECT r.id, u.name AS user_name, u.email AS user_email, r.points,
             r.usdt_amount, r.status, r.requested_at, r.processed_at
      FROM referral_redemptions r JOIN users u ON u.id = r.user_id
      ORDER BY r.requested_at DESC
    `),
    columns: [
      { header: "ID", key: "id", width: 8 },
      { header: "Name", key: "user_name", width: 22 },
      { header: "Email", key: "user_email", width: 28 },
      { header: "Points", key: "points", width: 10 },
      { header: "USDT", key: "usdt_amount", width: 12 },
      { header: "Status", key: "status", width: 14 },
      { header: "Requested", key: "requested_at", width: 20 },
      { header: "Processed", key: "processed_at", width: 20 },
    ],
  },
  users: {
    title: "Users",
    query: listUsers,
    columns: [
      { header: "ID", key: "id", width: 8 },
      { header: "Name", key: "name", width: 22 },
      { header: "Email", key: "email", width: 28 },
      { header: "Phone", key: "phone", width: 18 },
      { header: "Admin", key: "is_admin", width: 10 },
      { header: "Email Verified", key: "email_verified", width: 14 },
      { header: "KYC Status", key: "kyc_status", width: 14 },
      { header: "Referral Code", key: "referral_code", width: 16 },
      { header: "Wallet Balance", key: "wallet_balance", width: 16 },
      { header: "Total Withdrawn", key: "total_withdrawn", width: 16 },
      { header: "Joined", key: "created_at", width: 20 },
    ],
  },
  deposits: {
    title: "Deposit Requests",
    query: db.prepare(`
      SELECT d.id, u.name AS user_name, u.email AS user_email,
             d.amount, d.payment_method, d.transaction_id, d.status, d.requested_at, d.processed_at
      FROM deposit_requests d
      JOIN users u ON u.id = d.user_id
      ORDER BY d.requested_at DESC
    `),
    columns: [
      { header: "ID", key: "id", width: 8 },
      { header: "Name", key: "user_name", width: 22 },
      { header: "Email", key: "user_email", width: 28 },
      { header: "Amount", key: "amount", width: 14 },
      { header: "Payment Method", key: "payment_method", width: 18 },
      { header: "Transaction ID", key: "transaction_id", width: 24 },
      { header: "Status", key: "status", width: 14 },
      { header: "Requested", key: "requested_at", width: 20 },
      { header: "Processed", key: "processed_at", width: 20 },
    ],
  },
  projects: {
    title: "Projects",
    query: db.prepare(`
      SELECT p.id, p.title, p.target_amount, COALESCE(SUM(i.amount), 0) AS raised,
             p.start_date, p.end_date, p.status, p.created_at
      FROM projects p
      LEFT JOIN investments i ON i.project_id = p.id
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `),
    columns: [
      { header: "ID", key: "id", width: 8 },
      { header: "Title", key: "title", width: 26 },
      { header: "Target", key: "target_amount", width: 14 },
      { header: "Raised", key: "raised", width: 14 },
      { header: "Start Date", key: "start_date", width: 14 },
      { header: "End Date", key: "end_date", width: 14 },
      { header: "Status", key: "status", width: 12 },
      { header: "Created", key: "created_at", width: 20 },
    ],
  },
  "investment-requests": {
    title: "Investment Requests",
    query: db.prepare(`
      SELECT ir.id, u.name AS user_name, u.email AS user_email, p.title AS project_title,
             ir.amount, ir.payment_method, ir.transaction_id, ir.status, ir.requested_at, ir.processed_at
      FROM investment_requests ir
      JOIN users u ON u.id = ir.user_id
      JOIN projects p ON p.id = ir.project_id
      ORDER BY ir.requested_at DESC
    `),
    columns: [
      { header: "ID", key: "id", width: 8 },
      { header: "Name", key: "user_name", width: 22 },
      { header: "Email", key: "user_email", width: 28 },
      { header: "Project", key: "project_title", width: 26 },
      { header: "Amount", key: "amount", width: 14 },
      { header: "Payment Method", key: "payment_method", width: 18 },
      { header: "Transaction ID", key: "transaction_id", width: 24 },
      { header: "Status", key: "status", width: 14 },
      { header: "Requested", key: "requested_at", width: 20 },
      { header: "Processed", key: "processed_at", width: 20 },
    ],
  },
};

router.get("/export/:section/:format", async (req, res) => {
  const section = EXPORTS[req.params.section];
  if (!section) return res.status(404).json({ error: "Unknown export section." });

  const rows = section.query.all();
  const dateStamp = new Date().toISOString().slice(0, 10);
  const baseName = `halal-income-${req.params.section}-${dateStamp}`;

  try {
    if (req.params.format === "xlsx") {
      await sendXlsx(res, `${baseName}.xlsx`, section.title, section.columns, rows);
    } else if (req.params.format === "pdf") {
      sendPdf(res, `${baseName}.pdf`, section.title, section.columns, rows);
    } else {
      res.status(400).json({ error: "Format must be xlsx or pdf." });
    }
  } catch (err) {
    console.error(`[admin] Export failed for ${req.params.section}/${req.params.format}:`, err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to generate export." });
  }
});

module.exports = router;
