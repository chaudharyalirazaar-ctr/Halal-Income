// script.js
// This site is intentionally light on JavaScript — most of the interactivity
// (mobile menu, FAQ accordion) is handled with plain HTML/CSS above, since
// that's more robust and easier to read while you're still learning.
// The two small things JS is actually needed for are here:

// Escapes a value before it goes into an innerHTML string.
//
// Several pages build table rows and cards as HTML strings from API data, and
// a lot of that data is chosen by users: their own name, a support ticket
// body, a payment reference, an admin's rejection reason. Interpolated raw,
// any of those can inject markup and run script in whoever is viewing the
// page — which for the admin panel means a visitor's input executing in a
// super admin's session. Defined here because script.js loads before every
// other script on every page, so this is available everywhere.
//
// Use it on any value that came from a person. It's unnecessary (but
// harmless) on server-computed numbers, dates and enum-ish status strings.
function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 1. Auto-fill the footer's copyright year, so you never have to update it by hand.
document.getElementById("year").textContent = new Date().getFullYear();

// 2. Close the mobile menu automatically after someone taps a link in it.
const navToggle = document.getElementById("nav-toggle");
const navLinks = document.querySelectorAll(".main-nav a");

navLinks.forEach((link) => {
  link.addEventListener("click", () => {
    navToggle.checked = false;
  });
});
