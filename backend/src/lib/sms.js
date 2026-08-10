// Thin SMS-sending helper via Twilio. Same "optional feature" pattern as
// lib/mailer.js's Resend integration and ANTHROPIC_API_KEY for the AI
// assistant: if Twilio isn't configured, every call just logs to the
// console instead of failing, so the rest of the app never has to know or
// care whether real SMS is wired up.
//
// To turn on real SMS: sign up at https://www.twilio.com, buy/verify a
// sending number, and set TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN +
// TWILIO_FROM_NUMBER in backend/.env.

function isConfigured() {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);
}

// to is the recipient's phone number as stored on their account (see
// PHONE_RE in routes/auth.js) — loosely validated at signup, not
// necessarily in strict E.164 form, so a malformed number is just an
// api_error from Twilio here rather than something this function itself
// tries to normalize.
async function sendSms({ to, body }) {
  if (!to) return { sent: false, reason: "no_phone" };

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;

  if (!sid || !token || !from) {
    console.log(`[sms] (Twilio not configured — not actually sent) To: ${to} | Body: ${body}`);
    return { sent: false, reason: "not_configured" };
  }

  try {
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
    });

    if (!res.ok) {
      const responseBody = await res.text().catch(() => "");
      console.error(`[sms] Twilio API error (${res.status}): ${responseBody}`);
      return { sent: false, reason: "api_error" };
    }

    return { sent: true };
  } catch (err) {
    console.error("[sms] Failed to send SMS:", err.message);
    return { sent: false, reason: "network_error" };
  }
}

module.exports = { sendSms, isConfigured };
