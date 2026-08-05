const { db } = require("../db");

const pendingInvestmentReserved = db.prepare(`
  SELECT COALESCE(SUM(amount), 0) AS total FROM investment_requests
  WHERE user_id = ? AND status = 'pending'
`);
const pendingWithdrawalReserved = db.prepare(`
  SELECT COALESCE(SUM(amount), 0) AS total FROM withdrawal_requests
  WHERE user_id = ? AND status = 'pending'
`);

// Reservation locking: money already committed to a pending investment or
// withdrawal request isn't available to commit again until that request is
// approved or rejected — prevents the same wallet balance being spent twice
// across two requests still awaiting admin review.
function availableBalance(user) {
  const reservedForInvestments = pendingInvestmentReserved.get(user.id).total;
  const reservedForWithdrawals = pendingWithdrawalReserved.get(user.id).total;
  return Math.max(0, user.wallet_balance - reservedForInvestments - reservedForWithdrawals);
}

module.exports = { availableBalance };
