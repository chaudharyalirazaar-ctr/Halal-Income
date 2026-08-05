const express = require("express");
const { db } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const POINTS_PER_INVESTED_REFERRAL = 50;
const POINTS_PER_USDT = 10; // redemption rate — adjust to match the real business rule

const getReferredUsers = db.prepare(`
  SELECT id, name, created_at,
    EXISTS(SELECT 1 FROM investments WHERE investments.user_id = users.id) AS has_invested
  FROM users WHERE referred_by = ?
  ORDER BY created_at DESC
`);
const getRedeemedPoints = db.prepare(`
  SELECT COALESCE(SUM(points), 0) AS total FROM referral_redemptions
  WHERE user_id = ? AND status != 'rejected'
`);
const insertRedemption = db.prepare(`
  INSERT INTO referral_redemptions (user_id, points, usdt_amount) VALUES (?, ?, ?)
`);

function computeReferralSummary(userId) {
  const referred = getReferredUsers.all(userId);
  const rows = referred.map((r) => ({
    name: r.name,
    status: r.has_invested ? "Invested — first investment made" : "Registered — not yet invested",
    points: r.has_invested ? POINTS_PER_INVESTED_REFERRAL : 0,
  }));
  const totalPoints = rows.reduce((sum, r) => sum + r.points, 0);
  const redeemedPoints = getRedeemedPoints.get(userId).total;
  const availablePoints = Math.max(0, totalPoints - redeemedPoints);
  return { rows, count: referred.length, availablePoints };
}

router.get("/", requireAuth, (req, res) => {
  const { rows, count, availablePoints } = computeReferralSummary(req.user.id);
  const referralLink = `${req.protocol}://${req.get("host")}/signup.html?ref=${req.user.referral_code}`;

  res.json({
    referralCode: req.user.referral_code,
    referralLink,
    referrals: rows,
    count,
    points: availablePoints,
    usdt: (availablePoints / POINTS_PER_USDT).toFixed(2),
  });
});

// Ranked by lifetime invested-referral count (not "available" points), so
// redeeming your points doesn't cost you your leaderboard rank.
const leaderboardQuery = db.prepare(`
  SELECT u.id, u.name,
    (SELECT COUNT(*) FROM users r WHERE r.referred_by = u.id
       AND EXISTS(SELECT 1 FROM investments WHERE investments.user_id = r.id)) AS invited_investors
  FROM users u
  ORDER BY invited_investors DESC
  LIMIT 25
`);

// Shows "First L." rather than a full name — enough to feel personal on a
// public-ish leaderboard without exposing a referrer's full identity.
function anonymizeName(name) {
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

router.get("/leaderboard", requireAuth, (req, res) => {
  const top = leaderboardQuery.all().filter((r) => r.invited_investors > 0).slice(0, 10);
  const leaderboard = top.map((r, i) => ({
    rank: i + 1,
    name: anonymizeName(r.name),
    invitedInvestors: r.invited_investors,
    points: r.invited_investors * POINTS_PER_INVESTED_REFERRAL,
    isYou: r.id === req.user.id,
  }));
  res.json({ leaderboard });
});

router.post("/redeem", requireAuth, (req, res) => {
  const { availablePoints } = computeReferralSummary(req.user.id);
  if (availablePoints <= 0) {
    return res.status(400).json({ error: "No points available to redeem." });
  }

  const usdtAmount = availablePoints / POINTS_PER_USDT;
  insertRedemption.run(req.user.id, availablePoints, usdtAmount);

  res.status(201).json({
    ok: true,
    message: "Redemption request submitted. It will be reviewed and paid out by an administrator — no funds have moved automatically.",
    points: availablePoints,
    usdtAmount,
  });
});

module.exports = router;
