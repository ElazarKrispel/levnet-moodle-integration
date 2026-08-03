import { parseCookieHeader, cookieNames } from "./cookie.mjs";
import { discoverEndpoints } from "./discovery.mjs";
import { redactSensitive, stripHtml } from "../format.mjs";
import { downloadLevnetFile, levnetRequest } from "./http.mjs";
import {
  buildOperationRequest,
  getLevnetOperation,
  listLevnetCapabilities,
  parseOperationResponse,
} from "./registry.mjs";
import {
  deleteCookieFromKeychain,
  deleteCredentialsFromKeychain,
  deleteMsSsoCookiesFromKeychain,
  deleteTokensFromKeychain,
  keychainLocation,
  readCookieFromKeychain,
  readCredentialsFromKeychain,
  readMsSsoCookiesFromKeychain,
  readTokensFromKeychain,
  saveCookieToKeychain,
  saveCredentialsToKeychain,
  saveMsSsoCookiesToKeychain,
  saveTokensToKeychain,
} from "./keychain.mjs";
import { promptForCookie, promptForCredentials } from "./prompt.mjs";
import { silentLogin, silentRenew, SilentLoginError } from "./silentLogin.mjs";
import { z } from "zod";

const BASE_URL = "https://levnet.jct.ac.il";
const LEVNET_LOGIN_CONFIG = Object.freeze({
  clientId: "5cbad4f9-ce9f-441b-9aff-0ebca7eaa39e",
  redirectUri: "https://levnet.jct.ac.il/Login/Login.aspx",
  finalHost: "levnet.jct.ac.il",
  cookieMatcher: /(?:^|;\s*)(X-LevNet-Token|ASP\.NET_SessionId)=/,
  // Levnet is a confidential web client and redeems its own authorization
  // code server-side. A second public-client redemption always fails with
  // invalid_client and is neither required for the authenticated session nor
  // used for confirmed-action account binding.
  pkce: false,
});
const accountBindingResponse = z.object({
  success: z.boolean().optional(),
  details: z.object({
    ownerKeyNumber: z.union([z.string().min(1), z.number().int().nonnegative()]),
    idNumber: z.union([z.string().min(1), z.number().int().nonnegative(), z.null()]).optional(),
    passportNumber: z.union([z.string().min(1), z.number().int().nonnegative(), z.null()]).optional(),
  }).passthrough(),
}).passthrough();

export class LevnetSessionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "LevnetSessionError";
    this.details = details;
  }
}

export async function setupCredentials({ email, password, mfaSeed, prompt = true } = {}) {
  let creds = email && password && mfaSeed ? { email, password, mfaSeed } : null;
  if (!creds) {
    if (!prompt) {
      throw new LevnetSessionError("Credentials are required (email, password, mfaSeed).");
    }
    creds = await promptForCredentials({ reason: "Set up automatic JCT Levnet sign-in." });
  }

  await saveCredentialsToKeychain(creds);
  const result = await runSilentLogin(creds);
  await persistLoginResult(result);
  const status = await validateCookie(result.cookieHeader);
  if (!status.authenticated) {
    throw new LevnetSessionError("Saved credentials, but the resulting cookie was not accepted by Levnet.", status);
  }

  return {
    saved: true,
    source: "silent-login",
    authenticated: true,
    title: status.title,
    landingUrl: status.url,
    cookieNames: cookieNames(result.cookieHeader),
    tokensCaptured: tokensCapturedSummary(result.tokens),
    identity: identityFromClaims(result.idClaims),
    keychain: keychainLocation(),
  };
}

export async function refreshCookie({ cookie, prompt = true } = {}) {
  if (cookie) {
    const parsed = parseCookieHeader(cookie);
    if (!parsed) {
      throw new LevnetSessionError("The provided cookie value did not contain a usable Levnet Cookie header.");
    }
    await saveCookieToKeychain(parsed);
    const status = await validateCookie(parsed);
    if (!status.authenticated) {
      throw new LevnetSessionError("Saved cookie, but Levnet did not accept it.", status);
    }
    return {
      saved: true,
      source: "manual",
      authenticated: true,
      title: status.title,
      landingUrl: status.url,
      cookieNames: cookieNames(parsed),
      keychain: keychainLocation(),
    };
  }

  const renewed = await tryRenew();
  if (renewed) {
    return renewed;
  }

  const creds = await readCredentialsFromKeychain();
  if (creds) {
    const result = await runSilentLogin(creds);
    await persistLoginResult(result);
    const status = await validateCookie(result.cookieHeader);
    if (!status.authenticated) {
      throw new LevnetSessionError("Silent login completed but Levnet did not accept the new cookie.", status);
    }
    return {
      saved: true,
      source: "silent-login",
      authenticated: true,
      title: status.title,
      landingUrl: status.url,
      cookieNames: cookieNames(result.cookieHeader),
      tokensCaptured: tokensCapturedSummary(result.tokens),
      identity: identityFromClaims(result.idClaims),
      keychain: keychainLocation(),
    };
  }

  if (!prompt) {
    throw new LevnetSessionError("No Levnet credentials are stored. Run setupCredentials first.");
  }

  return setupCredentials({ prompt: true });
}

export async function sessionStatus({ promptIfExpired = false } = {}) {
  const cookie = await readCookieFromKeychain();
  if (cookie) {
    const status = await validateCookie(cookie);
    if (status.authenticated) {
      const tokens = await readTokensFromKeychain();
      return {
        ...status,
        identity: identityFromTokens(tokens),
        renewable: Boolean(await readMsSsoCookiesFromKeychain()),
      };
    }
  }

  if (!promptIfExpired) {
    return {
      authenticated: false,
      reason: cookie ? "expired_cookie" : "missing_cookie",
      hasCredentials: Boolean(await readCredentialsFromKeychain()),
      renewable: Boolean(await readMsSsoCookiesFromKeychain()),
      keychain: keychainLocation(),
    };
  }

  return refreshCookie({ prompt: true });
}

export async function ensureSession({ promptIfExpired = true } = {}) {
  let cookie = await readCookieFromKeychain();
  if (cookie) {
    const status = await validateCookie(cookie);
    if (status.authenticated) {
      return { cookie, status };
    }
  }

  const renewed = await tryRenewRaw();
  if (renewed) {
    cookie = renewed.cookieHeader;
    const status = await validateCookie(cookie);
    if (status.authenticated) {
      return { cookie, status };
    }
  }

  const creds = await readCredentialsFromKeychain();
  if (creds) {
    const result = await runSilentLogin(creds);
    await persistLoginResult(result);
    cookie = result.cookieHeader;
    const status = await validateCookie(cookie);
    if (!status.authenticated) {
      throw new LevnetSessionError("Silent login completed but Levnet did not accept the new cookie.", status);
    }
    return { cookie, status };
  }

  if (!promptIfExpired) {
    throw new LevnetSessionError("Levnet session is not authenticated and no credentials are stored.", {
      keychain: keychainLocation(),
    });
  }

  const setup = await setupCredentials({ prompt: true });
  cookie = await readCookieFromKeychain();
  return { cookie, status: setup };
}

export async function clearStoredSession({ alsoCredentials = false } = {}) {
  await Promise.all([deleteCookieFromKeychain(), deleteTokensFromKeychain()]);
  if (alsoCredentials) {
    await Promise.all([deleteCredentialsFromKeychain(), deleteMsSsoCookiesFromKeychain()]);
  }
  return { cleared: true, alsoCredentials, keychain: keychainLocation() };
}

export async function validateCookie(cookie) {
  const response = await levnetRequest("/Student/WeeklySchedule.aspx", {
    cookie,
    followRedirects: false,
  });
  const location = response.headers.location ?? null;
  const text = response.text ?? "";
  const title = extractTitle(text);
  const redirectedToLogin = response.statusCode >= 300 && response.statusCode < 400 && /\/Login\/Login\.aspx/i.test(location ?? "");
  const rejected = /Request Rejected/i.test(text);
  const loginPage = /התחברות למערכת|Sign in|Microsoft|\/Login\/Login\.aspx/i.test(text);
  const authenticated = response.statusCode === 200 && !redirectedToLogin && !rejected && !loginPage;

  return {
    authenticated,
    statusCode: response.statusCode,
    title,
    url: response.url,
    location: redactSensitive(location),
    cookieNames: cookieNames(cookie),
    rejected,
    redirectedToLogin,
    keychain: keychainLocation(),
  };
}

export async function endpointInventory() {
  return discoverEndpoints();
}

export async function capabilities({ kind } = {}) {
  return {
    source: "manual-reviewed-allowlist",
    executableFromDiscovery: false,
    operations: listLevnetCapabilities({ kind }),
  };
}

export async function readOperation({ operationId, input = {} } = {}) {
  const operation = getLevnetOperation(operationId, "read");
  const request = buildOperationRequest(operation, input);
  return withReadSessionRetry(async (cookie) => {
    const response = await levnetRequest(request.url, {
      method: request.method,
      cookie,
      body: request.body,
      followRedirects: false,
      headers: apiHeaders(),
    });
    if (isAuthenticationResponse(response)) return { authenticationRequired: true, response };
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new LevnetSessionError(`Levnet read failed with HTTP ${response.statusCode}.`, {
        operationId,
        statusCode: response.statusCode,
      });
    }
    const parsed = tryParseJson(response.text);
    if (!parsed) throw new LevnetSessionError("Levnet read returned non-JSON.", { operationId, statusCode: response.statusCode });
    return {
      operation: { id: operation.id, version: operation.version },
      data: parseOperationResponse(operation, parsed),
    };
  });
}

export async function downloadOperation({ operationId, input = {}, outputDir, fileName, overwrite = false } = {}) {
  const operation = getLevnetOperation(operationId, "download");
  const request = buildOperationRequest(operation, input);
  return withReadSessionRetry(async (cookie) => {
    try {
      const downloaded = await downloadLevnetFile({
        pathOrUrl: request.url,
        cookie,
        outputDir,
        fileName,
        overwrite,
        allowedOrigins: operation.redirects,
        headers: { Referer: `${BASE_URL}/Student/Default.aspx` },
      });
      return {
        operation: { id: operation.id, version: operation.version },
        downloaded: parseOperationResponse(operation, downloaded),
      };
    } catch (error) {
      if (error?.code === "LEVNET_AUTH_REQUIRED") return { authenticationRequired: true, error };
      throw error;
    }
  });
}

/**
 * Return only the stable identifiers needed to bind a confirmed action to the
 * authenticated Levnet account. The full personal-details response contains
 * sensitive contact data and is deliberately neither returned nor persisted.
 */
export async function readAccountBindingMaterial() {
  return withReadSessionRetry(async (cookie) => {
    const response = await levnetRequest("/api/common/personalDetails.ashx?action=LoadData", {
      method: "POST",
      cookie,
      body: "{}",
      followRedirects: false,
      headers: {
        ...apiHeaders(),
        Referer: `${BASE_URL}/Student/PersonalDetails.aspx`,
      },
    });
    if (isAuthenticationResponse(response)) return { authenticationRequired: true, response };
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new LevnetSessionError(`Levnet account identity failed with HTTP ${response.statusCode}.`, {
        statusCode: response.statusCode,
      });
    }
    const parsed = tryParseJson(response.text);
    if (!parsed) throw new LevnetSessionError("Levnet account identity returned non-JSON.");
    const validated = accountBindingResponse.parse(parsed);
    if (validated.success === false) {
      throw new LevnetSessionError("Levnet rejected the account identity request.");
    }
    return {
      ownerKeyNumber: String(validated.details.ownerKeyNumber),
      secondaryId: validated.details.idNumber ?? validated.details.passportNumber ?? null,
    };
  });
}

async function withReadSessionRetry(executor) {
  const session = await ensureSession();
  let result = await executor(session.cookie);
  if (!result?.authenticationRequired) return result;
  await refreshCookie({ prompt: false });
  const refreshedCookie = await readCookieFromKeychain();
  result = await executor(refreshedCookie);
  if (result?.authenticationRequired) {
    throw new LevnetSessionError("Levnet rejected the refreshed session.", {
      retryPolicy: "one_refresh_one_retry",
    });
  }
  return result;
}

function isAuthenticationResponse(response) {
  const location = response.headers.location ?? "";
  return [401, 403].includes(response.statusCode)
    || (response.statusCode >= 300 && response.statusCode < 400 && /\/Login\/Login\.aspx/i.test(location))
    || (response.statusCode === 200 && /\/Login\/Login\.aspx|Sign in|Microsoft/i.test(response.text));
}

function apiHeaders() {
  return {
    "Content-Type": "application/json;charset=UTF-8",
    "X-Requested-With": "XMLHttpRequest",
    Origin: BASE_URL,
    Referer: `${BASE_URL}/Student/Default.aspx`,
    Accept: "application/json, text/plain, */*",
  };
}

async function runSilentLogin(creds) {
  try {
    return await silentLogin({ ...creds, ...LEVNET_LOGIN_CONFIG });
  } catch (error) {
    if (error instanceof SilentLoginError) {
      throw new LevnetSessionError(`Silent login failed: ${error.message}`, error.details);
    }
    throw error;
  }
}

async function tryRenewRaw() {
  const msSso = await readMsSsoCookiesFromKeychain();
  if (!msSso) {
    return null;
  }
  const creds = await readCredentialsFromKeychain();
  try {
    const result = await silentRenew({
      msSsoCookies: msSso,
      email: creds?.email,
      ...LEVNET_LOGIN_CONFIG,
    });
    await persistLoginResult(result);
    return result;
  } catch (error) {
    if (error instanceof SilentLoginError) {
      return null;
    }
    throw error;
  }
}

async function tryRenew() {
  const result = await tryRenewRaw();
  if (!result) {
    return null;
  }
  const status = await validateCookie(result.cookieHeader);
  if (!status.authenticated) {
    return null;
  }
  return {
    saved: true,
    source: "silent-renew",
    authenticated: true,
    title: status.title,
    landingUrl: status.url,
    cookieNames: cookieNames(result.cookieHeader),
    tokensCaptured: tokensCapturedSummary(result.tokens),
    identity: identityFromClaims(result.idClaims),
    keychain: keychainLocation(),
  };
}

async function persistLoginResult(result) {
  await saveCookieToKeychain(result.cookieHeader);
  if (Array.isArray(result.msSsoCookies) && result.msSsoCookies.length > 0) {
    await saveMsSsoCookiesToKeychain(result.msSsoCookies);
  }
  if (result.tokens && !result.tokens.error) {
    await saveTokensToKeychain({
      ...result.tokens,
      idClaims: result.idClaims,
    });
  }
}

function tokensCapturedSummary(tokens) {
  if (!tokens) return false;
  if (tokens.error) return { error: tokens.error };
  return {
    hasIdToken: Boolean(tokens.idToken),
    hasAccessToken: Boolean(tokens.accessToken),
    hasRefreshToken: Boolean(tokens.refreshToken),
    expiresIn: tokens.expiresIn ?? null,
    scope: tokens.scope ?? null,
  };
}

function identityFromClaims(claims) {
  if (!claims) return null;
  return {
    name: claims.name ?? null,
    email: claims.preferred_username ?? claims.email ?? null,
    tid: claims.tid ?? null,
    oid: claims.oid ?? claims.sub ?? null,
  };
}

function identityFromTokens(tokens) {
  if (!tokens?.idClaims) return null;
  return identityFromClaims(tokens.idClaims);
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractTitle(html) {
  return stripHtml(String(html).match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "");
}

export { promptForCookie };
