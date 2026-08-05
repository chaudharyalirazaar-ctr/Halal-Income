// notifications-ui.js
//
// Injects a notification bell into the shared header nav on every logged-in
// page. Listens for the "authready" event dispatched by auth.js (see
// auth.js) rather than re-fetching the current user itself.

(function () {
  const POLL_INTERVAL_MS = 60 * 1000;
  let pollTimer = null;

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function timeAgo(isoString) {
    const diffMs = Date.now() - new Date(isoString + "Z").getTime();
    const mins = Math.round(diffMs / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return `${days}d ago`;
  }

  function buildBellUI() {
    if (document.getElementById("notif-bell-wrap")) return document.getElementById("notif-bell-wrap");

    const nav = document.querySelector(".main-nav");
    if (!nav) return null;

    const wrap = document.createElement("div");
    wrap.className = "notif-bell-wrap nav-loggedin-only";
    wrap.id = "notif-bell-wrap";
    wrap.innerHTML =
      `<button type="button" id="notif-bell-btn" class="notif-bell-btn" aria-haspopup="true" aria-expanded="false" title="Notifications">
         🔔<span id="notif-bell-badge" class="notif-bell-badge" style="display:none;">0</span>
       </button>
       <div class="notif-bell-menu" id="notif-bell-menu">
         <div class="notif-bell-menu-head">
           <span>Notifications</span>
           <button type="button" id="notif-mark-all-btn">Mark all read</button>
         </div>
         <div id="notif-bell-list"></div>
       </div>`;

    const langSwitch = nav.querySelector(".lang-switch");
    if (langSwitch) nav.insertBefore(wrap, langSwitch);
    else nav.appendChild(wrap);

    return wrap;
  }

  async function fetchNotifications() {
    try {
      const res = await fetch("/api/notifications", { credentials: "same-origin" });
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  function renderList(listEl, notifications) {
    if (!notifications.length) {
      listEl.innerHTML = '<p class="notif-empty">No notifications yet.</p>';
      return;
    }
    listEl.innerHTML = notifications
      .map((n) => {
        const tag = n.link ? "a" : "div";
        const hrefAttr = n.link ? `href="${escapeHtml(n.link)}"` : "";
        return `<${tag} ${hrefAttr} class="notif-item${n.is_read ? "" : " notif-item--unread"}" data-id="${n.id}">
          ${escapeHtml(n.message)}
          <span class="notif-item-time">${timeAgo(n.created_at)}</span>
        </${tag}>`;
      })
      .join("");
  }

  function updateBadge(badgeEl, unreadCount) {
    if (unreadCount > 0) {
      badgeEl.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
      badgeEl.style.display = "inline-block";
    } else {
      badgeEl.style.display = "none";
    }
  }

  async function refresh(wrap) {
    const data = await fetchNotifications();
    if (!data) return;
    renderList(document.getElementById("notif-bell-list"), data.notifications);
    updateBadge(document.getElementById("notif-bell-badge"), data.unreadCount);
  }

  function wire(wrap) {
    const btn = document.getElementById("notif-bell-btn");
    const menu = document.getElementById("notif-bell-menu");
    const markAllBtn = document.getElementById("notif-mark-all-btn");
    const listEl = document.getElementById("notif-bell-list");

    btn.addEventListener("click", () => {
      const isOpen = menu.classList.toggle("notif-bell-menu-open");
      btn.setAttribute("aria-expanded", isOpen ? "true" : "false");
      if (isOpen) refresh(wrap);
    });

    document.addEventListener("click", (e) => {
      if (!wrap.contains(e.target)) {
        menu.classList.remove("notif-bell-menu-open");
        btn.setAttribute("aria-expanded", "false");
      }
    });

    listEl.addEventListener("click", (e) => {
      const item = e.target.closest(".notif-item");
      if (!item) return;
      fetch(`/api/notifications/${item.dataset.id}/read`, { method: "POST", credentials: "same-origin" }).then(() => {
        item.classList.remove("notif-item--unread");
      });
    });

    markAllBtn.addEventListener("click", async () => {
      await fetch("/api/notifications/read-all", { method: "POST", credentials: "same-origin" });
      refresh(wrap);
    });
  }

  document.addEventListener("authready", (e) => {
    if (!e.detail.user) {
      if (pollTimer) clearInterval(pollTimer);
      return;
    }

    const wrap = buildBellUI();
    if (!wrap) return;
    wrap.style.display = "inline-flex";
    wire(wrap);
    refresh(wrap);

    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => refresh(wrap), POLL_INTERVAL_MS);
  });
})();
