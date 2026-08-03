import { createHmac } from "node:crypto";

let _timeOffsetMs = 0;

export function setTimeOffsetMs(offsetMs) {
  _timeOffsetMs = Number.isFinite(offsetMs) ? offsetMs : 0;
}

export function getTimeOffsetMs() {
  return _timeOffsetMs;
}

export function getAccurateTimeMs() {
  return Date.now() + _timeOffsetMs;
}

export function recordServerTimeFromHeaders(headers, requestStartedAtMs) {
  const dateHeader = headers?.date ?? headers?.Date;
  if (!dateHeader) {
    return;
  }
  const serverMs = Date.parse(dateHeader);
  if (!Number.isFinite(serverMs)) {
    return;
  }
  const halfRtt = Math.round((Date.now() - requestStartedAtMs) / 2);
  _timeOffsetMs = serverMs + halfRtt - Date.now();
}

export function base32ToBuffer(base32) {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = String(base32 ?? "").replace(/=+$/, "").replace(/\s/g, "").toUpperCase();
  let bits = "";
  for (const char of cleaned) {
    const value = ALPHABET.indexOf(char);
    if (value === -1) {
      continue;
    }
    bits += value.toString(2).padStart(5, "0");
  }

  const byteCount = Math.floor(bits.length / 8);
  const out = Buffer.alloc(byteCount);
  for (let i = 0; i < byteCount; i++) {
    out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }
  return out;
}

export function generateTOTP(secretBase32, { stepSeconds = 30, digits = 6, atMs } = {}) {
  if (!secretBase32) {
    throw new Error("TOTP secret is empty.");
  }
  const key = base32ToBuffer(secretBase32);
  if (key.length === 0) {
    throw new Error("TOTP secret could not be decoded as base32.");
  }

  const nowMs = Number.isFinite(atMs) ? atMs : getAccurateTimeMs();
  const counter = Math.floor(nowMs / 1000 / stepSeconds);

  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeUInt32BE(0, 0);
  counterBuffer.writeUInt32BE(counter >>> 0, 4);

  const hmac = createHmac("sha1", key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return (binary % 10 ** digits).toString().padStart(digits, "0");
}

export function msUntilNextTotpWindow({ stepSeconds = 30, paddingSeconds = 2 } = {}) {
  const nowSeconds = Math.floor(getAccurateTimeMs() / 1000);
  const remaining = stepSeconds - (nowSeconds % stepSeconds);
  return (remaining + paddingSeconds) * 1000;
}
