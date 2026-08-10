// Nudges a user to re-verify their identity once their existing KYC has
// been sitting on file for a while — nothing regulatory is encoded here
// (no re-verification requirement was specified), just a reasonable
// default that's easy to change in one place.
const { db } = require("../db");
const { notify } = require("./notifications");
const { sendEmail, layout } = require("./mailer");
const { alertAdmins } = require("./adminAlerts");

const REVERIFICATION_MONTHS = 12;
const REMINDER_COOLDOWN_DAYS = 30; // don't re-nag more than about once a month

// A user qualifies once their most recent *verified* submission is older
// than the threshold AND they haven't already been reminded within the
// cooldown window (kyc_reminder_sent_at) — so this stays a periodic nudge,
// not a daily one once someone crosses the line.
const findUsersNeedingReminder = db.prepare(`
  SELECT u.id, u.name, u.email
  FROM users u
  WHERE u.kyc_status = 'verified'
    AND (SELECT MAX(created_at) FROM kyc_submissions WHERE user_id = u.id AND status = 'verified')
        < datetime('now', ?)
    AND (u.kyc_reminder_sent_at IS NULL OR u.kyc_reminder_sent_at < datetime('now', ?))
`);
const markReminderSent = db.prepare("UPDATE users SET kyc_reminder_sent_at = datetime('now') WHERE id = ?");

async function runKycReverificationReminders() {
  const due = findUsersNeedingReminder.all(`-${REVERIFICATION_MONTHS} months`, `-${REMINDER_COOLDOWN_DAYS} days`);
  if (!due.length) return;

  due.forEach((u) => {
    markReminderSent.run(u.id);
    notify(
      u.id,
      "kyc_reverification",
      `Your identity verification is over ${REVERIFICATION_MONTHS} months old — please re-verify to keep withdrawals working smoothly.`,
      "/verify.html"
    );
    sendEmail({
      to: u.email,
      subject: "Please re-verify your identity",
      html: layout(
        "Time to re-verify",
        `<p>Your identity verification (KYC) on Halal Income was completed over ${REVERIFICATION_MONTHS} months ago.
           Please log in and submit a fresh document from your Verify page to keep withdrawals working without interruption.</p>`
      ),
    });
  });

  alertAdmins({
    type: "kyc_reverification_batch",
    message: `${due.length} user(s) were reminded to re-verify their identity (KYC older than ${REVERIFICATION_MONTHS} months).`,
    link: "/admin.html",
    emailSubject: "KYC re-verification reminders sent",
    emailHtml: `<p>${due.length} user(s) had a KYC re-verification reminder sent today — their existing verification is over ${REVERIFICATION_MONTHS} months old. No action needed unless you want to review them individually.</p>`,
  });

  console.log(`[kyc-reminders] Reminded ${due.length} user(s) to re-verify.`);
}

module.exports = { runKycReverificationReminders };
