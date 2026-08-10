const express = require("express");
const PDFDocument = require("pdfkit");
const { db } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { availableBalance } = require("../lib/wallet");
const { sendXlsx, sendPdf } = require("../lib/exporters");

const router = express.Router();

const getInvestmentsForUser = db.prepare(
  "SELECT * FROM investments WHERE user_id = ? ORDER BY created_at DESC"
);
const getInvestmentById = db.prepare("SELECT * FROM investments WHERE id = ? AND user_id = ?");
const markClaimed = db.prepare("UPDATE investments SET claimed = 1, profit_this_period = 0 WHERE id = ?");
const addToWalletBalance = db.prepare("UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?");

function totalsFor(investments) {
  const invested = investments.reduce((sum, i) => sum + i.amount, 0);
  // profit_this_period is zeroed the moment it's claimed (see /:id/claim), so
  // any investment with a nonzero amount here has something genuinely
  // unclaimed — including profit distributed *after* an earlier claim, which
  // gating on the old sticky `claimed` flag would otherwise hide forever.
  const claimable = investments.reduce((sum, i) => sum + i.profit_this_period, 0);
  return { invested, claimable };
}

router.get("/", requireAuth, (req, res) => {
  const investments = getInvestmentsForUser.all(req.user.id);
  res.json({
    investments,
    totals: totalsFor(investments),
    walletBalance: req.user.wallet_balance,
    availableBalance: availableBalance(req.user),
    totalWithdrawn: req.user.total_withdrawn,
    kycVerified: req.user.kyc_status === "verified",
  });
});

// Every profit credit ever made to this user, grouped by the day it landed —
// backs the profit-history chart on the Balance page. Not per-investment
// (every distribution already records which investment/project in
// earnings_events if that level of detail is ever needed); this is
// deliberately the simpler "profit over time across everything" view.
const earningsHistoryForUser = db.prepare(`
  SELECT event_date AS date, SUM(amount) AS amount
  FROM earnings_events WHERE user_id = ? GROUP BY event_date ORDER BY event_date ASC
`);

router.get("/earnings-history", requireAuth, (req, res) => {
  res.json({ history: earningsHistoryForUser.all(req.user.id) });
});

// Moves an investment's unclaimed profit into the user's wallet balance,
// where it can then be invested further or withdrawn — see wallet.js for
// deposits/withdrawals and the general balance this feeds into.
router.post("/:id/claim", requireAuth, (req, res) => {
  const investment = getInvestmentById.get(req.params.id, req.user.id);
  if (!investment) return res.status(404).json({ error: "Investment not found." });
  if (investment.profit_this_period <= 0) {
    return res.status(400).json({ error: "There is no profit to claim for this investment yet." });
  }

  addToWalletBalance.run(investment.profit_this_period, req.user.id);
  markClaimed.run(investment.id);
  res.json({ ok: true });
});

// ---- Certificate (single investment) ---------------------------------------

router.get("/:id/certificate", requireAuth, (req, res) => {
  const investment = getInvestmentById.get(req.params.id, req.user.id);
  if (!investment) return res.status(404).json({ error: "Investment not found." });

  try {
    const doc = new PDFDocument({ margin: 56, size: "A4" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="investment-certificate-${investment.id}.pdf"`);
    doc.pipe(res);

    doc.fontSize(10).fillColor("#1F4A3D").font("Helvetica-Bold").text("HALAL INCOME", { align: "center" });
    doc.moveDown(0.3);
    doc.fontSize(20).fillColor("#000").font("Helvetica-Bold").text("Certificate of Investment", { align: "center" });
    doc.moveDown(1.5);

    doc.fontSize(11).font("Helvetica").fillColor("#000");
    const rows = [
      ["Certificate ID", `HI-INV-${String(investment.id).padStart(6, "0")}`],
      ["Investor", req.user.name],
      ["Project", investment.project],
      ["Amount invested", `$${Number(investment.amount).toLocaleString()}`],
      ["Status", investment.status === "completed" ? "Completed" : "Active"],
      ["Date recorded", investment.created_at],
    ];
    rows.forEach(([label, value]) => {
      doc.font("Helvetica-Bold").text(`${label}:  `, { continued: true }).font("Helvetica").text(String(value));
      doc.moveDown(0.4);
    });

    doc.moveDown(1);
    doc
      .fontSize(9)
      .fillColor("#555")
      .text(
        "This certificate records a profit-sharing investment made through Halal Income. It is not a " +
          "tradable security, a guarantee of return, or evidence of any fixed rate of profit. All investment " +
          "carries risk, including risk of loss to principal. Figures shown are as recorded on the date of " +
          `generation: ${new Date().toISOString().slice(0, 10)}.`,
        { align: "left" }
      );

    doc.end();
  } catch (err) {
    console.error("[investments] Certificate generation failed:", err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to generate certificate." });
  }
});

// ---- Personal statement (all of the logged-in user's own history) ---------

router.get("/export/:format", requireAuth, async (req, res) => {
  const investments = getInvestmentsForUser.all(req.user.id);
  const deposits = db
    .prepare("SELECT amount, payment_method, status, requested_at, processed_at FROM deposit_requests WHERE user_id = ? ORDER BY requested_at DESC")
    .all(req.user.id);
  const withdrawals = db
    .prepare("SELECT amount, status, requested_at, processed_at FROM withdrawal_requests WHERE user_id = ? ORDER BY requested_at DESC")
    .all(req.user.id);

  const dateStamp = new Date().toISOString().slice(0, 10);

  try {
    if (req.params.format === "xlsx") {
      const ExcelJS = require("exceljs");
      const workbook = new ExcelJS.Workbook();

      const invSheet = workbook.addWorksheet("Investments");
      invSheet.columns = [
        { header: "Project", key: "project", width: 30 },
        { header: "Amount", key: "amount", width: 14 },
        { header: "Unclaimed Profit", key: "profit_this_period", width: 16 },
        { header: "Status", key: "status", width: 14 },
        { header: "Date", key: "created_at", width: 20 },
      ];
      invSheet.getRow(1).font = { bold: true };
      investments.forEach((i) => invSheet.addRow(i));

      const depSheet = workbook.addWorksheet("Deposits");
      depSheet.columns = [
        { header: "Amount", key: "amount", width: 14 },
        { header: "Method", key: "payment_method", width: 18 },
        { header: "Status", key: "status", width: 14 },
        { header: "Requested", key: "requested_at", width: 20 },
        { header: "Processed", key: "processed_at", width: 20 },
      ];
      depSheet.getRow(1).font = { bold: true };
      deposits.forEach((d) => depSheet.addRow(d));

      const wSheet = workbook.addWorksheet("Withdrawals");
      wSheet.columns = [
        { header: "Amount", key: "amount", width: 14 },
        { header: "Status", key: "status", width: 14 },
        { header: "Requested", key: "requested_at", width: 20 },
        { header: "Processed", key: "processed_at", width: 20 },
      ];
      wSheet.getRow(1).font = { bold: true };
      withdrawals.forEach((w) => wSheet.addRow(w));

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="halal-income-statement-${dateStamp}.xlsx"`);
      await workbook.xlsx.write(res);
      res.end();
    } else if (req.params.format === "pdf") {
      const doc = new PDFDocument({ margin: 40, size: "A4" });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="halal-income-statement-${dateStamp}.pdf"`);
      doc.pipe(res);

      doc.fontSize(18).font("Helvetica-Bold").text(`Statement for ${req.user.name}`);
      doc.fontSize(10).font("Helvetica").fillColor("#555").text(`Generated ${dateStamp}`);
      doc.moveDown(1);

      function section(title, rows, cols) {
        doc.fontSize(13).font("Helvetica-Bold").fillColor("#000").text(title);
        doc.moveDown(0.3);
        if (!rows.length) {
          doc.fontSize(10).font("Helvetica").fillColor("#555").text("None.");
        } else {
          rows.forEach((r) => {
            const line = cols.map((c) => `${c.label}: ${r[c.key] ?? ""}`).join("   |   ");
            doc.fontSize(9).font("Helvetica").fillColor("#000").text(line);
          });
        }
        doc.moveDown(1);
      }

      section("Investments", investments, [
        { label: "Project", key: "project" },
        { label: "Amount", key: "amount" },
        { label: "Unclaimed profit", key: "profit_this_period" },
        { label: "Status", key: "status" },
        { label: "Date", key: "created_at" },
      ]);
      section("Deposits", deposits, [
        { label: "Amount", key: "amount" },
        { label: "Method", key: "payment_method" },
        { label: "Status", key: "status" },
        { label: "Requested", key: "requested_at" },
      ]);
      section("Withdrawals", withdrawals, [
        { label: "Amount", key: "amount" },
        { label: "Status", key: "status" },
        { label: "Requested", key: "requested_at" },
      ]);

      doc.end();
    } else {
      res.status(400).json({ error: "Format must be xlsx or pdf." });
    }
  } catch (err) {
    console.error("[investments] Statement export failed:", err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to generate statement." });
  }
});

module.exports = router;
