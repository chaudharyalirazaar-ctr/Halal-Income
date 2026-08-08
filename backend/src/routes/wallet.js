const express = require("express");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const { db } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { availableBalance } = require("../lib/wallet");
const { requirePin } = require("../lib/pin");

const router = express.Router();

const MIN_WITHDRAWAL_AMOUNT = 30;

// Per-user (via keyGenerator) rather than pure per-IP, since these are all
// behind requireAuth already — bounds how many deposit/withdraw requests one
// account can spam (e.g. brute-forcing transaction IDs) without punishing a
// shared office/NAT IP full of legitimate users.
const moneyActionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `user:${req.user.id}` : req.ip),
  message: { error: "Too many requests. Please wait a while before trying again." },
});

const proofDir = path.join(__dirname, "..", "..", "data", "deposit-proofs");
fs.mkdirSync(proofDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userDir = path.join(proofDir, String(req.user.id));
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

const insertDeposit = db.prepare(`
  INSERT INTO deposit_requests
    (user_id, amount, payment_method, transaction_id, proof_file_path, proof_original_name)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const listOwnDeposits = db.prepare(`
  SELECT id, amount, payment_method, transaction_id, status, rejection_reason, requested_at, processed_at
  FROM deposit_requests WHERE user_id = ? ORDER BY requested_at DESC
`);
const listOwnWithdrawals = db.prepare(`
  SELECT id, amount, status, rejection_reason, requested_at, processed_at
  FROM withdrawal_requests WHERE user_id = ? ORDER BY requested_at DESC
`);
const insertWithdrawal = db.prepare(`
  INSERT INTO withdrawal_requests (user_id, amount) VALUES (?, ?)
`);

router.post("/deposit", requireAuth, moneyActionLimiter, (req, res) => {
  upload.single("proof")(req, res, (uploadErr) => {
    if (uploadErr) return res.status(400).json({ error: uploadErr.message });
    if (!req.file) return res.status(400).json({ error: "Payment proof (screenshot or receipt) is required." });

    const cleanup = () => fs.unlink(req.file.path, () => {});

    const { amount, paymentMethod, transactionId } = req.body || {};
    const trimmedTxnId = String(transactionId || "").trim();

    if (!(amount > 0)) {
      cleanup();
      return res.status(400).json({ error: "Enter a positive deposit amount." });
    }
    if (!paymentMethod) {
      cleanup();
      return res.status(400).json({ error: "Select a payment method." });
    }
    if (!trimmedTxnId) {
      cleanup();
      return res.status(400).json({ error: "Enter the transaction ID / reference number for your payment." });
    }

    const relativePath = path.relative(path.join(__dirname, "..", "..", "data"), req.file.path);

    try {
      insertDeposit.run(
        req.user.id,
        Number(amount),
        String(paymentMethod),
        trimmedTxnId,
        relativePath,
        req.file.originalname
      );
    } catch (err) {
      cleanup();
      if (String(err.message).includes("UNIQUE constraint failed") && String(err.message).includes("transaction_id")) {
        return res.status(409).json({
          error: "This transaction ID has already been used on a previous deposit. Each payment reference can only be submitted once.",
        });
      }
      throw err;
    }

    res.status(201).json({
      ok: true,
      message: "Deposit request submitted. Our team will verify your payment proof and add it to your balance — no funds have moved automatically.",
    });
  });
});

router.get("/deposits", requireAuth, (req, res) => {
  res.json({ deposits: listOwnDeposits.all(req.user.id) });
});

router.post("/withdraw", requireAuth, moneyActionLimiter, requirePin, (req, res) => {
  if (req.user.kyc_status !== "verified") {
    return res.status(403).json({ error: "Identity verification (KYC) is required before withdrawing." });
  }

  const { amount } = req.body || {};
  if (!(amount > 0)) {
    return res.status(400).json({ error: "Enter a positive withdrawal amount." });
  }
  if (Number(amount) < MIN_WITHDRAWAL_AMOUNT) {
    return res.status(400).json({ error: `The minimum withdrawal amount is $${MIN_WITHDRAWAL_AMOUNT}.` });
  }

  const available = availableBalance(req.user);
  if (Number(amount) > available) {
    return res.status(400).json({
      error: `Only $${available.toLocaleString()} of your balance is currently available (some may be reserved by other pending requests).`,
    });
  }

  insertWithdrawal.run(req.user.id, Number(amount));
  res.status(201).json({
    ok: true,
    message: "Withdrawal request submitted. It will be reviewed and paid out by an administrator — no funds have moved automatically.",
  });
});

router.get("/withdrawals", requireAuth, (req, res) => {
  res.json({ withdrawals: listOwnWithdrawals.all(req.user.id) });
});

module.exports = router;
