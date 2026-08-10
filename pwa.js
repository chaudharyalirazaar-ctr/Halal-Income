// pwa.js
//
// Registers the service worker (sw.js) on every page and shows a small,
// unobtrusive "Install app" pill when the browser thinks the site is
// installable. Injected as a floating button rather than wired into each
// page's header markup — that would mean editing all 15 HTML files' nav
// structure by hand; this way, adding the feature to a page is just the
// <script src="pwa.js"></script> tag plus the manifest/icon <link> tags in
// <head> (see index.html for the reference set).
(function () {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch((err) => {
        // Non-fatal — the site works fine without the service worker, it
        // just won't be installable/offline-capable. Most likely cause in
        // practice: running over plain HTTP instead of HTTPS/localhost.
        console.warn("Service worker registration failed:", err);
      });
    });
  }

  // Already running as an installed app (standalone display mode) — no
  // point offering to install what's already installed.
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true; // iOS Safari's own flag

  if (isStandalone) return;

  let deferredPrompt = null;

  function injectButton() {
    if (document.getElementById("pwa-install-btn")) return;
    const btn = document.createElement("button");
    btn.id = "pwa-install-btn";
    btn.type = "button";
    btn.textContent = "📲 Install app";
    btn.setAttribute("aria-label", "Install Halal Income as an app");
    Object.assign(btn.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      zIndex: "9999",
      background: "#1F4A3D",
      color: "#F1EDE1",
      border: "none",
      borderRadius: "999px",
      padding: "10px 18px",
      fontSize: "0.9rem",
      fontFamily: "Inter, sans-serif",
      boxShadow: "0 4px 14px rgba(0,0,0,0.25)",
      cursor: "pointer",
    });
    btn.addEventListener("click", async () => {
      if (!deferredPrompt) return;
      btn.disabled = true;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      btn.remove();
    });
    document.body.appendChild(btn);
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // suppress the browser's default mini-infobar
    deferredPrompt = e;
    if (document.body) injectButton();
    else document.addEventListener("DOMContentLoaded", injectButton);
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    const btn = document.getElementById("pwa-install-btn");
    if (btn) btn.remove();
  });
})();
