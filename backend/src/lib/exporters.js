const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");

async function sendXlsx(res, filename, sheetName, columns, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  sheet.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width || 18 }));
  sheet.getRow(1).font = { bold: true };
  rows.forEach((row) => sheet.addRow(row));

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
}

function sendPdf(res, filename, title, columns, rows) {
  const doc = new PDFDocument({ margin: 36, size: "A4", layout: "landscape" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  doc.pipe(res);

  const startX = doc.page.margins.left;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidth = usableWidth / columns.length;
  const rowHeight = 16;

  function drawRow(values, y, bold) {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9);
    values.forEach((v, i) => {
      doc.text(String(v ?? ""), startX + i * colWidth, y, { width: colWidth - 6, ellipsis: true });
    });
  }

  function drawHeader() {
    const y = doc.y;
    drawRow(columns.map((c) => c.header), y, true);
    doc.moveTo(startX, y + rowHeight - 4).lineTo(startX + usableWidth, y + rowHeight - 4).stroke();
    doc.y = y + rowHeight;
  }

  doc.fontSize(16).font("Helvetica-Bold").text(title);
  doc.moveDown(0.5);
  drawHeader();

  rows.forEach((row) => {
    if (doc.y > doc.page.height - doc.page.margins.bottom - rowHeight) {
      doc.addPage();
      drawHeader();
    }
    drawRow(columns.map((c) => row[c.key]), doc.y, false);
    doc.y += rowHeight;
  });

  if (rows.length === 0) {
    doc.font("Helvetica").fontSize(10).text("No records.", startX, doc.y + 6);
  }

  doc.end();
}

module.exports = { sendXlsx, sendPdf };
