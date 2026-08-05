// verify.js
//
// Talks to the real backend for both verification levels:
//   Level 1 (email): POST /api/verify/send-code, POST /api/verify/confirm-code
//   Level 2 (KYC):   POST /api/verify/kyc (multipart file upload)
// Status for both levels comes from GET /api/verify/status. KYC review is
// manual — an admin approves or rejects the upload (backend/src/routes/admin.js)
// before kyc becomes "verified".

async function getVerificationStatus() {
  const res = await fetch("/api/verify/status", { credentials: "same-origin" });
  if (!res.ok) return { email: false, kyc: "none" };
  return res.json();
}

async function renderVerifyPage() {
  const emailStatusEl = document.getElementById("email-status");
  const kycStatusEl = document.getElementById("kyc-status");
  const kycCard = document.getElementById("kyc-card");
  const kycLockedNote = document.getElementById("kyc-locked-note");
  const kycForm = document.getElementById("kyc-form");
  if (!emailStatusEl) return; // not on the verify page

  const dict = (typeof translations !== "undefined" && translations[localStorage.getItem("siteLang") || "en"]) || {};
  const t = (key, fallback) => dict[key] || fallback;

  const status = await getVerificationStatus();

  emailStatusEl.textContent = status.email
    ? t("verify.statusVerified", "Verified")
    : t("verify.statusNotVerified", "Not verified");
  emailStatusEl.className = "verify-status " + (status.email ? "verify-status--done" : "verify-status--pending");

  const kycLabel = { none: "Not verified", pending: "Pending review", verified: "Verified", rejected: "Rejected — resubmit" }[status.kyc] || status.kyc;
  kycStatusEl.textContent = t(`verify.status.${status.kyc}`, kycLabel);
  kycStatusEl.className = "verify-status " + (status.kyc === "verified" ? "verify-status--done" : "verify-status--pending");

  if (status.email) {
    kycCard.classList.remove("verify-card--locked");
    kycLockedNote.style.display = "none";
    kycForm.style.display = status.kyc === "pending" || status.kyc === "verified" ? "none" : "";
  } else {
    kycCard.classList.add("verify-card--locked");
    kycLockedNote.style.display = "";
    kycForm.style.display = "none";
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const user = await Auth.currentUser();
  if (!user) return; // not logged in; nothing to verify

  await renderVerifyPage();

  const sendCodeBtn = document.getElementById("send-code-btn");
  const codeStep = document.getElementById("email-verify-form");
  const emailForm = document.getElementById("email-verify-form");
  const kycForm = document.getElementById("kyc-form");

  if (sendCodeBtn) {
    sendCodeBtn.addEventListener("click", async () => {
      sendCodeBtn.disabled = true;
      try {
        const res = await fetch("/api/verify/send-code", { method: "POST", credentials: "same-origin" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to send code.");
        codeStep.style.display = "";
        sendCodeBtn.style.display = "none";
        if (data.devCode) console.log("Dev mode — verification code:", data.devCode);
      } catch (err) {
        alert(err.message);
        sendCodeBtn.disabled = false;
      }
    });
  }

  if (emailForm) {
    emailForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = emailForm.querySelector("input[type=text]").value;
      try {
        const res = await fetch("/api/verify/confirm-code", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to verify code.");
        await renderVerifyPage();
      } catch (err) {
        alert(err.message);
      }
    });
  }

  if (kycForm) {
    kycForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fileInput = kycForm.querySelector("input[type=file]");
      if (!fileInput.files[0]) return;

      const formData = new FormData();
      formData.append("document", fileInput.files[0]);

      try {
        const res = await fetch("/api/verify/kyc", {
          method: "POST",
          credentials: "same-origin",
          body: formData,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to submit document.");
        await renderVerifyPage();
      } catch (err) {
        alert(err.message);
      }
    });
  }
});
