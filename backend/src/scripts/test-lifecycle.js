// test-lifecycle.js
//
// End-to-end smoke test for the full money-moving user lifecycle:
//   signup -> verify email -> KYC -> admin approves KYC
//   -> deposit -> admin approves deposit -> balance goes up
//   -> invest in a project -> admin approves -> balance goes down
//   -> admin distributes profit -> user claims -> balance goes up
//   -> withdraw -> admin approves -> balance goes down, total_withdrawn goes up
// asserting the exact dollar amount at every step.
//
// Run against an ALREADY RUNNING server (this script doesn't start one):
//   node src/scripts/test-lifecycle.js
//
// Needs an admin account to exist already — set ADMIN_EMAIL/ADMIN_PASSWORD
// env vars to match one, or it defaults to the values used elsewhere in this
// codebase's docs/scripts (admin@test.com / AdminPass123!).
//
// WARNING: this creates a real throwaway user account and a real throwaway
// project in whatever database the server is using. Fine to run against a
// dev/test database repeatedly; don't point BASE_URL at a production site
// with real users unless you're OK with that extra test account existing.

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@test.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "AdminPass123!";

const DEPOSIT_AMOUNT = 500;
const INVEST_AMOUNT = 300;
const PROFIT_AMOUNT = 50;
// deposit - invest + profit == 250, so a full withdrawal of that leaves 0.
const EXPECTED_BALANCE_BEFORE_WITHDRAW = DEPOSIT_AMOUNT - INVEST_AMOUNT + PROFIT_AMOUNT;

let passCount = 0;

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  passCount++;
  console.log(`  ✓ ${message}`);
}

// ---- Tiny per-session cookie jar (fetch doesn't persist cookies for us) ----

function makeSession() {
  const cookies = new Map();

  function applySetCookie(res) {
    const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    raw.forEach((line) => {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    });
  }

  function cookieHeader() {
    return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async function req(method, path, { json, form } = {}) {
    const headers = { Cookie: cookieHeader() };
    let body;
    if (json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(json);
    } else if (form !== undefined) {
      body = form; // FormData — fetch sets the multipart Content-Type itself
    }

    const res = await fetch(`${BASE_URL}${path}`, { method, headers, body });
    applySetCookie(res);
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    return { ok: res.ok, status: res.status, data };
  }

  return {
    get: (path) => req("GET", path),
    post: (path, opts) => req("POST", path, opts),
    patch: (path, opts) => req("PATCH", path, opts),
  };
}

function fakeImageFile(name) {
  // A minimal valid 1x1 PNG — small enough to keep this script dependency-free
  // while still passing the real mimetype/fileFilter checks on upload routes.
  const base64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const bytes = Buffer.from(base64, "base64");
  return new File([bytes], name, { type: "image/png" });
}

async function main() {
  const stamp = Date.now();
  const testEmail = `lifecycle-test-${stamp}@example.com`;
  const testPassword = "TestPassw0rd!";

  console.log(`Testing against ${BASE_URL}`);
  console.log(`Test user: ${testEmail}\n`);

  const user = makeSession();
  const admin = makeSession();

  console.log("1. Signup");
  const signupRes = await user.post("/api/auth/signup", {
    json: { name: "Lifecycle Test", email: testEmail, dob: "1990-01-01", password: testPassword },
  });
  assert(signupRes.ok, "signup succeeds");
  assert(signupRes.data.user.email === testEmail, "signup returns the new user");

  console.log("2. Verify email");
  const sendCodeRes = await user.post("/api/verify/send-code");
  assert(sendCodeRes.ok, "send-code succeeds");
  assert(sendCodeRes.data.devCode, "dev code is present (NODE_ENV must not be production for this test)");
  const confirmRes = await user.post("/api/verify/confirm-code", { json: { code: sendCodeRes.data.devCode } });
  assert(confirmRes.ok && confirmRes.data.email === true, "email verification succeeds");

  console.log("3. Submit KYC");
  const kycForm = new FormData();
  kycForm.append("document", fakeImageFile("id.png"));
  const kycRes = await user.post("/api/verify/kyc", { form: kycForm });
  assert(kycRes.ok && kycRes.data.kyc === "pending", "KYC submission succeeds and is pending");

  console.log("4. Admin login");
  const adminLoginRes = await admin.post("/api/auth/login", { json: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  assert(adminLoginRes.ok && adminLoginRes.data.user.is_admin, "admin login succeeds");

  console.log("5. Admin approves KYC");
  const pendingKyc = await admin.get("/api/admin/kyc/pending");
  const kycSubmission = pendingKyc.data.submissions.find((s) => s.user_email === testEmail);
  assert(!!kycSubmission, "the new KYC submission shows up in the pending queue");
  const kycApproveRes = await admin.post(`/api/admin/kyc/${kycSubmission.id}/approve`);
  assert(kycApproveRes.ok, "admin approves KYC");

  console.log("6. Deposit");
  const depositForm = new FormData();
  depositForm.append("amount", String(DEPOSIT_AMOUNT));
  depositForm.append("paymentMethod", "bank_transfer");
  depositForm.append("transactionId", `lifecycle-test-txn-${stamp}`);
  depositForm.append("proof", fakeImageFile("proof.png"));
  const depositRes = await user.post("/api/wallet/deposit", { form: depositForm });
  assert(depositRes.ok, "deposit request submitted");

  console.log("7. Admin approves deposit");
  const pendingDeposits = await admin.get("/api/admin/deposits/pending");
  const depositRow = pendingDeposits.data.deposits.find((d) => d.user_email === testEmail);
  assert(!!depositRow, "the new deposit shows up in the pending queue");
  const depositApproveRes = await admin.post(`/api/admin/deposits/${depositRow.id}/approve`);
  assert(depositApproveRes.ok, "admin approves the deposit");

  let investmentsRes = await user.get("/api/investments");
  assert(investmentsRes.data.walletBalance === DEPOSIT_AMOUNT, `wallet balance is $${DEPOSIT_AMOUNT} after approved deposit`);

  console.log("8. Create a test project (as admin) and invest in it");
  const today = new Date().toISOString().slice(0, 10);
  const nextYear = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
  const createProjectRes = await admin.post("/api/admin/projects", {
    json: {
      title: `Lifecycle Test Project ${stamp}`,
      description: "Created by test-lifecycle.js — safe to delete/close.",
      targetAmount: 100000,
      startDate: today,
      endDate: nextYear,
    },
  });
  assert(createProjectRes.ok, "admin creates a test project");
  const projectId = createProjectRes.data.project.id;

  const investRes = await user.post(`/api/projects/${projectId}/invest`, { json: { amount: INVEST_AMOUNT } });
  assert(investRes.ok, "investment request submitted");

  console.log("9. Admin approves the investment request");
  const pendingInvReqs = await admin.get("/api/admin/investment-requests/pending");
  const invReqRow = pendingInvReqs.data.requests.find((r) => r.user_email === testEmail);
  assert(!!invReqRow, "the new investment request shows up in the pending queue");
  const invApproveRes = await admin.post(`/api/admin/investment-requests/${invReqRow.id}/approve`);
  assert(invApproveRes.ok, "admin approves the investment request");

  investmentsRes = await user.get("/api/investments");
  const expectedAfterInvest = DEPOSIT_AMOUNT - INVEST_AMOUNT;
  assert(investmentsRes.data.walletBalance === expectedAfterInvest, `wallet balance is $${expectedAfterInvest} after approved investment`);
  const newInvestment = investmentsRes.data.investments.find((i) => i.project_id === projectId);
  assert(!!newInvestment && newInvestment.amount === INVEST_AMOUNT, "the investment record has the right amount");

  console.log("10. Admin distributes profit, user claims it");
  const distributeRes = await admin.post(`/api/admin/investments/${newInvestment.id}/distribute-profit`, {
    json: { amount: PROFIT_AMOUNT },
  });
  assert(distributeRes.ok, "admin distributes profit");

  const claimRes = await user.post(`/api/investments/${newInvestment.id}/claim`);
  assert(claimRes.ok, "user claims the profit");

  investmentsRes = await user.get("/api/investments");
  assert(
    investmentsRes.data.walletBalance === EXPECTED_BALANCE_BEFORE_WITHDRAW,
    `wallet balance is $${EXPECTED_BALANCE_BEFORE_WITHDRAW} after claiming profit`
  );

  console.log("11. Withdraw the full balance, admin approves");
  const withdrawRes = await user.post("/api/wallet/withdraw", { json: { amount: EXPECTED_BALANCE_BEFORE_WITHDRAW } });
  assert(withdrawRes.ok, "withdrawal request submitted");

  const pendingWithdrawals = await admin.get("/api/admin/withdrawals/pending");
  const withdrawalRow = pendingWithdrawals.data.withdrawals.find((w) => w.user_email === testEmail);
  assert(!!withdrawalRow, "the new withdrawal shows up in the pending queue");
  const withdrawApproveRes = await admin.post(`/api/admin/withdrawals/${withdrawalRow.id}/approve`);
  assert(withdrawApproveRes.ok, "admin approves the withdrawal");

  investmentsRes = await user.get("/api/investments");
  assert(investmentsRes.data.walletBalance === 0, "wallet balance is exactly $0 after withdrawing everything");
  assert(investmentsRes.data.totalWithdrawn === EXPECTED_BALANCE_BEFORE_WITHDRAW, "totalWithdrawn matches the amount withdrawn");

  console.log("12. Cleanup: close the test project so it doesn't linger as open");
  await admin.patch(`/api/admin/projects/${projectId}`, { json: { status: "closed" } });

  console.log(`\n✅ All ${passCount} assertions passed.`);
  console.log(`(Test user ${testEmail} and project #${projectId} remain in the database — this script has no delete endpoints to clean those up with.)`);
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
