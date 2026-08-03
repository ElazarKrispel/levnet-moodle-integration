import assert from "node:assert/strict";
import test from "node:test";

import { CookieJar } from "../scripts/lib/cookieJar.mjs";
import { codeChallengeFor, decodeJwtPayload, generateCodeVerifier } from "../scripts/lib/pkce.mjs";
import { base32ToBuffer, generateTOTP } from "../scripts/lib/totp.mjs";

test("base32ToBuffer decodes the canonical RFC 4648 sample", () => {
  // "JBSWY3DPEHPK3PXP" -> bytes "Hello!" followed by 0xDE 0xAD 0xBE 0xEF
  const buffer = base32ToBuffer("JBSWY3DPEHPK3PXP");
  assert.equal(Buffer.from(buffer).toString("hex"), "48656c6c6f21deadbeef");
});

test("generateTOTP matches RFC 6238 SHA1 vectors", () => {
  // Standard RFC 6238 secret 12345678901234567890 -> base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
  const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  // Test vector for time = 59 seconds: 287082
  assert.equal(generateTOTP(seed, { atMs: 59_000, digits: 6 }), "287082");
  // Test vector for time = 1111111109 seconds: 081804
  assert.equal(generateTOTP(seed, { atMs: 1_111_111_109_000, digits: 6 }), "081804");
});

test("CookieJar collects cookies across hosts and emits per-host headers", () => {
  const jar = new CookieJar();
  jar.setFromResponse("https://login.microsoftonline.com/common/oauth2/v2.0/authorize", [
    "ESTSAUTH=token-value; Path=/; Secure; HttpOnly",
    "buid=abc; Path=/; Secure",
  ]);
  jar.setFromResponse("https://levnet.jct.ac.il/Login/Login.aspx", [
    "ASP.NET_SessionId=session-id; Path=/; HttpOnly",
    "X-LevNet-Token=jwt.body.sig; Path=/; HttpOnly",
  ]);

  const msHeader = jar.toCookieHeaderForHost("login.microsoftonline.com");
  assert.match(msHeader, /ESTSAUTH=token-value/);
  assert.match(msHeader, /buid=abc/);
  assert.doesNotMatch(msHeader, /X-LevNet-Token/);

  const levHeader = jar.toCookieHeaderForHost("levnet.jct.ac.il");
  assert.match(levHeader, /ASP\.NET_SessionId=session-id/);
  assert.match(levHeader, /X-LevNet-Token=jwt\.body\.sig/);
  assert.doesNotMatch(levHeader, /ESTSAUTH/);
});

test("CookieJar drops cookies whose Max-Age has elapsed", () => {
  const jar = new CookieJar();
  jar.setFromResponse("https://example.test/", "tmp=1; Max-Age=0");
  assert.equal(jar.toCookieHeaderForHost("example.test"), "");
});

test("CookieJar serializes and restores via toJSON/fromJSON", () => {
  const jar = new CookieJar();
  jar.setFromResponse("https://login.microsoftonline.com/", [
    "ESTSAUTH=abc; Path=/; Secure; HttpOnly; Max-Age=3600",
    "buid=xyz; Path=/; Secure",
  ]);
  const serialized = jar.toJSON();
  assert.ok(Array.isArray(serialized) && serialized.length === 2);

  const restored = CookieJar.fromJSON(serialized);
  const header = restored.toCookieHeaderForHost("login.microsoftonline.com");
  assert.match(header, /ESTSAUTH=abc/);
  assert.match(header, /buid=xyz/);
});

test("CookieJar.fromJSON drops entries that have already expired", () => {
  const past = Date.now() - 1000;
  const restored = CookieJar.fromJSON([
    { name: "stale", value: "v", domain: "example.test", path: "/", hostOnly: true, expiresMs: past, secure: false },
    { name: "fresh", value: "v", domain: "example.test", path: "/", hostOnly: true, expiresMs: null, secure: false },
  ]);
  const header = restored.toCookieHeaderForHost("example.test", { secureOnly: false });
  assert.doesNotMatch(header, /stale/);
  assert.match(header, /fresh/);
});

test("PKCE: codeChallengeFor produces the RFC 7636 sample", () => {
  // RFC 7636 Appendix B: verifier "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
  // -> challenge "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.equal(codeChallengeFor(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("PKCE: generateCodeVerifier returns a base64url string of expected length", () => {
  const v = generateCodeVerifier(64);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(v), "must be base64url");
  assert.ok(v.length >= 43 && v.length <= 128, "RFC 7636 length range");
});

test("decodeJwtPayload parses an unsigned JWT body", () => {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ sub: "u1", preferred_username: "u@x.com", tid: "t1" })).toString("base64url");
  const claims = decodeJwtPayload(`${header}.${body}.`);
  assert.equal(claims.preferred_username, "u@x.com");
  assert.equal(claims.tid, "t1");
});
