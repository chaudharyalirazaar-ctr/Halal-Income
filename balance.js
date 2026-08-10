// balance.js
//
// Fetches the logged-in user's real investments, wallet balance, deposits,
// and withdrawals from the backend and wires up the Deposit/Withdraw modals
// and the per-investment Claim button. Every money-moving action here
// creates a request for an admin to review — see backend/src/routes/wallet.js,
// investments.js, and admin.js — nothing moves automatically.

let latestKycVerified = false;
let latestPinSet = false;

function fmtDate(s) {
  if (!s) return "—";
  const d = new Date(s.replace(" ", "T") + "Z");
  return isNaN(d) ? s : d.toLocaleString();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
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

  await renderProjectUpdatesFeed(investments);

  const depositsBody = document.getElementById("deposits-table-body");
  const { deposits } = await fetchJson("/api/wallet/deposits");
  depositsBody.innerHTML = deposits.length
    ? ""
    : '<tr><td colspan="4" class="admin-empty">No deposits yet.</td></tr>';
  deposits.forEach((d) => {
    const tr = document.createElement("tr");
    const statusCell = d.status === "rejected" && d.rejection_reason
      ? `${d.status}<br/><span style="font-size:0.78rem; opacity:0.75;">Reason: ${d.rejection_reason}</span>`
      : d.status;
    tr.innerHTML =
      `<td>$${d.amount.toLocaleString()}</td>` +
      `<td>${PAYMENT_METHOD_LABELS[d.payment_method] || d.payment_method}</td>` +
      `<td>${statusCell}</td>` +
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
    const statusCell = w.status === "rejected" && w.rejection_reason
      ? `${w.status}<br/><span style="font-size:0.78rem; opacity:0.75;">Reason: ${w.rejection_reason}</span>`
      : w.status;
    tr.innerHTML =
      `<td>$${w.amount.toLocaleString()}</td>` +
      `<td>${statusCell}</td>` +
      `<td>${fmtDate(w.requested_at)}</td>`;
    withdrawalsBody.appendChild(tr);
  });
}

// ---- Project updates feed ----------------------------------------------
//
// Pulls updates from every distinct project the user has invested in (GET
// /api/projects/:id/updates — public, same visibility as the project itself)
// and merges them into one reverse-chronological feed. Old investments made
// before project_id existed have it as null and are just skipped — nothing
// to fetch updates for.

async function renderProjectUpdatesFeed(investments) {
  const section = document.getElementById("project-updates-section");
  const list = document.getElementById("project-updates-list");

  const projectIds = [...new Set(investments.map((i) => i.project_id).filter(Boolean))];
  if (!projectIds.length) {
    section.style.display = "none";
    return;
  }

  const results = await Promise.all(
    projectIds.map(async (id) => {
      const projectName = (investments.find((i) => i.project_id === id) || {}).project || "Project";
      try {
        const { updates } = await fetchJson(`/api/projects/${id}/updates`);
        return updates.map((u) => ({ ...u, projectName }));
      } catch {
        return [];
      }
    })
  );

  const allUpdates = results.flat().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  if (!allUpdates.length) {
    section.style.display = "none";
    return;
  }

  section.style.display = "block";
  list.innerHTML = "";
  allUpdates.forEach((u) => {
    const card = document.createElement("div");
    card.style.cssText = "border:1px solid var(--sand); border-radius:8px; padding:12px 14px;";
    card.innerHTML =
      `<div style="display:flex; justify-content:space-between; gap:12px; font-size:0.8rem; opacity:0.7; margin-bottom:6px;">` +
      `<strong>${escapeHtml(u.projectName)}</strong><span>${fmtDate(u.created_at)}</span></div>` +
      `<p style="margin:0; white-space:pre-wrap;">${escapeHtml(u.message)}</p>`;
    list.appendChild(card);
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
  const pinLocked = document.getElementById("withdraw-modal-pin-locked");

  function open() {
    errorEl.style.display = "none";
    successEl.style.display = "none";
    form.style.display = "none";
    kycLocked.style.display = "none";
    pinLocked.style.display = "none";

    if (!latestKycVerified) {
      kycLocked.style.display = "block";
    } else if (!latestPinSet) {
      pinLocked.style.display = "block";
    } else {
      form.reset();
      form.style.display = "grid";
    }
    overlay.classList.add("invest-modal-open");
  }
  function close() {
    overlay.classList.remove("invest-modal-open");
  }

  document.getElementById("open-withdraw-modal").addEventListener("click", open);
  document.getElementById("withdraw-modal-cancel").addEventListener("click", close);
  document.getElementById("withdraw-modal-cancel-locked").addEventListener("click", close);
  document.getElementById("withdraw-modal-cancel-pin-locked").addEventListener("click", close);
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
        body: JSON.stringify({ amount: Number(form.amount.value), pin: form.pin.value }),
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

// ---- Security PIN -----------------------------------------------------------

async function refreshPinStatus() {
  const { isSet } = await fetchJson("/api/auth/pin/status");
  latestPinSet = isSet;
  document.getElementById("pin-not-set-view").style.display = isSet ? "none" : "block";
  document.getElementById("pin-set-view").style.display = isSet ? "block" : "none";
}

function wirePinForms() {
  const setForm = document.getElementById("pin-set-form");
  const setError = document.getElementById("pin-set-error");
  setForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    setError.style.display = "none";
    const submitBtn = setForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const res = await fetch("/api/auth/pin", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: setForm.pin.value, currentPassword: setForm.currentPassword.value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      setForm.reset();
      await refreshPinStatus();
    } catch (err) {
      setError.textContent = err.message;
      setError.style.display = "block";
    } finally {
      submitBtn.disabled = false;
    }
  });

  const changeForm = document.getElementById("pin-change-form");
  const changeError = document.getElementById("pin-change-error");
  changeForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    changeError.style.display = "none";
    const submitBtn = changeForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const res = await fetch("/api/auth/pin", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: changeForm.pin.value, currentPin: changeForm.currentPin.value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      changeForm.reset();
      alert("PIN changed.");
    } catch (err) {
      changeError.textContent = err.message;
      changeError.style.display = "block";
    } finally {
      submitBtn.disabled = false;
    }
  });

  refreshPinStatus();
  wirePinForgotFlow();
}

function wirePinForgotFlow() {
  const toggleBtn = document.getElementById("pin-forgot-toggle");
  const panel = document.getElementById("pin-forgot-panel");
  const sendBtn = document.getElementById("pin-forgot-send-btn");
  const form = document.getElementById("pin-forgot-form");
  const errorEl = document.getElementById("pin-forgot-error");
  const successEl = document.getElementById("pin-forgot-success");

  toggleBtn.addEventListener("click", () => {
    panel.style.display = panel.style.display === "none" ? "block" : "none";
  });

  sendBtn.addEventListener("click", async () => {
    errorEl.style.display = "none";
    successEl.style.display = "none";
    sendBtn.disabled = true;
    try {
      const res = await fetch("/api/auth/pin/forgot", { method: "POST", credentials: "same-origin" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      form.style.display = "grid";
      successEl.textContent = "Code sent — check your email.";
      successEl.style.display = "block";
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = "block";
    } finally {
      sendBtn.disabled = false;
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.style.display = "none";
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const res = await fetch("/api/auth/pin/reset", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: form.code.value, pin: form.pin.value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      form.reset();
      form.style.display = "none";
      panel.style.display = "none";
      successEl.style.display = "none";
      alert("PIN reset. Use your new PIN from now on.");
      await refreshPinStatus();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = "block";
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// ---- Two-factor authentication -----------------------------------------
//
// Same backend endpoints admin.html uses (/api/auth/2fa/*) — they were
// never admin-only, just never exposed outside the admin panel's UI.

async function wireTwoFactor() {
  const disabledView = document.getElementById("twofa-disabled-view");
  const enabledView = document.getElementById("twofa-enabled-view");
  const statusText = document.getElementById("twofa-status-text");
  const startBtn = document.getElementById("twofa-start-setup-btn");
  const setupPanel = document.getElementById("twofa-setup-panel");
  const qrImg = document.getElementById("twofa-qr");
  const secretText = document.getElementById("twofa-secret-text");
  const enableCodeInput = document.getElementById("twofa-enable-code");
  const setupError = document.getElementById("twofa-setup-error");
  const confirmBtn = document.getElementById("twofa-confirm-enable-btn");
  const disablePasswordInput = document.getElementById("twofa-disable-password");
  const disableError = document.getElementById("twofa-disable-error");
  const disableBtn = document.getElementById("twofa-disable-btn");

  async function refreshStatus() {
    const { enabled } = await fetchJson("/api/auth/2fa/status");
    disabledView.style.display = enabled ? "none" : "block";
    enabledView.style.display = enabled ? "block" : "none";
    if (!enabled) statusText.textContent = "Status: not enabled";
  }

  startBtn.addEventListener("click", async () => {
    startBtn.disabled = true;
    try {
      const res = await fetch("/api/auth/2fa/setup", { method: "POST", credentials: "same-origin" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      qrImg.src = data.qrCodeDataUrl;
      secretText.textContent = "Manual entry code: " + data.secret;
      setupPanel.style.display = "block";
    } catch (err) {
      alert(err.message);
    } finally {
      startBtn.disabled = false;
    }
  });

  confirmBtn.addEventListener("click", async () => {
    setupError.style.display = "none";
    confirmBtn.disabled = true;
    try {
      const res = await fetch("/api/auth/2fa/enable", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: enableCodeInput.value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      setupPanel.style.display = "none";
      await refreshStatus();
    } catch (err) {
      setupError.textContent = err.message;
      setupError.style.display = "block";
    } finally {
      confirmBtn.disabled = false;
    }
  });

  disableBtn.addEventListener("click", async () => {
    disableError.style.display = "none";
    disableBtn.disabled = true;
    try {
      const res = await fetch("/api/auth/2fa/disable", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: disablePasswordInput.value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      disablePasswordInput.value = "";
      await refreshStatus();
    } catch (err) {
      disableError.textContent = err.message;
      disableError.style.display = "block";
    } finally {
      disableBtn.disabled = false;
    }
  });

  refreshStatus();
}

document.addEventListener("DOMContentLoaded", async () => {
  const user = await Auth.currentUser();

  document.getElementById("logged-out-message").style.display = user ? "none" : "block";
  document.getElementById("logged-in-content").style.display = user ? "block" : "none";

  if (!user) return;

  wireDepositModal();
  wireWithdrawModal();
  wirePinForms();
  wireTwoFactor();
  renderBalancePage();
});
