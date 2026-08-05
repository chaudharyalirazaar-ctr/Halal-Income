const express = require("express");
const { db } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const listRecent = db.prepare(`
  SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30
`);
const countUnread = db.prepare(`
  SELECT COUNT(*) AS total FROM notifications WHERE user_id = ? AND is_read = 0
`);
const markOneRead = db.prepare(`
  UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?
`);
const markAllRead = db.prepare(`
  UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0
`);

router.get("/", requireAuth, (req, res) => {
  res.json({
    notifications: listRecent.all(req.user.id),
    unreadCount: countUnread.get(req.user.id).total,
  });
});

router.post("/:id/read", requireAuth, (req, res) => {
  markOneRead.run(req.params.id, req.user.id);
  res.json({ ok: true });
});

router.post("/read-all", requireAuth, (req, res) => {
  markAllRead.run(req.user.id);
  res.json({ ok: true });
});

module.exports = router;
