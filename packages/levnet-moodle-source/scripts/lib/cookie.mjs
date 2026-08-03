const MOODLE_COOKIE_NAME = "MoodleSessiondev";

export function parseMoodleCookie(input) {
  const raw = String(input ?? "").trim();
  if (!raw) {
    return null;
  }

  const headerMatch = raw.match(/(?:^|;\s*)MoodleSessiondev=([^;\s]+)/);
  const value = headerMatch ? headerMatch[1] : raw.replace(/^MoodleSessiondev=/, "");
  const clean = value.trim();

  if (!/^[A-Za-z0-9,_-]+$/.test(clean)) {
    return null;
  }

  return clean;
}

export function cookieHeader(cookieValue) {
  return `${MOODLE_COOKIE_NAME}=${cookieValue}`;
}

export function extractMoodleCookieFromSetCookie(setCookie) {
  const values = Array.isArray(setCookie) ? setCookie : [setCookie].filter(Boolean);

  for (const item of values) {
    const match = String(item).match(/(?:^|,\s*)MoodleSessiondev=([^;\s]+)/);
    if (match) {
      return parseMoodleCookie(match[1]);
    }
  }

  return null;
}
