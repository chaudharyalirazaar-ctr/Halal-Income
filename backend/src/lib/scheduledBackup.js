// Nightly automated backup — runs via lib/scheduler.js. Complements the
// existing manual "Download full backup" button in the admin panel rather
// than replacing it: this one happens whether or not anyone remembers to
// click it.
//
// Two layers of "off-server" safety, in order of how much they actually
// protect against total server/volume loss:
//   1. Emailed to every super admin as an attachment (genuinely off-server —
//      lands in an inbox, survives even if the server and its disk vanish).
//      Skipped if the zip is too large for a typical inbound-email limit,
//      or if RESEND_API_KEY isn't configured (see lib/mailer.js).
//   2. Kept on disk under backend/data/backups/, rolling the last KEEP_COUNT
//      copies. Better than nothing (protects against DB corruption or an
//      accidental restore), but not a substitute for #1 if the whole
//      server/volume is lost — say so plainly in the admin-facing status
//      text rather than implying more safety than this actually provides.
const fs = require("node:fs");
const path = require("node:path");
const { db } = require("../db");
const { createBackupZip } = require("./backup");
const { sendEmail, layout } = require("./mailer");
const { notify } = require("./notifications");

const backupsDir = path.join(__dirname, "..", "..", "data", "backups");
const KEEP_COUNT = 7;
const MAX_EMAIL_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20MB — comfortably under Resend's limit

const listSuperAdmins = db.prepare("SELECT id, email FROM users WHERE role = 'super_admin'");

async function runNightlyBackup() {
  fs.mkdirSync(backupsDir, { recursive: true });

  const buffer = createBackupZip(db);
  const dateStamp = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(backupsDir, `backup-${dateStamp}.zip`), buffer);

  // Roll old copies — keep only the most recent KEEP_COUNT.
  const files = fs
    .readdirSync(backupsDir)
    .filter((f) => f.endsWith(".zip"))
    .sort();
  files.slice(0, Math.max(0, files.length - KEEP_COUNT)).forEach((f) => fs.unlinkSync(path.join(backupsDir, f)));

  const admins = listSuperAdmins.all();
  const sizeMb = (buffer.length / (1024 * 1024)).toFixed(1);
  const canEmail = buffer.length <= MAX_EMAIL_ATTACHMENT_BYTES;

  admins.forEach((admin) => {
    notify(
      admin.id,
      "backup_completed",
      `Nightly backup completed (${sizeMb} MB)${canEmail ? " — emailed to you and saved on the server." : " — too large to email, saved on the server only."}`,
      "/admin.html"
    );
    if (admin.email && canEmail) {
      sendEmail({
        to: admin.email,
        subject: `Nightly backup — ${dateStamp}`,
        html: layout(
          "Your nightly backup is attached",
          `<p>A full site backup (database + uploaded files, ${sizeMb} MB) was created automatically and is attached to this email.</p>
           <p>The server also keeps the last ${KEEP_COUNT} nightly backups — but this email is your off-server copy, so keep it somewhere safe.</p>`
        ),
        attachments: [{ filename: `halal-income-backup-${dateStamp}.zip`, content: buffer.toString("base64") }],
      });
    }
  });

  console.log(
    `[scheduled-backup] Backup created (${sizeMb} MB), ${admins.length} super admin(s) notified${canEmail ? " and emailed" : " (too large to email)"}.`
  );
}

module.exports = { runNightlyBackup };
