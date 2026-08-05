const { db } = require("../db");

const insertAuditEntry = db.prepare(`
  INSERT INTO audit_log (admin_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)
`);

// details may be any JSON-serializable object (amounts, prior status, etc.)
// or omitted entirely — kept loose so new admin actions don't need a schema change.
function logAction(adminId, action, targetType, targetId, details) {
  insertAuditEntry.run(adminId, action, targetType, targetId ?? null, details ? JSON.stringify(details) : null);
}

module.exports = { logAction };
