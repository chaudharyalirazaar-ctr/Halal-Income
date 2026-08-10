// Nudges admins when an open project with active investments hasn't had
// profit distributed in a while — now that bulk distribution exists (see
// POST /api/admin/projects/:id/distribute-profit-bulk), nothing previously
// prompted anyone that a period was actually due. No specific cadence was
// specified; 30 days is a reasonable default given the site's own "typically
// 6-8% monthly" language elsewhere, and easy to change in one place.
const { db } = require("../db");
const { alertAdmins } = require("./adminAlerts");

const REMINDER_INTERVAL_DAYS = 30;

// Looks at both distribution paths — the original one-investment-at-a-time
// route (audit target_type 'investment', so needs a join back through
// investments to find its project) and the newer bulk route (audit target_type
// 'project' directly) — and takes whichever is more recent per project.
const findCandidateProjects = db.prepare(`
  SELECT p.id, p.title, p.created_at, p.profit_reminder_sent_at,
    (SELECT MAX(created_at) FROM audit_log
       WHERE action = 'investment.distribute_profit_bulk' AND target_type = 'project' AND target_id = p.id) AS last_bulk,
    (SELECT MAX(al.created_at) FROM audit_log al JOIN investments i ON i.id = al.target_id
       WHERE al.action = 'investment.distribute_profit' AND al.target_type = 'investment' AND i.project_id = p.id) AS last_single
  FROM projects p
  WHERE p.status = 'open'
    AND EXISTS (SELECT 1 FROM investments WHERE project_id = p.id AND status = 'active')
`);
const markReminderSent = db.prepare("UPDATE projects SET profit_reminder_sent_at = datetime('now') WHERE id = ?");

function daysSince(sqliteTimestamp) {
  const then = new Date(sqliteTimestamp.replace(" ", "T") + "Z").getTime();
  return (Date.now() - then) / (24 * 60 * 60 * 1000);
}

async function runProfitDistributionReminders() {
  const overdue = findCandidateProjects
    .all()
    .map((p) => {
      const lastDistributed = [p.last_bulk, p.last_single].filter(Boolean).sort().pop() || null;
      const sinceReference = lastDistributed || p.created_at;
      return { ...p, lastDistributed, daysSinceDistribution: daysSince(sinceReference) };
    })
    .filter((p) => {
      if (p.daysSinceDistribution < REMINDER_INTERVAL_DAYS) return false;
      // Already reminded recently about this same project — don't re-nag
      // more often than the same interval.
      if (p.profit_reminder_sent_at && daysSince(p.profit_reminder_sent_at) < REMINDER_INTERVAL_DAYS) return false;
      return true;
    });

  if (!overdue.length) return;

  overdue.forEach((p) => markReminderSent.run(p.id));

  const listHtml = overdue
    .map((p) => `<li>${p.title} — last distributed ${p.lastDistributed || "never"}</li>`)
    .join("");

  alertAdmins({
    type: "profit_distribution_reminder",
    message: `${overdue.length} open project(s) may be due for a profit distribution: ${overdue.map((p) => p.title).join(", ")}.`,
    link: "/admin.html",
    emailSubject: "Time to distribute profit?",
    emailHtml: `<p>These open projects have active investments and haven't had profit distributed in over ${REMINDER_INTERVAL_DAYS} days:</p>
       <ul>${listHtml}</ul>
       <p>If this period's profit is ready, use the admin panel's "Bulk distribute profit (by project)" section — no action needed if it isn't yet.</p>`,
  });

  console.log(`[profit-reminders] Nudged admins about ${overdue.length} overdue project(s).`);
}

module.exports = { runProfitDistributionReminders };
