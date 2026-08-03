import https from "node:https";
import { URL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { randomBytes } from "node:crypto";

import { CookieJar } from "../cookieJar.mjs";
import { codeChallengeFor, decodeJwtPayload, generateCodeVerifier } from "../pkce.mjs";
import {
  generateTOTP,
  msUntilNextTotpWindow,
  recordServerTimeFromHeaders,
} from "../totp.mjs";
import { primeViaLevnetLogin, primeCookieJar } from "../browserPrimer.mjs";

const TENANT_ID = "7b410031-6333-4080-9e61-afdbd57b3bd9";
const AUTH_BASE = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize`;
const TOKEN_ENDPOINT = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
const MS_LOGIN_HOST = "login.microsoftonline.com";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.3 Safari/605.1.15";

export class SilentLoginError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SilentLoginError";
    this.details = details;
  }
}

/**
 * Run the JCT Microsoft silent-login flow for an OAuth client and return the
 * site cookie header plus, if `pkce: true`, an id_token / refresh_token pair
 * captured via a post-flight /authorize that we redeem ourselves.
 */
export async function silentLogin({
  email,
  password,
  mfaSeed,
  clientId,
  redirectUri,
  finalHost,
  cookieMatcher,
  scope = "openid profile email",
  forcePrompt = false,
  pkce = true,
  tokenScope = "openid profile email offline_access",
} = {}) {
  if (!email || !password || !mfaSeed) {
    throw new SilentLoginError("Email, password, and TOTP seed are required for silent login.");
  }
  if (!clientId || !redirectUri || !finalHost) {
    throw new SilentLoginError("clientId, redirectUri and finalHost are required for silent login.");
  }

  const jar = new CookieJar();

  // Step 0a: hit the Levnet login page so the SPA bootstrap registers a
  // proper ASP.NET session (including the antiforgery / state-store cookies
  // a browser would have when calling the API).
  await jarRequest(`https://${finalHost}/Login/Login.aspx`, {
    method: "GET",
    jar,
    headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
  }).catch(() => {});

  // Step 0b: ask Levnet for an authorize URL bound to a fresh server-side
  // session (it embeds state + PKCE code_challenge that Levnet later
  // validates when redeeming the OAuth code).
  const initiateUrl = `https://${finalHost}/api/home/login.ashx?action=GetMicrosoftAuthorizeUrl&nocache=${Date.now()}`;
  const initiateResponse = await jarRequest(initiateUrl, {
    method: "GET",
    jar,
    headers: { Accept: "application/json" },
  });
  let levnetAuthorizeUrl;
  try {
    levnetAuthorizeUrl = JSON.parse(initiateResponse.text)?.authorizeUrl;
  } catch {
    throw new SilentLoginError("Levnet did not return a parseable authorizeUrl JSON body.", {
      stage: "initiate",
      statusCode: initiateResponse.statusCode,
    });
  }
  if (!levnetAuthorizeUrl) {
    throw new SilentLoginError("Levnet GetMicrosoftAuthorizeUrl returned no authorizeUrl.", {
      stage: "initiate",
      body: initiateResponse.text.slice(0, 200),
    });
  }
  if (process.env.LEVNET_DEBUG === "1") {
    const lev = jar.toJSON().filter((c) => c.domain.includes("levnet")).map((c) => `${c.name}=${c.value.slice(0,20)}`);
    console.error(`[silentLogin] got Levnet authorize URL; jar levnet cookies: ${lev.join(" | ")}`);
    const stateMatch = levnetAuthorizeUrl.match(/state=([^&]+)/);
    console.error(`[silentLogin] authorize URL state=${stateMatch?.[1]?.slice(0,20)}`);
  }

  const initUrl = levnetAuthorizeUrl
    + (forcePrompt ? "&prompt=login" : "")
    + `&login_hint=${encodeURIComponent(email)}&domain_hint=jct.ac.il`;

  // A disposable browser runs the MS /authorize page so the JS engine accumulates the
  // session cookies (brcap, esctx, fpc, x-ms-gateway-slice, ...) that mark
  // the client as a real browser. Without those, the subsequent /login POST
  // is rejected at the password step. We then continue the flow over plain
  // HTTP using the rendered HTML's canary/ctx/flowToken plus the harvested
  // cookie jar.
  const t0 = Date.now();
  if (process.env.LEVNET_DEBUG === "1") console.error(`[silentLogin] priming MS authorize via browser runtime`);
  const primed = await primeViaLevnetLogin(initUrl, { timeoutMs: 45000 });
  if (process.env.LEVNET_DEBUG === "1") {
    console.error(`[silentLogin] primed finalUrl=${primed.finalUrl.slice(0, 120)}`);
    const lev = primed.cookies.filter((c) => (c.domain || "").includes("levnet")).map((c) => c.name);
    const ms = primed.cookies.filter((c) => (c.domain || "").includes("microsoftonline")).map((c) => c.name);
    console.error(`[silentLogin] primed cookies levnet=${lev.join(",")} ms=${ms.join(",")}`);
  }
  // CRITICAL: do not prime Levnet cookies from the disposable browser. It might
  // have triggered a second GetMicrosoftAuthorizeUrl call by landing on
  // Login.aspx, which would have replaced the server-side code_verifier.
  // We use the Levnet cookies from our own GetMicrosoftAuthorizeUrl call
  // (already in the jar) for state continuity.
  const msOnlyCookies = primed.cookies.filter((c) => (c.domain || "").includes("microsoftonline"));
  primeCookieJar(jar, msOnlyCookies);
  const initResponse = {
    url: primed.finalUrl,
    text: primed.html,
    statusCode: 200,
    headers: {},
  };
  recordServerTimeFromHeaders(initResponse.headers, t0);

  if (initResponse.url.includes(finalHost) && initResponse.url.includes("code=")) {
    return finalize({ jar, finalHost, cookieMatcher, clientId, redirectUri, tokenScope, email, pkce });
  }

  let tokens = extractTokens(initResponse.text);
  if (!tokens.ctx || !tokens.flowToken) {
    throw new SilentLoginError("Could not extract Azure AD ctx/flowToken from /authorize page.", {
      finalUrl: initResponse.url,
      statusCode: initResponse.statusCode,
    });
  }

  const rawLoginUrl = tokens.config?.urlPost || `https://login.microsoftonline.com/${TENANT_ID}/login`;
  const loginUrl = rawLoginUrl.startsWith("http")
    ? rawLoginUrl
    : new URL(rawLoginUrl, "https://login.microsoftonline.com").href;
  const loginBody = new URLSearchParams({
    login: email,
    loginfmt: email,
    passwd: password,
    canary: tokens.canary || "",
    ctx: tokens.ctx,
    flowToken: tokens.flowToken,
    PPFT: tokens.flowToken,
    type: "11",
    LoginOptions: "1",
    i13: "0",
    i19: "5000",
    ps: "2",
    psRNGCDefaultType: "",
    psRNGCEntropy: "",
    psRNGCSLK: "",
    hpgrequestid: tokens.hpgRequestId || "",
    i2: "",
    i17: "",
    i18: "",
  }).toString();

  const loginResponse = await jarRequest(loginUrl, {
    method: "POST",
    jar,
    body: loginBody,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: initResponse.url,
      Origin: "https://login.microsoftonline.com",
    },
  });

  if (loginResponse.text.includes("AADSTS")) {
    const message = loginResponse.text.match(/"strServiceExceptionMessage":"([^"]+)"/)?.[1] || "Unknown Azure AD error";
    throw new SilentLoginError(`Azure AD rejected the login: ${message}`, { stage: "password" });
  }

  if (
    /<form[^>]+action=/i.test(loginResponse.text) &&
    /(SAMLResponse|id_token|code)/i.test(loginResponse.text)
  ) {
    await submitFormAndFollow(loginResponse.text, jar, loginResponse.url);
    return finalize({ jar, finalHost, cookieMatcher, clientId, redirectUri, tokenScope, email, pkce });
  }

  tokens = extractTokens(loginResponse.text, tokens);
  const proofs = tokens.config?.arrUserProofs;
  if (!proofs) {
    throw new SilentLoginError("Login did not advance past credentials. Check email/password.", {
      stage: "password",
      finalUrl: loginResponse.url,
    });
  }
  if (!proofs.some((p) => p.authMethodId === "PhoneAppOTP")) {
    throw new SilentLoginError(
      `PhoneAppOTP MFA method is not enabled. Available: ${proofs.map((p) => p.authMethodId).join(", ")}`,
      { stage: "mfa-discovery" },
    );
  }

  const beginAuthUrl = tokens.config?.urlBeginAuth || "https://login.microsoftonline.com/common/SAS/BeginAuth";
  const beginAuthResponse = await jarRequest(beginAuthUrl, {
    method: "POST",
    jar,
    body: JSON.stringify({
      AuthMethodId: "PhoneAppOTP",
      Method: "BeginAuth",
      Ctx: tokens.ctx,
      FlowToken: tokens.flowToken,
    }),
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      Accept: "application/json",
      canary: tokens.canary || "",
      Referer: `https://login.microsoftonline.com/${TENANT_ID}/login`,
    },
  });

  const beginAuth = tryParseJson(beginAuthResponse.text);
  if (!beginAuth?.Success) {
    throw new SilentLoginError(`BeginAuth failed: ${beginAuth?.Message ?? "no body"} (code ${beginAuth?.ErrCode ?? "n/a"})`, {
      stage: "begin-auth",
    });
  }
  if (!beginAuth.SessionId) {
    throw new SilentLoginError("BeginAuth did not return a SessionId.", { stage: "begin-auth" });
  }
  if (beginAuth.FlowToken) {
    tokens.flowToken = beginAuth.FlowToken;
  }
  const sessionId = beginAuth.SessionId;

  const endAuthUrl = tokens.config?.urlEndAuth || "https://login.microsoftonline.com/common/SAS/EndAuth";
  let endAuthData = await postEndAuth({
    url: endAuthUrl,
    jar,
    canary: tokens.canary,
    body: {
      AuthMethodId: "PhoneAppOTP",
      Method: "EndAuth",
      SessionId: sessionId,
      FlowToken: tokens.flowToken,
      Ctx: tokens.ctx,
      AdditionalAuthData: generateTOTP(mfaSeed),
      PollCount: 1,
      request: tokens.ctx,
    },
  });

  if (!endAuthData.Success && [500027, 500028, 0, 500121].includes(endAuthData.ErrCode)) {
    await sleep(msUntilNextTotpWindow());
    endAuthData = await postEndAuth({
      url: endAuthUrl,
      jar,
      canary: tokens.canary,
      body: {
        AuthMethodId: "PhoneAppOTP",
        Method: "EndAuth",
        SessionId: sessionId,
        FlowToken: tokens.flowToken,
        Ctx: tokens.ctx,
        AdditionalAuthData: generateTOTP(mfaSeed),
        PollCount: 1,
        request: tokens.ctx,
      },
    });
  }

  if (!endAuthData.Success) {
    if (
      endAuthData.ErrCode === 500082 ||
      /OathCodeIncorrect|InvalidOTP/i.test(endAuthData.Message ?? "")
    ) {
      throw new SilentLoginError("MFA TOTP code was rejected. The stored seed may be out of sync.", {
        stage: "end-auth",
        errCode: endAuthData.ErrCode,
      });
    }
    throw new SilentLoginError(`EndAuth failed: ${endAuthData.Message} (code ${endAuthData.ErrCode})`, {
      stage: "end-auth",
    });
  }
  if (!endAuthData.FlowToken) {
    throw new SilentLoginError("EndAuth did not return a FlowToken.", { stage: "end-auth" });
  }
  tokens.flowToken = endAuthData.FlowToken;

  const processAuthUrl = tokens.config?.urlPost || "https://login.microsoftonline.com/common/SAS/ProcessAuth";
  const processBody = new URLSearchParams({
    ctx: tokens.ctx,
    canary: tokens.canary || "",
    flowToken: tokens.flowToken,
    hpgrequestid: tokens.hpgRequestId || "",
    request: tokens.ctx,
  }).toString();

  const processResponse = await jarRequest(processAuthUrl, {
    method: "POST",
    jar,
    body: processBody,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `https://login.microsoftonline.com/${TENANT_ID}/login`,
    },
    // Stop at Levnet so we can grab the OAuth ?code= ourselves before
    // Levnet's Login.aspx does a one-time consume of it.
    stopAtHost: finalHost,
  });

  if (process.env.LEVNET_DEBUG === "1") {
    console.error(`[silentLogin] processAuth → ${processResponse.statusCode} ${processResponse.url} redirectLocation=${processResponse.redirectLocation || "(none)"}`);
  }

  // The redirect target ("Location" header from MS or the in-flight redirect
  // we stopped on once it pointed at finalHost) carries the OAuth ?code=.
  // Prefer redirectLocation; fall back to processResponse.url if MS already
  // returned a finalHost URL inline.
  const codeBearingUrl = processResponse.redirectLocation || processResponse.url;
  if (!codeBearingUrl.includes(finalHost)) {
    if (/<form[^>]+action=/i.test(processResponse.text)) {
      await submitFormAndFollow(processResponse.text, jar, processResponse.url);
    } else {
      throw new SilentLoginError(`Auth chain did not reach ${finalHost}. Final URL: ${processResponse.url}`, {
        stage: "process-auth",
        statusCode: processResponse.statusCode,
      });
    }
  }

  const codeUrl = new URL(codeBearingUrl);
  const oauthCode = codeUrl.searchParams.get("code");
  if (!oauthCode) {
    throw new SilentLoginError("ProcessAuth landed on Levnet but no OAuth code was found in the URL.", {
      stage: "extract-code",
      url: processResponse.url,
    });
  }
  if (process.env.LEVNET_DEBUG === "1") {
    const lev = jar.toJSON().filter((c) => c.domain.includes("levnet")).map((c) => `${c.name}=${c.value.slice(0,20)}`);
    console.error(`[silentLogin] pre-validate jar levnet cookies: ${lev.join(" | ")}`);
    console.error(`[silentLogin] code prefix: ${oauthCode.slice(0, 80)}...`);
    console.error(`[silentLogin] callback state=${codeUrl.searchParams.get("state")?.slice(0,20)}`);
    console.error(`[silentLogin] redeeming OAuth code via ValidateMicrosoftToken`);
  }

  // Redeem the code with Levnet directly. Levnet's Login.aspx GET callback
  // does not authenticate the session by itself; the authenticated session
  // is established by POSTing the code to the ValidateMicrosoftToken handler.
  // Levnet's frontend passes code/state/session_state on the URL (because
  // when the SPA picks them up from window.location.search and forwards them
  // through its API wrapper, the framework promotes those keys to query
  // params). Body is just the short non-URL fields. Matching this exactly
  // is what makes Levnet's exception path NOT fire and the actual code
  // exchange to MS succeed.
  const callbackState = codeUrl.searchParams.get("state");
  const callbackSessionState = codeUrl.searchParams.get("session_state");
  const validateParams = new URLSearchParams({
    action: "ValidateMicrosoftToken",
    code: oauthCode,
    ...(callbackState ? { state: callbackState } : {}),
    ...(callbackSessionState ? { session_state: callbackSessionState } : {}),
    nocache: String(Date.now()),
  });
  const validateUrl = `https://${finalHost}/api/home/login.ashx?${validateParams}`;
  const initialLevnetToken = jar.toJSON().find((c) => c.name === "X-LevNet-Token" && c.domain.includes("levnet.jct.ac.il"))?.value;
  const validateResponse = await jarRequest(validateUrl, {
    method: "POST",
    jar,
    body: JSON.stringify({ defaultLanguage: "" }),
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
      "X-Requested-With": "XMLHttpRequest",
      ...(initialLevnetToken ? { "X-LevNet-Token": initialLevnetToken } : {}),
      Origin: `https://${finalHost}`,
      Referer: `https://${finalHost}/Login/Login.aspx?code=${encodeURIComponent(oauthCode.slice(0, 20))}`,
    },
  });
  if (process.env.LEVNET_DEBUG === "1") {
    console.error(`[silentLogin] ValidateMicrosoftToken → ${validateResponse.statusCode} body: ${validateResponse.text.slice(0, 200)}`);
    const lev = jar.toJSON().filter((c) => c.domain.includes("levnet")).map((c) => c.name);
    console.error(`[silentLogin] post-validate Levnet cookies: ${lev.join(",")}`);
  }
  if (validateResponse.statusCode !== 200) {
    throw new SilentLoginError(`ValidateMicrosoftToken returned ${validateResponse.statusCode}.`, {
      stage: "validate-token",
      body: validateResponse.text.slice(0, 300),
    });
  }

  return finalize({ jar, finalHost, cookieMatcher, clientId, redirectUri, tokenScope, email, pkce });
}

/**
 * Use saved Microsoft SSO cookies to mint a fresh site cookie via
 * /authorize?prompt=none — no password / TOTP required. Throws if the MS
 * session has also expired.
 */
export async function silentRenew({
  msSsoCookies,
  email,
  clientId,
  redirectUri,
  finalHost,
  cookieMatcher,
  scope = "openid profile email",
  tokenScope = "openid profile email offline_access",
  pkce = true,
} = {}) {
  if (!Array.isArray(msSsoCookies) || msSsoCookies.length === 0) {
    throw new SilentLoginError("No saved Microsoft SSO cookies — silent renew is not possible.");
  }
  if (!clientId || !redirectUri || !finalHost) {
    throw new SilentLoginError("clientId, redirectUri and finalHost are required for silent renew.");
  }

  const jar = CookieJar.fromJSON(msSsoCookies);
  const baseQuery = buildAuthorizeQuery({ clientId, redirectUri, scope });

  const initUrl =
    `${AUTH_BASE}?${baseQuery}&prompt=none` +
    (email ? `&login_hint=${encodeURIComponent(email)}` : "") +
    `&domain_hint=jct.ac.il`;

  const response = await jarRequest(initUrl, { method: "GET", jar });

  if (!response.url.includes(finalHost)) {
    if (/login_required|interaction_required|consent_required/i.test(response.text || response.url)) {
      throw new SilentLoginError("Microsoft SSO session has expired — full silent login required.", {
        stage: "renew-prompt-none",
        finalUrl: response.url,
      });
    }
    throw new SilentLoginError(`Silent renew did not reach ${finalHost}. Final URL: ${response.url}`, {
      stage: "renew-prompt-none",
    });
  }

  return finalize({ jar, finalHost, cookieMatcher, clientId, redirectUri, tokenScope, email, pkce });
}

async function finalize({ jar, finalHost, cookieMatcher, clientId, redirectUri, tokenScope, email, pkce }) {
  const cookieHeader = collectCookies(jar, finalHost, cookieMatcher);
  const msSsoCookies = jar
    .toJSON()
    .filter((c) => c.domain === MS_LOGIN_HOST || c.domain.endsWith(`.${MS_LOGIN_HOST}`));

  let tokens = null;
  let idClaims = null;

  if (pkce) {
    try {
      const captured = await captureTokens({ jar, clientId, redirectUri, finalHost, scope: tokenScope, email });
      tokens = captured.tokens;
      idClaims = captured.idClaims;
    } catch (error) {
      // Token capture is best-effort — the cookie itself is the source of truth.
      tokens = { error: error instanceof Error ? error.message : String(error) };
      idClaims = null;
    }
  }

  return { cookieHeader, msSsoCookies, tokens, idClaims };
}

async function captureTokens({ jar, clientId, redirectUri, finalHost, scope, email }) {
  const verifier = generateCodeVerifier();
  const challenge = codeChallengeFor(verifier);
  const state = randomBytes(16).toString("hex");
  const nonce = randomBytes(16).toString("hex");

  const query =
    buildAuthorizeQuery({ clientId, redirectUri, scope }) +
    `&prompt=none&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256` +
    `&state=${encodeURIComponent(state)}&nonce=${encodeURIComponent(nonce)}` +
    (email ? `&login_hint=${encodeURIComponent(email)}` : "") +
    `&domain_hint=jct.ac.il`;

  const url = `${AUTH_BASE}?${query}`;
  const response = await jarRequest(url, { method: "GET", jar, stopAtHost: finalHost });

  const location = response.redirectLocation || response.headers.location;
  if (!location) {
    throw new SilentLoginError("Post-flight /authorize did not redirect — token capture failed.", {
      stage: "post-flight",
      statusCode: response.statusCode,
    });
  }
  const parsed = new URL(location, "https://placeholder/");
  const code = parsed.searchParams.get("code");
  const errorParam = parsed.searchParams.get("error");
  const returnedState = parsed.searchParams.get("state");
  if (errorParam) {
    throw new SilentLoginError(`Post-flight /authorize returned error=${errorParam}`, {
      stage: "post-flight",
      description: parsed.searchParams.get("error_description"),
    });
  }
  if (!code) {
    throw new SilentLoginError("Post-flight /authorize did not include an auth code.", { stage: "post-flight" });
  }
  if (returnedState && returnedState !== state) {
    throw new SilentLoginError("Post-flight state mismatch — possible CSRF.", { stage: "post-flight" });
  }

  const tokenBody = new URLSearchParams({
    client_id: clientId,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    scope,
  }).toString();

  const tokenResponse = await rawHttpsJson(new URL(TOKEN_ENDPOINT), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": DEFAULT_USER_AGENT,
    },
    body: tokenBody,
    timeoutMs: 30000,
  });

  if (tokenResponse.statusCode >= 400) {
    const json = tryParseJson(tokenResponse.body);
    throw new SilentLoginError(`Token endpoint returned ${tokenResponse.statusCode}: ${json?.error ?? "error"}`, {
      stage: "token",
      description: json?.error_description,
    });
  }

  const json = tryParseJson(tokenResponse.body);
  if (!json) {
    throw new SilentLoginError("Token endpoint returned non-JSON.", { stage: "token" });
  }
  if (json.error) {
    throw new SilentLoginError(`Token endpoint error: ${json.error}`, {
      stage: "token",
      description: json.error_description,
    });
  }

  const tokens = {
    accessToken: json.access_token ?? null,
    idToken: json.id_token ?? null,
    refreshToken: json.refresh_token ?? null,
    tokenType: json.token_type ?? null,
    expiresIn: json.expires_in ?? null,
    scope: json.scope ?? null,
    issuedAt: Date.now(),
  };
  const idClaims = json.id_token ? decodeJwtPayload(json.id_token) : null;

  return { tokens, idClaims };
}

async function postEndAuth({ url, jar, canary, body }) {
  const response = await jarRequest(url, {
    method: "POST",
    jar,
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      Accept: "application/json",
      canary: canary || "",
      Referer: `https://login.microsoftonline.com/${TENANT_ID}/login`,
      hpgid: "1104",
      hpgact: "1800",
    },
  });
  const parsed = tryParseJson(response.text);
  if (!parsed) {
    throw new SilentLoginError("EndAuth returned a non-JSON response.", { stage: "end-auth" });
  }
  return parsed;
}

async function submitFormAndFollow(html, jar, currentUrl) {
  const actionMatch = html.match(/<form[^>]+action="([^"]+)"/i);
  if (!actionMatch) {
    return;
  }
  const action = decodeHtmlAttr(actionMatch[1]);
  const inputs = extractFormInputs(html);
  const targetUrl = new URL(action, currentUrl).toString();
  const debug = process.env.LEVNET_DEBUG === "1";
  if (debug) console.error(`[silentLogin] submitFormAndFollow → POST ${targetUrl}`);
  const resp = await jarRequest(targetUrl, {
    method: "POST",
    jar,
    body: new URLSearchParams(inputs).toString(),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  if (debug) {
    const cookieDump = jar.toJSON().filter((c) => c.domain.includes("levnet")).map((c) => `${c.name}@${c.domain}${c.path}`);
    console.error(`[silentLogin] submitFormAndFollow → ${resp.statusCode} ${resp.url} levnetCookies=${JSON.stringify(cookieDump)}`);
    console.error(`[silentLogin]   body head: ${resp.text.slice(0, 600).replace(/\s+/g, " ")}`);
    // If the body has yet another auto-submit form (id_token bridge → real Login.aspx), recurse.
    if (/<form[^>]+action=/i.test(resp.text) && /(SAMLResponse|id_token|code|name="?wa"?)/i.test(resp.text)) {
      console.error(`[silentLogin]   body has another form → recursing`);
    }
  }
  // Some MS → Levnet bridges emit a second auto-submit form; chase it once more.
  if (/<form[^>]+action=/i.test(resp.text) && /(SAMLResponse|id_token|code|name="?wa"?|name="?ReturnUrl"?)/i.test(resp.text)) {
    const innerAction = resp.text.match(/<form[^>]+action="([^"]+)"/i);
    if (innerAction) {
      const innerInputs = extractFormInputs(resp.text);
      const innerUrl = new URL(decodeHtmlAttr(innerAction[1]), resp.url).toString();
      if (debug) console.error(`[silentLogin] chained POST → ${innerUrl} inputs=${Object.keys(innerInputs).join(",")}`);
      const r2 = await jarRequest(innerUrl, {
        method: "POST",
        jar,
        body: new URLSearchParams(innerInputs).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      if (debug) console.error(`[silentLogin]   chained → ${r2.statusCode} ${r2.url}`);
    }
  }
}

function buildAuthorizeQuery({ clientId, redirectUri, scope }) {
  return (
    `client_id=${encodeURIComponent(clientId)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(scope)}`
  );
}

function collectCookies(jar, finalHost, cookieMatcher) {
  const header = jar.toCookieHeaderForHost(finalHost);
  if (!header) {
    throw new SilentLoginError(`Login finished but no cookies landed for ${finalHost}.`, { stage: "collect" });
  }
  if (cookieMatcher && !cookieMatcher.test(header)) {
    throw new SilentLoginError(
      `Login finished for ${finalHost} but the expected session cookie was missing.`,
      { stage: "collect", cookieNames: header.split(";").map((p) => p.trim().split("=")[0]) },
    );
  }
  return header;
}

// ---------------------------------------------------------------------------
// HTML / JSON helpers
// ---------------------------------------------------------------------------

function extractTokens(html, previous = {}) {
  const config = extractMicrosoftConfig(html);
  let ctx = previous.ctx ?? "";
  let flowToken = previous.flowToken ?? "";
  let canary = previous.canary ?? "";
  let hpgRequestId = previous.hpgRequestId ?? "";

  if (config) {
    if (config.sCtx) ctx = config.sCtx;
    if (config.sFT) flowToken = config.sFT;
    if (config.canary) canary = config.canary;
    if (config.hpgRequestId) hpgRequestId = config.hpgRequestId;
  } else {
    ctx = extractParam(html, "sCtx") ?? extractParam(html, "ctx") ?? ctx;
    flowToken = extractParam(html, "sFT") ?? extractParam(html, "flowToken") ?? flowToken;
    canary = extractParam(html, "canary") ?? canary;
  }
  return { ctx, flowToken, canary, hpgRequestId, config };
}

function extractMicrosoftConfig(html) {
  const match = html.match(/\$Config\s*=\s*(\{[\s\S]+?\});\s*(?:\/\/|<\/script>|\n)/);
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function extractParam(html, name) {
  const patterns = [
    new RegExp(`['"]?${name}['"]?\\s*:\\s*['"]([^'"]+)['"]`),
    new RegExp(`name=['"]?${name}['"]?\\s+value=['"]([^'"]+)['"]`),
    new RegExp(`value=['"]([^'"]+)['"]\\s+name=['"]?${name}['"]?`),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      return m[1];
    }
  }
  return null;
}

function extractFormInputs(html) {
  const inputs = {};
  const r1 = /<input[^>]+name="([^"]+)"[^>]+value="([^"]*)"/gi;
  const r2 = /<input[^>]+value="([^"]*)"[^>]+name="([^"]+)"/gi;
  let m;
  while ((m = r1.exec(html)) !== null) {
    inputs[m[1]] = decodeHtmlAttr(m[2]);
  }
  while ((m = r2.exec(html)) !== null) {
    if (!Object.prototype.hasOwnProperty.call(inputs, m[2])) {
      inputs[m[2]] = decodeHtmlAttr(m[1]);
    }
  }
  return inputs;
}

function decodeHtmlAttr(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&#x2B;/g, "+")
    .replace(/&#x3D;/g, "=")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Low-level request with cookie-jar + redirect handling
// ---------------------------------------------------------------------------

async function jarRequest(urlOrString, options, depth = 0) {
  if (depth > 12) {
    throw new SilentLoginError("Too many redirects during silent login.");
  }

  const url = typeof urlOrString === "string" ? new URL(urlOrString) : urlOrString;
  const jar = options.jar;
  const headers = {
    "User-Agent": DEFAULT_USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9,he;q=0.8",
    Accept: options.headers?.Accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    ...options.headers,
  };

  const cookieHeader = jar.cookieHeaderFor(url.toString());
  if (cookieHeader) {
    headers.Cookie = cookieHeader;
  }

  const body = options.body ? Buffer.from(options.body) : null;
  if (body && !headers["Content-Length"]) {
    headers["Content-Length"] = String(body.length);
  }

  const response = await rawHttps(url, {
    method: options.method || "GET",
    headers,
    body,
    timeoutMs: options.timeoutMs ?? 30000,
  });

  if (response.headers["set-cookie"]) {
    jar.setFromResponse(url.toString(), response.headers["set-cookie"]);
  }

  const status = response.statusCode;
  const location = response.headers.location;
  if ([301, 302, 303, 307, 308].includes(status) && location) {
    const nextUrl = new URL(location, url);
    if (options.stopAtHost && nextUrl.hostname === options.stopAtHost) {
      return {
        statusCode: status,
        headers: response.headers,
        text: response.body.toString("utf8"),
        url: url.toString(),
        redirectLocation: nextUrl.toString(),
      };
    }
    const preserveMethod = status === 307 || status === 308;
    const nextHeaders = { ...options.headers };
    if (!preserveMethod) {
      delete nextHeaders["Content-Type"];
      delete nextHeaders["Content-Length"];
    }
    return jarRequest(
      nextUrl,
      {
        ...options,
        method: preserveMethod ? options.method || "GET" : "GET",
        body: preserveMethod ? options.body : null,
        headers: nextHeaders,
      },
      depth + 1,
    );
  }

  return {
    statusCode: status,
    headers: response.headers,
    text: response.body.toString("utf8"),
    url: url.toString(),
  };
}

function rawHttps(url, options) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: options.method,
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        headers: options.headers,
        rejectUnauthorized: url.hostname.endsWith(".jct.ac.il") ? false : true,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );

    req.on("error", reject);
    req.setTimeout(options.timeoutMs, () => req.destroy(new Error("Silent login request timed out.")));

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

function rawHttpsJson(url, options) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: options.method,
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        headers: options.headers,
        rejectUnauthorized: true,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(options.timeoutMs ?? 30000, () => req.destroy(new Error("Token request timed out.")));
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}
