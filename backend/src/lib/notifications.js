const { db } = require("../db");

const insertNotification = db.prepare(`
  INSERT INTO notifications (user_id, type, message, link) VALUES (?, ?, ?, ?)
`);

// Fire-and-forget in-app notification. type is a short machine tag (e.g.
// "kyc_approved", "deposit_rejected") the frontend can use to pick an icon;
// message is the human-readable line shown in the bell dropdown.
function notify(userId, type, message, link = null) {
  insertNotification.run(userId, type, message, link);
}

module.exports = { notify };
