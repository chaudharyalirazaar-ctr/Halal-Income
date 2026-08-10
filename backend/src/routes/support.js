const express = require("express");
const rateLimit = require("express-rate-limit");
const { db } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { alertAdmins } = require("../lib/adminAlerts");

const router = express.Router();

// Public — same reasoning as the AI assistant's own rate limit: no login
// required to escalate, so bound by IP to stop spam/abuse. Tighter than the
// chat limiter since a ticket is heavier-weight for admins to deal with.
const ticketLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many tickets submitted. Please wait a while before trying again." },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const insertTicket = db.prepare(`
  INSERT INTO support_tickets (user_id, name, email, message, conversation)
  VALUES (?, ?, ?, ?, ?)
`);
const listOwnTickets = db.prepare(`
  SELECT id, message, status, admin_reply, replied_at, created_at
  FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC
`);

// conversation is the client-supplied AI chat transcript (see index.html's
// AI modal) — trust nothing beyond shape, same guard the assistant route
// itself uses on `history`.
function sanitizeConversation(conversation) {
  if (!Array.isArray(conversation)) return null;
  const clean = conversation
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  return clean.length ? JSON.stringify(clean) : null;
}

router.post("/tickets", ticketLimiter, (req, res) => {
  const { name, email, message, conversation } = req.body || {};

  const finalName = String(name || (req.user && req.user.name) || "").trim();
  const finalEmail = String(email || (req.user && req.user.email) || "").trim();
  const finalMessage = String(message || "").trim();

  if (!finalName) return res.status(400).json({ error: "Enter your name." });
  if (!finalEmail || !EMAIL_RE.test(finalEmail)) return res.status(400).json({ error: "Enter a valid email address." });
  if (!finalMessage) return res.status(400).json({ error: "Describe your question or issue." });
  if (finalMessage.length > 4000) return res.status(400).json({ error: "Keep your message under 4000 characters." });

  const result = insertTicket.run(
    req.user ? req.user.id : null,
    finalName,
    finalEmail,
    finalMessage,
    sanitizeConversation(conversation)
  );

  alertAdmins({
    type: "support_ticket_new",
    message: `${finalName} escalated a question the AI assistant couldn't answer.`,
    link: "/admin.html",
    emailSubject: "New support ticket awaiting review",
    emailHtml: `<p><strong>${finalName}</strong> (${finalEmail}) submitted a support ticket: "${finalMessage.slice(0, 300)}". Log in to the admin panel to review it.</p>`,
  });

  res.status(201).json({
    ok: true,
    ticketId: result.lastInsertRowid,
    message: "Your question has been sent to our team. We'll get back to you by email.",
  });
});

router.get("/tickets/mine", requireAuth, (req, res) => {
  res.json({ tickets: listOwnTickets.all(req.user.id) });
});

module.exports = router;
