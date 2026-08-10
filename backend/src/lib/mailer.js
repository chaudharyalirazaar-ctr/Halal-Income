// Thin email-sending helper. If RESEND_API_KEY isn't set, every call just
// logs to the console (exactly how verification codes and reset links
// behaved before this file existed) so the rest of the app never has to
// know or care whether real email is configured — same "optional feature"
// pattern as ANTHROPIC_API_KEY for the AI assistant.
//
// To turn on real email: sign up free at https://resend.com, verify a
// sending domain (or use their shared onboarding domain for testing), grab
// an API key, and set RESEND_API_KEY + EMAIL_FROM in backend/.env.

const RESEND_API_URL = "https://api.resend.com/emails";

function isConfigured() {
  return Boolean(process.env.RESEND_API_KEY);
}

// subject/html are plain strings; keep templates simple, inline-styled, and
// self-contained since email clients don't load external stylesheets.
// attachments (optional) is Resend's own shape: [{ filename, content }],
// content being a base64 string — used by the scheduled backup email.
async function sendEmail({ to, subject, html, attachments }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "Halal Income <onboarding@resend.dev>";

  if (!apiKey) {
    console.log(`[mailer] (no RESEND_API_KEY set — not actually sent) To: ${to} | Subject: ${subject}`);
    console.log(`[mailer] Body:\n${html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}`);
    if (attachments && attachments.length) {
      console.log(`[mailer] (attachments not sent) ${attachments.map((a) => a.filename).join(", ")}`);
    }
    return { sent: false, reason: "not_configured" };
  }

  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, html, ...(attachments ? { attachments } : {}) }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[mailer] Resend API error (${res.status}): ${body}`);
      return { sent: false, reason: "api_error" };
    }

    return { sent: true };
  } catch (err) {
    console.error("[mailer] Failed to send email:", err.message);
    return { sent: false, reason: "network_error" };
  }
}

// Shared layout wrapper so every email looks consistent without a template engine.
function layout(title, bodyHtml) {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
      <div style="background: #1F4A3D; padding: 20px 24px; border-radius: 12px 12px 0 0;">
        <span style="color: #fff; font-size: 18px; font-weight: 600;">Halal Income</span>
      </div>
      <div style="border: 1px solid #DED9C7; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
        <h2 style="margin-top: 0; font-size: 18px;">${title}</h2>
        ${bodyHtml}
        <p style="margin-top: 28px; font-size: 12px; color: #777;">
          This is an automated message from Halal Income. If you didn't expect it, you can ignore it.
        </p>
      </div>
    </div>
  `;
}

module.exports = { sendEmail, layout, isConfigured };
