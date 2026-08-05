const express = require("express");
const rateLimit = require("express-rate-limit");
const Anthropic = require("@anthropic-ai/sdk");

const router = express.Router();

// Public-facing chatbot — no login required, so it's rate-limited per IP to
// bound cost and abuse (each request costs real money against the API key).
const chatLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many messages. Please wait a few minutes and try again." },
});

// Everything below is grounded in the site's own copy (how-it-works.html,
// profit-sharing.html, faq.html, verify.html, balance.html, referral.html).
// Several FAQ answers on the live site are still template placeholders
// ("Replace with your client's real terms...") rather than real answers —
// those topics are listed explicitly as NOT FINALIZED below so the model
// never states them as settled fact.
const SYSTEM_PROMPT = `You are the FAQ assistant for Halal Income, a Shariah-oriented profit-sharing platform tied to a real medicine manufacturing business. You answer visitor questions using ONLY the facts listed below. This is a financial services site, so precision matters more than being helpful-sounding.

CONFIRMED FACTS (safe to state as-is):
- The model: investors contribute capital; that capital funds real production (raw materials, production runs, operating costs) — never used to pay earlier investors.
- A given month's profit is whatever revenue remains after real costs. It is not predetermined and can be $0 in a month with no profit.
- A pre-agreed share of that month's actual profit (typically 6-8%, depending on performance) is distributed to investors; the remainder is retained by the operator.
- There is no fixed or guaranteed monthly percentage — the return moves up or down with actual profit. All investment carries risk, including risk of loss to principal.
- Registering interest does not create an instant self-serve deposit. A real conversation with the team happens first, then an agreed capital amount is committed.
- Accounts have two verification levels: Level 1 is email verification (a 6-digit code); Level 2 is identity verification (KYC, government-issued ID reviewed by the team). KYC (Level 2) is required before withdrawing funds; claiming profit into your balance does not require it.
- The Balance page (after logging in) lists your active investments and that period's profit. "Claim" moves that period's profit into your withdrawable balance. "Withdraw" requests an actual payout, which is reviewed by the team.
- The referral program pays a one-time reward (points) when someone you referred makes their FIRST investment — it is not a multi-level or recruitment-based scheme. Points can be redeemed for USDT; the exact conversion rate shown in the app is illustrative and should be confirmed with the team.

NOT YET FINALIZED — do not state these as settled facts, do not guess, do not invent numbers or claims. If asked, say this specific detail hasn't been published/finalized yet and the team can give the current, accurate answer:
- Whether/when original capital (principal) can be withdrawn, and any notice period or lock-in.
- The exact Shariah-compliance structure (e.g. whether it is Mudarabah, Musharakah, or something else) and whether any scholar or Shariah board has reviewed it.
- Any regulatory registration, license, or legal status.
- The exact referral points-to-USDT conversion rate.

STRICT RULES:
1. Never present a "not yet finalized" item above as if it were decided or confirmed. Do not speculate on a likely answer.
2. Never give personalized investment or financial advice — do not tell a specific visitor whether to invest, how much, or whether it's a good decision for them. If asked, decline briefly and point them to the team for a real conversation.
3. Never invent figures, dates, registration numbers, or promises not listed above.
4. If a question is unrelated to Halal Income or this platform, say briefly that you can only help with questions about Halal Income.
5. Keep answers short — a few sentences. This is a FAQ widget, not a long-form chat.
6. You cannot access the visitor's account, balance, or personal data. For account-specific issues, direct them to log in and check the Balance/Verify pages, or contact the team.`;

router.post("/chat", chatLimiter, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: "The AI assistant isn't configured yet — set ANTHROPIC_API_KEY in backend/.env.",
    });
  }

  const { message, history } = req.body || {};
  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Message is required." });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: "Message is too long." });
  }

  // history is a client-supplied array of {role, content} — trust nothing
  // beyond shape, and cap it so a long session can't balloon the request.
  const priorTurns = Array.isArray(history)
    ? history
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-10)
    : [];

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 1024,
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
      system: SYSTEM_PROMPT,
      messages: [...priorTurns, { role: "user", content: message }],
    });

    if (response.stop_reason === "refusal") {
      return res.json({ reply: "I can't help with that question. Please contact our team directly instead." });
    }

    const reply = response.content.find((b) => b.type === "text")?.text
      || "Sorry, I didn't get a response for that. Please try again.";

    res.json({ reply });
  } catch (err) {
    console.error("[assistant] Anthropic API error:", err.message);
    res.status(502).json({ error: "The AI assistant is temporarily unavailable. Please try again shortly." });
  }
});

module.exports = router;
