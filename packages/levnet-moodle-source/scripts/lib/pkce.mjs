import { randomBytes, createHash } from "node:crypto";

export function generateCodeVerifier(byteLength = 64) {
  return base64url(randomBytes(byteLength));
}

export function codeChallengeFor(verifier) {
  return base64url(createHash("sha256").update(verifier).digest());
}

export function decodeJwtPayload(jwt) {
  if (typeof jwt !== "string") {
    return null;
  }
  const parts = jwt.split(".");
  if (parts.length < 2) {
    return null;
  }
  try {
    const padded = parts[1] + "=".repeat((4 - (parts[1].length % 4)) % 4);
    const buf = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
}

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
