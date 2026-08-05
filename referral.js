// referral.js
//
// Fetches the logged-in user's real referral data from the backend
// (GET /api/referral) and calls the real redeem endpoint. Redeem creates a
// redemption request for an admin to review and pay out — see
// backend/src/routes/referral.js — it does not send USDT automatically.

async function renderReferralPage() {
  const res = await fetch("/api/referral", { credentials: "same-origin" });
  if (!res.ok) return;
  const { referralCode, referralLink, referrals, count, points, usdt } = await res.json();

  document.getElementById("ref-count").textContent = count;
  document.getElementById("ref-points").textContent = points;
  document.getElementById("ref-usdt").textContent = "$" + usdt;

  const linkInput = document.getElementById("referral-link");
  if (linkInput) linkInput.value = referralLink;
  const codeEl = document.getElementById("referral-code");
  if (codeEl) codeEl.textContent = referralCode;

  const body = document.getElementById("referral-table-body");
  body.innerHTML = "";
  referrals.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${r.name}</td><td>${r.status}</td><td>${r.points}</td>`;
    body.appendChild(tr);
  });
}

async function renderLeaderboard() {
  const res = await fetch("/api/referral/leaderboard", { credentials: "same-origin" });
  if (!res.ok) return;
  const { leaderboard } = await res.json();

  const body = document.getElementById("leaderboard-table-body");
  body.innerHTML = leaderboard.length
    ? ""
    : '<tr><td colspan="4" class="admin-empty">No one has invited an investor yet — be the first!</td></tr>';
  leaderboard.forEach((row) => {
    const tr = document.createElement("tr");
    if (row.isYou) tr.style.fontWeight = "700";
    tr.innerHTML =
      `<td>${row.rank}</td>` +
      `<td>${row.name}${row.isYou ? " (you)" : ""}</td>` +
      `<td>${row.invitedInvestors}</td>` +
      `<td>${row.points}</td>`;
    body.appendChild(tr);
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  const user = await Auth.currentUser();

  document.getElementById("logged-out-message").style.display = user ? "none" : "block";
  document.getElementById("logged-in-content").style.display = user ? "block" : "none";

  if (!user) return;

  await renderReferralPage();
  await renderLeaderboard();

  document.getElementById("copy-link").addEventListener("click", () => {
    const input = document.getElementById("referral-link");
    input.select();
    document.execCommand("copy");
  });

  document.getElementById("redeem-btn").addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      const res = await fetch("/api/referral/redeem", { method: "POST", credentials: "same-origin" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to redeem.");
      alert(data.message);
      await renderReferralPage();
    } catch (err) {
      alert(err.message);
    } finally {
      e.target.disabled = false;
    }
  });
});
