const { authenticator } = require("otplib");
const QRCode = require("qrcode");

const ISSUER = "Halal Income";

function generateSecret() {
  return authenticator.generateSecret();
}

function verifyToken(token, secret) {
  if (!token || !secret) return false;
  try {
    return authenticator.check(String(token).trim(), secret);
  } catch {
    return false;
  }
}

async function qrCodeDataUrl(email, secret) {
  const otpauthUrl = authenticator.keyuri(email, ISSUER, secret);
  return QRCode.toDataURL(otpauthUrl);
}

module.exports = { generateSecret, verifyToken, qrCodeDataUrl };
