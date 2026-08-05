// analytics.js
//
// This is an internal admin dashboard. Data comes from the real backend
// (GET /api/analytics, admin-only) aggregated from actual signups and
// investments — see backend/src/routes/analytics.js. Non-admins get a
// "restricted" message instead of the dashboard.

let allRows = [];
let earliestDate = null;
let latestDate = null;

function formatCurrency(n) {
  return "$" + n.toLocaleString();
}

function renderStats(rows) {
  const totalRegistered = rows.reduce((sum, r) => sum + r.registrations, 0);
  const totalInvested = rows.reduce((sum, r) => sum + r.invested, 0);
  const totalEarned = rows.reduce((sum, r) => sum + r.earned, 0);

  document.getElementById("stat-registered").textContent = totalRegistered.toLocaleString();
  document.getElementById("stat-invested").textContent = totalInvested.toLocaleString();
  document.getElementById("stat-earned").textContent = formatCurrency(totalEarned);
}

// Groups daily rows into at most `maxBars` buckets so the chart stays
// readable even when a long date range (like "All time") is selected.
function bucketRows(rows, maxBars) {
  if (rows.length <= maxBars) return rows;

  const bucketSize = Math.ceil(rows.length / maxBars);
  const buckets = [];

  for (let i = 0; i < rows.length; i += bucketSize) {
    const chunk = rows.slice(i, i + bucketSize);
    buckets.push({
      date: chunk[0].date,
      registrations: chunk.reduce((s, r) => s + r.registrations, 0),
      invested: chunk.reduce((s, r) => s + r.invested, 0),
      earned: chunk.reduce((s, r) => s + r.earned, 0),
    });
  }
  return buckets;
}

function renderChart(rows) {
  const svg = document.getElementById("chart-svg");
  svg.innerHTML = ""; // clear previous bars before redrawing

  const bars = bucketRows(rows, 30);
  if (bars.length === 0) return;

  const width = 700;
  const height = 220;
  const paddingBottom = 20;
  const maxVal = Math.max(1, ...bars.map((b) => Math.max(b.registrations, b.invested)));
  const groupWidth = width / bars.length;
  const barWidth = Math.max(3, groupWidth * 0.32);

  bars.forEach((b, i) => {
    const groupX = i * groupWidth;
    const regHeight = (b.registrations / maxVal) * (height - paddingBottom);
    const invHeight = (b.invested / maxVal) * (height - paddingBottom);

    const regBar = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    regBar.setAttribute("x", groupX + groupWidth * 0.15);
    regBar.setAttribute("y", height - paddingBottom - regHeight);
    regBar.setAttribute("width", barWidth);
    regBar.setAttribute("height", regHeight);
    regBar.setAttribute("fill", "#1F4A3D");
    svg.appendChild(regBar);

    const invBar = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    invBar.setAttribute("x", groupX + groupWidth * 0.53);
    invBar.setAttribute("y", height - paddingBottom - invHeight);
    invBar.setAttribute("width", barWidth);
    invBar.setAttribute("height", invHeight);
    invBar.setAttribute("fill", "#B8925A");
    svg.appendChild(invBar);
  });

  // baseline
  const baseline = document.createElementNS("http://www.w3.org/2000/svg", "line");
  baseline.setAttribute("x1", 0);
  baseline.setAttribute("y1", height - paddingBottom);
  baseline.setAttribute("x2", width);
  baseline.setAttribute("y2", height - paddingBottom);
  baseline.setAttribute("stroke", "#DED9C7");
  baseline.setAttribute("stroke-width", "1");
  svg.appendChild(baseline);
}

function renderTable(rows) {
  const body = document.getElementById("analytics-table-body");
  body.innerHTML = "";

  // Most recent day first
  [...rows].reverse().forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + r.date + "</td>" +
      "<td>" + r.registrations + "</td>" +
      "<td>" + r.invested + "</td>" +
      "<td>" + formatCurrency(r.earned) + "</td>";
    body.appendChild(tr);
  });
}

async function fetchRange(fromStr, toStr) {
  // Omitting from/to lets the backend pick its own earliest/latest defaults
  // (based on real data) rather than us guessing a start date here.
  const params = new URLSearchParams();
  if (fromStr) params.set("from", fromStr);
  if (toStr) params.set("to", toStr);
  const qs = params.toString();
  const res = await fetch("/api/analytics" + (qs ? "?" + qs : ""), { credentials: "same-origin" });
  if (!res.ok) throw new Error((await res.json()).error || "Failed to load analytics.");
  return res.json();
}

function renderAll(rows) {
  renderStats(rows);
  renderChart(rows);
  renderTable(rows);
}

function toDateInputValue(date) {
  return date.toISOString().slice(0, 10);
}

function setActiveChip(activeButton) {
  document.querySelectorAll(".chip").forEach((chip) => chip.classList.remove("chip-active"));
  if (activeButton) activeButton.classList.add("chip-active");
}

function showRestrictedMessage() {
  const note = document.querySelector(".analytics-sample-note");
  if (note) {
    note.textContent = "This internal dashboard is only visible to admin accounts. Log in as an admin to view it.";
    note.removeAttribute("data-i18n");
  }
  document.querySelector(".analytics-filters")?.remove();
  document.querySelector(".stat-cards")?.remove();
  document.querySelector(".chart-card")?.remove();
  document.querySelector(".table-card")?.remove();
}

document.addEventListener("DOMContentLoaded", async () => {
  const note = document.querySelector(".analytics-sample-note");
  if (note) {
    note.textContent = "Live data from the database for the selected date range.";
    note.removeAttribute("data-i18n");
  }

  let initial;
  try {
    initial = await fetchRange();
  } catch {
    return showRestrictedMessage();
  }

  earliestDate = initial.earliest;
  latestDate = initial.latest;
  allRows = initial.rows;

  const dateFrom = document.getElementById("date-from");
  const dateTo = document.getElementById("date-to");
  const applyBtn = document.getElementById("apply-range");
  const chips = document.querySelectorAll(".chip");

  dateFrom.value = earliestDate;
  dateTo.value = latestDate;
  renderAll(allRows);

  chips.forEach((chip) => {
    chip.addEventListener("click", async () => {
      setActiveChip(chip);
      const range = chip.dataset.range;

      if (range === "all") {
        dateFrom.value = earliestDate;
        dateTo.value = latestDate;
        renderAll(allRows);
        return;
      }

      const days = parseInt(range, 10);
      const to = new Date(latestDate + "T00:00:00Z");
      const from = new Date(latestDate + "T00:00:00Z");
      from.setUTCDate(from.getUTCDate() - (days - 1));

      dateFrom.value = toDateInputValue(from);
      dateTo.value = toDateInputValue(to);
      const { rows } = await fetchRange(dateFrom.value, dateTo.value);
      renderAll(rows);
    });
  });

  applyBtn.addEventListener("click", async () => {
    if (!dateFrom.value || !dateTo.value) return;
    if (dateFrom.value > dateTo.value) {
      alert("The 'From' date must be before the 'To' date.");
      return;
    }
    setActiveChip(null);
    const { rows } = await fetchRange(dateFrom.value, dateTo.value);
    renderAll(rows);
  });
});
