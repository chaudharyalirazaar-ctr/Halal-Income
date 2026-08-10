// idle-logout.js — admin.html only.
//
// The admin panel approves deposits/withdrawals and moves real money, so a
// logged-in browser left unattended is a real exposure. After 3 minutes with
// no mouse/keyboard/touch activity, this logs the admin out automatically —
// with a 30-second warning first, so a genuinely-still-reading admin isn't
// yanked out mid-review.
//
// Gated on auth.js's "authready" event (fired after /api/auth/me resolves)
// so this never starts a countdown for a logged-out visitor.
(function () {
  const IDLE_LIMIT_MS = 3 * 60 * 1000; // 3 minutes
  const WARNING_LEAD_MS = 30 * 1000; // show the warning 30s before logout

  let idleTimer = null;
  let warnTimer = null;
  let countdownInterval = null;
  let modal = null;
  let lastReset = 0;

  function buildModal() {
    if (modal) return modal;
    const overlay = document.createElement("div");
    overlay.className = "invest-modal-overlay";
    overlay.id = "idle-logout-overlay";
    overlay.innerHTML =
      '<div class="invest-modal">' +
      "<h3>Still there?</h3>" +
      '<p class="invest-modal-note">' +
      "You've been inactive for a while. For security, this admin session will " +
      'log out in <strong id="idle-logout-countdown">30</strong> seconds.' +
      "</p>" +
      '<div class="invest-modal-actions">' +
      '<button type="button" class="btn btn-primary" id="idle-logout-stay-btn">Stay logged in</button>' +
      "</div>" +
      "</div>";
    document.body.appendChild(overlay);
    overlay.querySelector("#idle-logout-stay-btn").addEventListener("click", () => {
      wakeUp();
    });
    modal = overlay;
    return overlay;
  }

  function showWarning() {
    const overlay = buildModal();
    overlay.classList.add("invest-modal-open");
    let remaining = Math.round(WARNING_LEAD_MS / 1000);
    const countdownEl = overlay.querySelector("#idle-logout-countdown");
    countdownEl.textContent = remaining;
    countdownInterval = setInterval(() => {
      remaining -= 1;
      countdownEl.textContent = Math.max(remaining, 0);
      if (remaining <= 0) clearInterval(countdownInterval);
    }, 1000);
  }

  function hideWarning() {
    if (modal) modal.classList.remove("invest-modal-open");
    if (countdownInterval) clearInterval(countdownInterval);
  }

  async function doLogout() {
    hideWarning();
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    } catch {
      // Network error on the way out — redirect anyway, the client-side
      // session is what matters for keeping the panel visibly locked.
    }
    window.location.href = "login.html?reason=idle";
  }

  function scheduleTimers() {
    clearTimeout(idleTimer);
    clearTimeout(warnTimer);
    warnTimer = setTimeout(showWarning, IDLE_LIMIT_MS - WARNING_LEAD_MS);
    idleTimer = setTimeout(doLogout, IDLE_LIMIT_MS);
  }

  function wakeUp() {
    hideWarning();
    scheduleTimers();
    lastReset = Date.now();
  }

  function resetActivity() {
    const now = Date.now();
    if (now - lastReset < 1000) return; // throttle — mousemove fires constantly
    if (modal && modal.classList.contains("invest-modal-open")) {
      wakeUp();
    } else {
      lastReset = now;
      scheduleTimers();
    }
  }

  function start() {
    scheduleTimers();
    ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "wheel"].forEach((evt) =>
      window.addEventListener(evt, resetActivity, { passive: true })
    );
  }

  document.addEventListener("authready", (e) => {
    if (e.detail && e.detail.user) start();
  });
})();
