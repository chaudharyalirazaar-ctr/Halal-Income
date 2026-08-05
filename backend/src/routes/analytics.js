const express = require("express");
const { db } = require("../db");
const { requireAdmin } = require("../middleware/auth");

const router = express.Router();

const registrationsByDay = db.prepare(`
  SELECT date(created_at) AS d, COUNT(*) AS c FROM users GROUP BY d
`);
const newInvestorsByDay = db.prepare(`
  SELECT date(first_dt) AS d, COUNT(*) AS c FROM (
    SELECT user_id, MIN(created_at) AS first_dt FROM investments GROUP BY user_id
  ) GROUP BY d
`);
const earnedByDay = db.prepare(`
  SELECT event_date AS d, SUM(amount) AS c FROM earnings_events GROUP BY d
`);

function toDateOnly(d) {
  return d.toISOString().slice(0, 10);
}

router.get("/", requireAdmin, (req, res) => {
  const regRows = registrationsByDay.all();
  const invRows = newInvestorsByDay.all();
  const earnRows = earnedByDay.all();

  const regMap = new Map(regRows.map((r) => [r.d, r.c]));
  const invMap = new Map(invRows.map((r) => [r.d, r.c]));
  const earnMap = new Map(earnRows.map((r) => [r.d, r.c]));

  const allDates = [...regMap.keys(), ...invMap.keys(), ...earnMap.keys()];
  const today = toDateOnly(new Date());

  let earliest = allDates.length ? allDates.reduce((a, b) => (a < b ? a : b)) : today;
  let latest = allDates.length ? allDates.reduce((a, b) => (a > b ? a : b)) : today;
  if (latest < today) latest = today;

  const from = (req.query.from && String(req.query.from)) || earliest;
  const to = (req.query.to && String(req.query.to)) || latest;

  const rows = [];
  const cursor = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  const MAX_DAYS = 3660; // 10 years — safety cap against absurd from/to query params
  let guard = 0;
  while (cursor <= end && guard++ < MAX_DAYS) {
    const d = toDateOnly(cursor);
    rows.push({
      date: d,
      registrations: regMap.get(d) || 0,
      invested: invMap.get(d) || 0,
      earned: Math.round(earnMap.get(d) || 0),
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  res.json({ from, to, earliest, latest: today, rows });
});

module.exports = router;
