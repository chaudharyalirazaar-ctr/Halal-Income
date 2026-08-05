// script.js
// This site is intentionally light on JavaScript — most of the interactivity
// (mobile menu, FAQ accordion) is handled with plain HTML/CSS above, since
// that's more robust and easier to read while you're still learning.
// The two small things JS is actually needed for are here:

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
