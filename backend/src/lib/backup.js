const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const AdmZip = require("adm-zip");
const { DatabaseSync } = require("node:sqlite");

const dataDir = path.join(__dirname, "..", "..", "data");
const dbPath = path.join(dataDir, "halal-income.sqlite");
const UPLOAD_DIRS = ["kyc-uploads", "payment-proofs", "deposit-proofs"];

// Builds a zip Buffer containing a consistent point-in-time snapshot of the
// database plus every uploaded file (KYC documents, payment proofs). VACUUM
// INTO produces that snapshot without disrupting the live connection, so
// this is safe to call at any time — including automatically, right before
// a restore, as a safety net.
function createBackupZip(db) {
  const tmpDbPath = path.join(
    os.tmpdir(),
    `halal-income-backup-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.sqlite`
  );
  db.exec(`VACUUM INTO '${tmpDbPath.replace(/'/g, "''")}'`);

  const zip = new AdmZip();
  zip.addLocalFile(tmpDbPath, "", "database.sqlite");
  UPLOAD_DIRS.forEach((dir) => {
    const fullPath = path.join(dataDir, dir);
    if (fs.existsSync(fullPath)) zip.addLocalFolder(fullPath, dir);
  });
  zip.addFile(
    "backup-manifest.json",
    Buffer.from(JSON.stringify({ app: "halal-income", createdAt: new Date().toISOString() }, null, 2))
  );

  const buffer = zip.toBuffer();
  fs.unlinkSync(tmpDbPath);
  return buffer;
}

// Validates an uploaded backup, safety-backs-up the current live data, then
// replaces the live database and upload folders with the backup's contents.
// Closes the passed-in db handle as its last step — the caller is
// responsible for making the process exit afterward, since every other
// route module holds its own reference to the now-closed handle and the
// only clean way to pick up the restored file is a full process restart.
function restoreFromZip(db, zipBuffer) {
  let zip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch {
    throw new Error("That file isn't a valid zip archive.");
  }

  const entries = zip.getEntries();
  if (!entries.some((e) => e.entryName === "database.sqlite")) {
    throw new Error("This doesn't look like a Halal Income backup — database.sqlite is missing from the zip.");
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "halal-income-restore-"));
  try {
    zip.extractAllTo(tmpDir, true);

    const extractedDbPath = path.join(tmpDir, "database.sqlite");
    if (!fs.existsSync(extractedDbPath)) {
      throw new Error("The backup's database.sqlite failed to extract.");
    }

    // Sanity-check it's really one of our databases before touching anything live.
    let testDb;
    try {
      testDb = new DatabaseSync(extractedDbPath);
      const tables = testDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name);
      if (!tables.includes("users") || !tables.includes("investments")) {
        throw new Error("The uploaded database doesn't match the expected Halal Income schema.");
      }
    } finally {
      if (testDb) testDb.close();
    }

    // Safety net: back up whatever is currently live before overwriting it,
    // in case this restore turns out to be a mistake.
    const preRestoreDir = path.join(dataDir, "pre-restore-backups");
    fs.mkdirSync(preRestoreDir, { recursive: true });
    const safetyBuffer = createBackupZip(db);
    const safetyPath = path.join(preRestoreDir, `before-restore-${Date.now()}.zip`);
    fs.writeFileSync(safetyPath, safetyBuffer);

    // Point of no return: close the live handle, then swap files in.
    db.close();

    fs.copyFileSync(extractedDbPath, dbPath);

    UPLOAD_DIRS.forEach((dir) => {
      const extractedDir = path.join(tmpDir, dir);
      if (!fs.existsSync(extractedDir)) return; // absent from this backup — leave current files alone
      const liveDir = path.join(dataDir, dir);
      fs.rmSync(liveDir, { recursive: true, force: true });
      fs.cpSync(extractedDir, liveDir, { recursive: true });
    });

    return { safetyBackupPath: safetyPath };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { createBackupZip, restoreFromZip };
