const express = require("express");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const { db } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { sendEmail, layout } = require("../lib/mailer");
const { alertAdmins } = require("../lib/adminAlerts");

const router = express.Router();

const CODE_TTL_MINUTES = 10;
const kycDir = path.join(__dirname, "..", "..", "data", "kyc-uploads");
fs.mkdirSync(kycDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userDir = path.join(kycDir, String(req.user.id));
    fs.mkdirSync(userDir, { recursive: true });
    cb(null, userDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10).replace(/[^a-zA-Z0-9.]/g, "");
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Only JPEG, PNG, WEBP, or PDF files are allowed."));
    }
    cb(null, true);
  },
});

const sendCodeLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many code requests. Wait a few minutes and try again." },
});

const insertCode = db.prepare(`
  INSERT INTO email_codes (user_id, code, expires_at) VALUES (?, ?, ?)
`);
const getLatestCode = db.prepare(`
  SELECT * FROM email_codes
  WHERE user_id = ? AND consumed = 0
  ORDER BY id DESC LIMIT 1
`);
const consumeCode = db.prepare("UPDATE email_codes SET consumed = 1 WHERE id = ?");
const markEmailVerified = db.prepare("UPDATE users SET email_verified = 1 WHERE id = ?");
const insertKyc = db.prepare(`
  INSERT INTO kyc_submissions (user_id, file_path, original_name) VALUES (?, ?, ?)
`);
const setKycPending = db.prepare("UPDATE users SET kyc_status = 'pending' WHERE id = ?");
const getLatestKycSubmission = db.prepare(`
  SELECT status, rejection_reason, created_at FROM kyc_submissions
  WHERE user_id = ? ORDER BY id DESC LIMIT 1
`);

router.get("/status", requireAuth, (req, res) => {
  const latestKyc = getLatestKycSubmission.get(req.user.id);
  res.json({
    email: !!req.user.email_verified,
    kyc: req.user.kyc_status,
    // Only meaningful when kyc is 'rejected' — the reason the admin gave, if
    // they wrote one, so the user knows what to fix before resubmitting.
    kycRejectionReason: latestKyc && latestKyc.status === "rejected" ? latestKyc.rejection_reason : null,
  });
});

router.post("/send-code", requireAuth, sendCodeLimiter, (req, res) => {
  if (req.user.email_verified) {
    return res.status(400).json({ error: "Email is already verified." });
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString();
  insertCode.run(req.user.id, code, expiresAt);

  // sendEmail() logs to the console instead of actually sending if
  // RESEND_API_KEY isn't set — see backend/src/lib/mailer.js. Fire-and-forget:
  // it never throws, and we don't want a slow mail provider to delay the response.
  sendEmail({
    to: req.user.email,
    subject: `Your Halal Income verification code: ${code}`,
    html: layout(
      "Verify your email",
      `<p>Your verification code is:</p>
       <p style="font-size: 28px; font-weight: 700; letter-spacing: 4px; margin: 16px 0;">${code}</p>
       <p>This code expires in ${CODE_TTL_MINUTES} minutes. If you didn't request this, you can ignore it.</p>`
    ),
  });

  const response = { sent: true };
  if (process.env.NODE_ENV !== "production") response.devCode = code;
  res.json(response);
});

router.post("/confirm-code", requireAuth, (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: "Enter the code that was sent to your email." });

  const latest = getLatestCode.get(req.user.id);
  if (!latest) return res.status(400).json({ error: "No pending code. Request a new one." });
  if (new Date(latest.expires_at) < new Date()) {
    return res.status(400).json({ error: "That code has expired. Request a new one." });
  }
  if (String(code).trim() !== latest.code) {
    return res.status(400).json({ error: "Incorrect code." });
  }

  consumeCode.run(latest.id);
  markEmailVerified.run(req.user.id);
  res.json({ email: true });
});

router.post("/kyc", requireAuth, (req, res) => {
  upload.single("document")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "A document file is required." });
    if (!req.user.email_verified) {
      return res.status(403).json({ error: "Verify your email before submitting KYC." });
    }

    const relativePath = path.relative(path.join(__dirname, "..", "..", "data"), req.file.path);
    insertKyc.run(req.user.id, relativePath, req.file.originalname);
    setKycPending.run(req.user.id);

    alertAdmins({
      type: "kyc_new",
      message: `${req.user.name} submitted a new KYC document for review.`,
      link: "/admin.html",
      emailSubject: "New KYC submission awaiting review",
      emailHtml: `<p><strong>${req.user.name}</strong> (${req.user.email}) submitted a new KYC document. Log in to the admin panel to review it.</p>`,
    });

    res.status(201).json({ kyc: "pending" });
  });
});

module.exports = router;
