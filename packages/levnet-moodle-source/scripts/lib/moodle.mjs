import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseMoodleCookie } from "./cookie.mjs";
import { stripHtml, unixToIso } from "./format.mjs";
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
import { moodleRequest } from "./http.mjs";
import { promptForCookie, promptForCredentials } from "./prompt.mjs";
import { silentLogin, silentRenew, SilentLoginError } from "./silentLogin.mjs";

const BASE_URL = "https://moodle.jct.ac.il";

const MOODLE_LOGIN_CONFIG = Object.freeze({
  clientId: "6774a638-dbe4-4600-9961-603cdd277e84",
  redirectUri: "https://moodle.jct.ac.il/auth/multioauth/login.php?userType=jct",
  finalHost: "moodle.jct.ac.il",
  cookieMatcher: /(?:^|;\s*)MoodleSessiondev=/,
});

export class MoodleSessionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "MoodleSessionError";
    this.details = details;
  }
}

export async function setupCredentials({ email, password, mfaSeed, prompt = true } = {}) {
  let creds = email && password && mfaSeed ? { email, password, mfaSeed } : null;
  if (!creds) {
    if (!prompt) {
      throw new MoodleSessionError("Credentials are required (email, password, mfaSeed).");
    }
    creds = await promptForCredentials({ reason: "Set up automatic JCT Moodle sign-in." });
  }

  await saveCredentialsToKeychain(creds);
  const result = await runSilentLogin(creds);
  await persistLoginResult(result);
  const status = await validateCookie(result.cookieValue);
  if (!status.authenticated) {
    throw new MoodleSessionError("Saved credentials, but the resulting cookie was not accepted by Moodle.", status);
  }

  return {
    saved: true,
    source: "silent-login",
    authenticated: true,
    title: status.title,
    sesskeyFound: status.sesskeyFound,
    tokensCaptured: tokensCapturedSummary(result.tokens),
    identity: identityFromClaims(result.idClaims),
    keychain: keychainLocation(),
  };
}

export async function refreshCookie({ cookie, prompt = true } = {}) {
  if (cookie) {
    const parsed = parseMoodleCookie(cookie);
    if (!parsed) {
      throw new MoodleSessionError("The provided value did not contain a valid MoodleSessiondev cookie.");
    }
    await saveCookieToKeychain(parsed);
    const status = await validateCookie(parsed);
    if (!status.authenticated) {
      throw new MoodleSessionError("Saved cookie, but Moodle did not accept it.", status);
    }
    return {
      saved: true,
      source: "manual",
      authenticated: true,
      title: status.title,
      sesskeyFound: status.sesskeyFound,
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
    const status = await validateCookie(result.cookieValue);
    if (!status.authenticated) {
      throw new MoodleSessionError("Silent login completed but Moodle did not accept the new cookie.", status);
    }
    return {
      saved: true,
      source: "silent-login",
      authenticated: true,
      title: status.title,
      sesskeyFound: status.sesskeyFound,
      tokensCaptured: tokensCapturedSummary(result.tokens),
      identity: identityFromClaims(result.idClaims),
      keychain: keychainLocation(),
    };
  }

  if (!prompt) {
    throw new MoodleSessionError("No JCT Microsoft credentials are stored. Run setupCredentials first.");
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
      return { cookie, sesskey: status.sesskey, status };
    }
  }

  const renewed = await tryRenewRaw();
  if (renewed) {
    cookie = renewed.cookieValue;
    const status = await validateCookie(cookie);
    if (status.authenticated) {
      return { cookie, sesskey: status.sesskey, status };
    }
  }

  const creds = await readCredentialsFromKeychain();
  if (creds) {
    const result = await runSilentLogin(creds);
    await persistLoginResult(result);
    cookie = result.cookieValue;
    const status = await validateCookie(cookie);
    if (!status.authenticated) {
      throw new MoodleSessionError("Silent login completed but Moodle did not accept the new cookie.", status);
    }
    return { cookie, sesskey: status.sesskey, status };
  }

  if (!promptIfExpired) {
    throw new MoodleSessionError("Moodle session is not authenticated and no credentials are stored.", {
      keychain: keychainLocation(),
    });
  }

  const setup = await setupCredentials({ prompt: true });
  cookie = await readCookieFromKeychain();
  const status = await validateCookie(cookie);
  return { cookie, sesskey: status.sesskey, status: { ...status, setup } };
}

export async function clearStoredSession({ alsoCredentials = false } = {}) {
  await Promise.all([deleteCookieFromKeychain(), deleteTokensFromKeychain()]);
  if (alsoCredentials) {
    await Promise.all([deleteCredentialsFromKeychain(), deleteMsSsoCookiesFromKeychain()]);
  }
  return { cleared: true, alsoCredentials, keychain: keychainLocation() };
}

export async function validateCookie(cookie) {
  const response = await moodleRequest("/my/", { cookie });

  if (response.refreshedCookie && response.refreshedCookie !== cookie) {
    await saveCookieToKeychain(response.refreshedCookie);
  }

  const authenticated =
    response.statusCode === 200 &&
    !response.redirectedOutsideMoodle &&
    !/\/login\/index\.php/.test(response.url) &&
    /\/login\/logout\.php|התנתק|Log out/i.test(response.text);

  return {
    authenticated,
    statusCode: response.statusCode,
    title: extractTitle(response.text),
    sesskey: extractSesskey(response.text),
    sesskeyFound: Boolean(extractSesskey(response.text)),
    redirectedOutsideMoodle: response.redirectedOutsideMoodle || null,
    refreshedCookie: response.refreshedCookie || null,
    keychain: keychainLocation(),
  };
}

export async function listCourses({ classification = "all", limit = 0, offset = 0, sort = "fullname" } = {}) {
  const session = await ensureSession();
  const [result] = await ajax(session, [
    {
      index: 0,
      methodname: "core_course_get_enrolled_courses_by_timeline_classification",
      args: {
        classification,
        limit,
        offset,
        sort,
        customfieldname: "",
        customfieldvalue: "",
        requiredfields: ["id", "fullname", "shortname", "summary", "visible", "enddate"],
      },
    },
  ]);

  const courses = result.data?.courses ?? [];
  return {
    count: courses.length,
    nextOffset: result.data?.nextoffset ?? null,
    courses: courses.map((course) => ({
      id: course.id,
      fullname: stripHtml(course.fullname),
      shortname: stripHtml(course.shortname),
      visible: course.visible,
      endDate: unixToIso(course.enddate),
    })),
  };
}

export async function listCalendarEvents({ daysBack = 7, daysAhead = 120, limit = 50 } = {}) {
  const session = await ensureSession();
  const now = Math.floor(Date.now() / 1000);
  const [result] = await ajax(session, [
    {
      index: 0,
      methodname: "core_calendar_get_action_events_by_timesort",
      args: {
        timesortfrom: now - Number(daysBack) * 86400,
        timesortto: now + Number(daysAhead) * 86400,
        limitnum: Math.min(Number(limit), 20),
      },
    },
  ]);

  const events = result.data?.events ?? [];
  return {
    count: events.length,
    events: events.map((event) => ({
      id: event.id,
      name: stripHtml(event.name),
      description: stripHtml(event.description).slice(0, 500),
      timeSort: event.timesort,
      dueAt: unixToIso(event.timesort),
      courseId: event.course?.id ?? event.courseid ?? null,
      courseName: stripHtml(event.course?.fullname ?? ""),
      url: event.url ?? null,
      actionUrl: event.action?.url ?? null,
      actionName: stripHtml(event.action?.name ?? ""),
    })),
  };
}

export async function readAccountBindingMaterial() {
  const session = await ensureSession();
  const response = await moodleRequest("/my/", { cookie: session.cookie });
  if (response.refreshedCookie && response.refreshedCookie !== session.cookie) {
    await saveCookieToKeychain(response.refreshedCookie);
  }
  const userId = extractMoodleUserId(response.text);
  if (response.statusCode !== 200 || !userId) {
    throw new MoodleSessionError("Moodle account identity could not be read from the authenticated session.", {
      statusCode: response.statusCode,
    });
  }
  return { userId };
}

export async function generateCalendarExportUrl({ exportEvents = "all", timePeriod = "recentupcoming" } = {}) {
  if (exportEvents !== "all") throw new MoodleSessionError("Only the reviewed all-events calendar export is supported.");
  if (timePeriod !== "recentupcoming") throw new MoodleSessionError("Only the reviewed recent-and-upcoming calendar period is supported.");

  const session = await ensureSession();
  const body = new URLSearchParams({
    sesskey: session.sesskey,
    _qf__core_calendar_export_form: "1",
    "events[exportevents]": exportEvents,
    "period[timeperiod]": timePeriod,
    generateurl: "1",
  }).toString();
  const response = await moodleRequest("/calendar/export.php", {
    method: "POST",
    cookie: session.cookie,
    body,
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: BASE_URL,
      Referer: `${BASE_URL}/calendar/export.php`,
    },
  });
  if (response.refreshedCookie && response.refreshedCookie !== session.cookie) {
    await saveCookieToKeychain(response.refreshedCookie);
  }
  if (response.statusCode !== 200) {
    throw new MoodleSessionError("Moodle calendar export returned an unexpected response.", {
      statusCode: response.statusCode,
    });
  }
  return extractCalendarExportUrl(response.text);
}

export async function downloadResources({ resources, outputDir } = {}) {
  if (!Array.isArray(resources) || resources.length === 0) {
    throw new MoodleSessionError("Provide at least one Moodle resource to download.");
  }
  if (!outputDir) throw new MoodleSessionError("Provide an output directory.");

  const session = await ensureSession();
  await mkdir(outputDir, { recursive: true });
  const downloaded = [];

  for (const resource of resources) {
    const resourceUrl = new URL(resource.url, BASE_URL);
    if (resourceUrl.hostname !== "moodle.jct.ac.il") {
      throw new MoodleSessionError("Only moodle.jct.ac.il resources can be downloaded.");
    }
    const response = await moodleRequest(resourceUrl.toString(), { cookie: session.cookie, timeoutMs: 60000 });
    const contentType = String(response.headers["content-type"] ?? "");
    if (response.statusCode !== 200 || /text\/html/i.test(contentType) || !response.buffer?.length) {
      throw new MoodleSessionError(`Resource download failed for ${resource.name}.`, {
        statusCode: response.statusCode,
        contentType,
        finalUrl: response.url,
      });
    }

    let safeName = String(resource.name).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
    if (!safeName) throw new MoodleSessionError("Resource filename is empty after sanitization.");
    if (!/\.[A-Za-z0-9]{1,8}$/.test(safeName)) {
      const extension = /pdf/i.test(contentType) ? ".pdf"
        : /wordprocessingml|msword/i.test(contentType) ? ".docx"
          : /zip/i.test(contentType) ? ".zip" : "";
      safeName += extension;
    }
    const path = join(outputDir, safeName);
    await writeFile(path, response.buffer);
    downloaded.push({ name: safeName, path, size: response.buffer.length, contentType });
  }

  return { count: downloaded.length, outputDir, downloaded };
}

export async function getAssignment({ cmid, url } = {}) {
  const session = await ensureSession();
  const id = cmid || extractCmid(url);

  if (!id) {
    throw new MoodleSessionError("Provide a Moodle assignment URL or course module id.");
  }

  const response = await moodleRequest(`/mod/assign/view.php?id=${encodeURIComponent(id)}`, {
    cookie: session.cookie,
  });

  if (response.refreshedCookie && response.refreshedCookie !== session.cookie) {
    await saveCookieToKeychain(response.refreshedCookie);
  }

  const text = stripHtml(response.text);
  return {
    cmid: Number(id),
    statusCode: response.statusCode,
    authenticated: /\/login\/logout\.php|התנתק|Log out/i.test(response.text),
    title: extractTitle(response.text),
    h1: extractFirstHeading(response.text),
    sesskeyFound: Boolean(extractSesskey(response.text)),
    url: `${BASE_URL}/mod/assign/view.php?id=${id}`,
    textPreview: text.slice(0, 3500),
  };
}

async function runSilentLogin(creds) {
  try {
    const result = await silentLogin({ ...creds, ...MOODLE_LOGIN_CONFIG });
    const cookieValue = parseMoodleCookie(result.cookieHeader);
    if (!cookieValue) {
      throw new MoodleSessionError("Silent login finished but no MoodleSessiondev cookie was captured.", {
        cookieHeader: result.cookieHeader,
      });
    }
    return { ...result, cookieValue };
  } catch (error) {
    if (error instanceof SilentLoginError) {
      throw new MoodleSessionError(`Silent login failed: ${error.message}`, error.details);
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
      ...MOODLE_LOGIN_CONFIG,
    });
    const cookieValue = parseMoodleCookie(result.cookieHeader);
    if (!cookieValue) {
      return null;
    }
    const enriched = { ...result, cookieValue };
    await persistLoginResult(enriched);
    return enriched;
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
  const status = await validateCookie(result.cookieValue);
  if (!status.authenticated) {
    return null;
  }
  return {
    saved: true,
    source: "silent-renew",
    authenticated: true,
    title: status.title,
    sesskeyFound: status.sesskeyFound,
    tokensCaptured: tokensCapturedSummary(result.tokens),
    identity: identityFromClaims(result.idClaims),
    keychain: keychainLocation(),
  };
}

async function persistLoginResult(result) {
  await saveCookieToKeychain(result.cookieValue);
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

async function ajax(session, calls) {
  const info = calls.map((call) => call.methodname).join(",");
  const response = await moodleRequest(`/lib/ajax/service.php?sesskey=${session.sesskey}&info=${encodeURIComponent(info)}`, {
    method: "POST",
    cookie: session.cookie,
    body: JSON.stringify(calls),
    headers: {
      Accept: "application/json, text/javascript, */*; q=0.01",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      Origin: BASE_URL,
      Referer: `${BASE_URL}/my/`,
    },
  });

  if (response.refreshedCookie && response.refreshedCookie !== session.cookie) {
    await saveCookieToKeychain(response.refreshedCookie);
  }

  let parsed;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new MoodleSessionError("Moodle AJAX returned non-JSON.", {
      statusCode: response.statusCode,
      textPrefix: response.text.slice(0, 300),
    });
  }

  for (const item of parsed) {
    if (item?.error) {
      throw new MoodleSessionError("Moodle AJAX call failed.", item.exception ?? item);
    }
  }

  return parsed;
}

export function extractSesskey(html) {
  return (
    String(html).match(/"sesskey":"([^"]+)"/)?.[1] ||
    String(html).match(/sesskey=([A-Za-z0-9]+)/)?.[1] ||
    null
  );
}

export function extractMoodleUserId(html) {
  const value =
    String(html).match(/\bdata-userid=["'](\d+)["']/i)?.[1] ||
    String(html).match(/\/user\/(?:profile|view)\.php\?id=(\d+)/i)?.[1] ||
    null;
  return value ? String(value) : null;
}

export function extractCalendarExportUrl(html) {
  const decoded = decodeHtmlEntities(String(html));
  const candidates = [
    ...decoded.matchAll(/https:\/\/moodle\.jct\.ac\.il\/calendar\/export_execute\.php\?[^\s"'<>]+/gi),
  ].map((match) => match[0]);
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (
        url.protocol === "https:" &&
        url.hostname === "moodle.jct.ac.il" &&
        url.pathname === "/calendar/export_execute.php" &&
        /^\d+$/.test(url.searchParams.get("userid") ?? "") &&
        Boolean(url.searchParams.get("authtoken")) &&
        url.searchParams.get("preset_what") === "all" &&
        url.searchParams.get("preset_time") === "recentupcoming"
      ) {
        return url.toString();
      }
    } catch {}
  }
  throw new MoodleSessionError("Moodle did not return a valid calendar export URL. Open Calendar > Export calendar and verify calendar export is enabled.");
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/g, "&")
    .replace(/&#x26;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'");
}

function extractTitle(html) {
  return stripHtml(String(html).match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "");
}

function extractFirstHeading(html) {
  return stripHtml(String(html).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
}

function extractCmid(url) {
  if (!url) {
    return null;
  }

  const match = String(url).match(/[?&]id=(\d+)/);
  return match ? Number(match[1]) : null;
}

export { promptForCookie };
