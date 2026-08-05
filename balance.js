// balance.js
//
// Fetches the logged-in user's real investments, wallet balance, deposits,
// and withdrawals from the backend and wires up the Deposit/Withdraw modals
// and the per-investment Claim button. Every money-moving action here
// creates a request for an admin to review — see backend/src/routes/wallet.js,
// investments.js, and admin.js — nothing moves automatically.

let latestKycVerified = false;

function fmtDate(s) {
  if (!s) return "—";
  const d = new Date(s.replace(" ", "T") + "Z");
  return isNaN(d) ? s : d.toLocaleString();
}

const PAYMENT_METHOD_LABELS = {
  bank_transfer: "Bank transfer",
  usdt_trc20: "USDT (TRC20)",
  usdt_bep20: "USDT (BEP20)",
  other: "Other",
};

async function fetchJson(url) {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error("Failed to load data.");
  return res.json();
}

async function renderBalancePage() {
  const { investments, totals, walletBalance, totalWithdrawn, kycVerified } = await fetchJson("/api/investments");
  latestKycVerified = kycVerified;

  document.getElementById("bal-wallet").textContent = "$" + walletBalance.toLocaleString();
  document.getElementById("bal-invested").textContent = "$" + totals.invested.toLocaleString();
  document.getElementById("bal-claimable").textContent = "$" + totals.claimable.toLocaleString();
  document.getElementById("bal-withdrawn").textContent = "$" + totalWithdrawn.toLocaleString();

  const kycBanner = document.getElementById("kyc-banner");
  if (kycBanner) kycBanner.style.display = kycVerified ? "none" : "flex";

  const body = document.getElementById("balance-table-body");
  body.innerHTML = "";
  investments.forEach((inv) => {
    const tr = document.createElement("tr");
    const claimBtn = inv.profit_this_period > 0
      ? `<button type="button" class="btn btn-primary btn-small" data-claim="${inv.id}">Claim $${inv.profit_this_period}</button>`
      : "";
    const certificateLink = `<a href="/api/investments/${inv.id}/certificate" class="btn btn-ghost btn-small" target="_blank" rel="noopener">Certificate</a>`;
    tr.innerHTML =
      `<td>${inv.project}</td>` +
      `<td>$${inv.amount.toLocaleString()}</td>` +
      `<td>$${inv.profit_this_period.toLocaleString()}</td>` +
      `<td>${inv.status}</td>` +
      `<td style="display:flex; gap:6px; flex-wrap:wrap;">${claimBtn}${certificateLink}</td>`;
    body.appendChild(tr);
  });

  body.querySelectorAll("[data-claim]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const res = await fetch(`/api/investments/${btn.dataset.claim}/claim`, {
          method: "POST",
          credentials: "same-origin",
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to claim.");
        await renderBalancePage();
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    });
  });

  const depositsBody = document.getElementById("deposits-table-body");
  const { deposits } = await fetchJson("/api/wallet/deposits");
  depositsBody.innerHTML = deposits.length
    ? ""
    : '<tr><td colspan="4" class="admin-empty">No deposits yet.</td></tr>';
  deposits.forEach((d) => {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>$${d.amount.toLocaleString()}</td>` +
      `<td>${PAYMENT_METHOD_LABELS[d.payment_method] || d.payment_method}</td>` +
      `<td>${d.status}</td>` +
      `<td>${fmtDate(d.requested_at)}</td>`;
    depositsBody.appendChild(tr);
  });

  const withdrawalsBody = document.getElementById("withdrawals-table-body");
  const { withdrawals } = await fetchJson("/api/wallet/withdrawals");
  withdrawalsBody.innerHTML = withdrawals.length
    ? ""
    : '<tr><td colspan="3" class="admin-empty">No withdrawals yet.</td></tr>';
  withdrawals.forEach((w) => {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>$${w.amount.toLocaleString()}</td>` +
      `<td>${w.status}</td>` +
      `<td>${fmtDate(w.requested_at)}</td>`;
    withdrawalsBody.appendChild(tr);
  });
}

// ---- Deposit modal ---------------------------------------------------------

function wireDepositModal() {
  const overlay = document.getElementById("deposit-modal-overlay");
  const form = document.getElementById("deposit-modal-form");
  const errorEl = document.getElementById("deposit-modal-error");
  const successEl = document.getElementById("deposit-modal-success");
  const successText = document.getElementById("deposit-modal-success-text");

  function open() {
    form.reset();
    form.style.display = "grid";
    errorEl.style.display = "none";
    successEl.style.display = "none";
    overlay.classList.add("invest-modal-open");
  }
  function close() {
    overlay.classList.remove("invest-modal-open");
  }

  document.getElementById("open-deposit-modal").addEventListener("click", open);
  document.getElementById("deposit-modal-cancel").addEventListener("click", close);
  document.getElementById("deposit-modal-close-success").addEventListener("click", () => {
    close();
    renderBalancePage();
  });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.style.display = "none";
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    try {
      const res = await fetch("/api/wallet/deposit", {
        method: "POST",
        credentials: "same-origin",
        body: new FormData(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong.");

      form.style.display = "none";
      successText.textContent = data.message;
      successEl.style.display = "block";
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = "block";
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// ---- Withdraw modal ---------------------------------------------------------

function wireWithdrawModal() {
  const overlay = document.getElementById("withdraw-modal-overlay");
  const form = document.getElementById("withdraw-modal-form");
  const errorEl = document.getElementById("withdraw-modal-error");
  const successEl = document.getElementById("withdraw-modal-success");
  const successText = document.getElementById("withdraw-modal-success-text");
  const kycLocked = document.getElementById("withdraw-modal-kyc-locked");

  function open() {
    errorEl.style.display = "none";
    successEl.style.display = "none";
    if (!latestKycVerified) {
      form.style.display = "none";
      kycLocked.style.display = "block";
    } else {
      form.reset();
      form.style.display = "grid";
      kycLocked.style.display = "none";
    }
    overlay.classList.add("invest-modal-open");
  }
  function close() {
    overlay.classList.remove("invest-modal-open");
  }

  document.getElementById("open-withdraw-modal").addEventListener("click", open);
  document.getElementById("withdraw-modal-cancel").addEventListener("click", close);
  document.getElementById("withdraw-modal-cancel-locked").addEventListener("click", close);
  document.getElementById("withdraw-modal-close-success").addEventListener("click", () => {
    close();
    renderBalancePage();
  });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.style.display = "none";
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    try {
      const res = await fetch("/api/wallet/withdraw", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: Number(form.amount.value) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong.");

      form.style.display = "none";
      successText.textContent = data.message;
      successEl.style.display = "block";
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = "block";
    } finally {
      submitBtn.disabled = false;
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  const user = await Auth.currentUser();

  document.getElementById("logged-out-message").style.display = user ? "none" : "block";
  document.getElementById("logged-in-content").style.display = user ? "block" : "none";

  if (!user) return;

  wireDepositModal();
  wireWithdrawModal();
  renderBalancePage();
});
