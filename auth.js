// auth.js
//
// Talks to the real backend in backend/ over cookie-based sessions
// (httpOnly JWT cookie set by POST /api/auth/login and /api/auth/signup).
// `Auth.currentUser()` fetches /api/auth/me once and caches the result for
// the rest of the page's lifetime — every other page script (balance.js,
// referral.js, verify.js) should read the logged-in user through it rather
// than querying the API again.

const Auth = (() => {
  let cached = null; // Promise<user|null>, memoized per page load

  async function currentUser() {
    if (!cached) {
      cached = fetch("/api/auth/me", { credentials: "same-origin" })
        .then((r) => (r.ok ? r.json() : { user: null }))
        .then((data) => data.user)
        .catch(() => null);
    }
    return cached;
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    location.href = "index.html";
  }

  return { currentUser, logout };
})();

async function initAuthUI() {
  const user = await Auth.currentUser();
  const loggedIn = !!user;

  // Explicit values (not "") on purpose: an empty string only *clears* an
  // inline style, so if any stylesheet rule sets display:none on these
  // classes, clearing the inline style falls back to that rule and the
  // element stays hidden. Setting a real value always wins.
  document.querySelectorAll(".nav-loggedin-only").forEach((el) => {
    el.style.display = loggedIn ? "inline-flex" : "none";
  });
  document.querySelectorAll(".nav-loggedout-only").forEach((el) => {
    el.style.display = loggedIn ? "none" : "inline-flex";
  });

  const toggleBtn = document.getElementById("demo-login-toggle");
  if (toggleBtn) {
    toggleBtn.textContent = "Log out";
    toggleBtn.addEventListener("click", () => Auth.logout());
  }

  const profileMenu = document.getElementById("profile-menu");
  if (profileMenu && user && user.is_admin && !profileMenu.querySelector(".admin-panel-link")) {
    const adminLink = document.createElement("a");
    adminLink.href = "admin.html";
    adminLink.className = "admin-panel-link";
    adminLink.textContent = "Admin panel";
    profileMenu.appendChild(adminLink);
  }

  document.dispatchEvent(new CustomEvent("authready", { detail: { user } }));
}

function initProfileMenu() {
  const toggle = document.getElementById("profile-toggle");
  const menu = document.getElementById("profile-menu");
  if (!toggle || !menu) return;

  toggle.addEventListener("click", () => {
    const isOpen = menu.classList.toggle("profile-menu-open");
    toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
  });

  document.addEventListener("click", (e) => {
    if (!toggle.contains(e.target) && !menu.contains(e.target)) {
      menu.classList.remove("profile-menu-open");
      toggle.setAttribute("aria-expanded", "false");
    }
  });
}

document.addEventListener("DOMContentLoaded", initProfileMenu);

document.addEventListener("DOMContentLoaded", initAuthUI);
