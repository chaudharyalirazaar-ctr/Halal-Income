const { db } = require("../db");
const { notify } = require("./notifications");
const { sendEmail, layout } = require("./mailer");

// Every account with is_admin = 1 (super_admin, or a plain admin with at
// least one granted permission — see requirePermission() in middleware/
// auth.js) gets pinged, in-app and by email, whenever a new pending request
// needs review. Deliberately NOT filtered by which specific permission an
// admin holds (e.g. only an approve_kyc admin hearing about new KYC) — for
// a small team, missing something because an alert was too narrowly routed
// is worse than a KYC reviewer also hearing about a new withdrawal request.
const listAdmins = db.prepare("SELECT id, email FROM users WHERE is_admin = 1");

// type/message/link mirror notify()'s own params (shown in the bell
// dropdown); emailSubject/emailHtml are the matching email. Fire-and-forget,
// same as every other notify()/sendEmail() call in this codebase — a slow
// or failed email should never block the request that triggered it.
function alertAdmins({ type, message, link = null, emailSubject, emailHtml }) {
  const admins = listAdmins.all();
  for (const admin of admins) {
    notify(admin.id, type, message, link);
    if (admin.email) {
      sendEmail({ to: admin.email, subject: emailSubject, html: layout(emailSubject, emailHtml) });
    }
  }
}

module.exports = { alertAdmins };
