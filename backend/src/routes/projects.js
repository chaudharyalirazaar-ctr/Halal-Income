const express = require("express");
const rateLimit = require("express-rate-limit");
const { db } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { availableBalance } = require("../lib/wallet");

const router = express.Router();

const investLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `user:${req.user.id}` : req.ip),
  message: { error: "Too many investment requests. Please wait a while before trying again." },
});

// Correlated subqueries (not a JOIN) so raised/reserved don't fan out and
// double-count when a project has many investments or requests.
const PROJECT_SELECT = `
  SELECT p.*,
    (SELECT COALESCE(SUM(amount), 0) FROM investments WHERE project_id = p.id) AS raised,
    (SELECT COALESCE(SUM(amount), 0) FROM investment_requests WHERE project_id = p.id AND status = 'pending') AS reserved
  FROM projects p
`;
const listProjectsWithRaised = db.prepare(`${PROJECT_SELECT} ORDER BY p.created_at DESC`);
const getProjectWithRaised = db.prepare(`${PROJECT_SELECT} WHERE p.id = ?`);
const insertInvestmentRequest = db.prepare(`
  INSERT INTO investment_requests (user_id, project_id, amount) VALUES (?, ?, ?)
`);

function withComputedFields(project) {
  const today = new Date().toISOString().slice(0, 10);
  // Reservation locking: an amount tied up in someone else's pending request
  // is not available to invest again until that request is approved or
  // rejected — prevents two people both "claiming" the last slot on a project.
  const remaining = Math.max(0, project.target_amount - project.raised - project.reserved);
  const percent = project.target_amount > 0
    ? Math.min(100, Math.round((project.raised / project.target_amount) * 100))
    : 0;
  const isOpen = project.status === "open" && today <= project.end_date && remaining > 0;

  return { ...project, remaining, percent, isOpen, today };
}

router.get("/", (req, res) => {
  const projects = listProjectsWithRaised.all().map(withComputedFields);
  res.json({ projects });
});

router.get("/:id", (req, res) => {
  const project = getProjectWithRaised.get(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found." });
  res.json({ project: withComputedFields(project) });
});

// Investing draws from the user's wallet balance (funded by admin-approved
// deposits — see wallet.js) rather than needing its own payment proof. The
// request still goes to admin for approval before it becomes a real
// investment; only the wallet-balance check happens here.
router.post("/:id/invest", requireAuth, investLimiter, (req, res) => {
  const project = getProjectWithRaised.get(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found." });

  const { amount } = req.body || {};
  if (!(amount > 0)) {
    return res.status(400).json({ error: "Enter a positive investment amount." });
  }

  const computed = withComputedFields(project);
  if (!computed.isOpen) {
    return res.status(400).json({ error: "This project is not currently open for investment." });
  }
  if (Number(amount) > computed.remaining) {
    return res.status(400).json({
      error: `Only $${computed.remaining.toLocaleString()} is currently available on this project (some may be reserved by other pending requests).`,
    });
  }

  const available = availableBalance(req.user);
  if (Number(amount) > available) {
    return res.status(400).json({
      error: `Only $${available.toLocaleString()} of your balance is currently available. Deposit more funds or reduce the amount.`,
    });
  }

  insertInvestmentRequest.run(req.user.id, project.id, Number(amount));
  res.status(201).json({
    ok: true,
    message: "Investment request submitted from your balance. Our team will review and confirm it — no funds are deducted until approved.",
  });
});

module.exports = router;
