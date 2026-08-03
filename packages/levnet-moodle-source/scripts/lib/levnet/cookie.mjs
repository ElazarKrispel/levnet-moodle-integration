const REQUIRED_COOKIE_NAMES = ["X-LevNet-Token"];
const OPTIONAL_SESSION_COOKIE_NAMES = ["ASP.NET_SessionId"];

export function parseCookieHeader(input) {
  const raw = String(input ?? "").trim();
  if (!raw) {
    return null;
  }

  const withoutPrefix = raw.replace(/^Cookie:\s*/i, "");
  const cookies = new Map();
  for (const part of withoutPrefix.split(";")) {
    const trimmed = part.trim();
    const idx = trimmed.indexOf("=");
    if (idx <= 0) {
      continue;
    }

    const name = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!name || !value || /[\r\n]/.test(name) || /[\r\n]/.test(value)) {
      continue;
    }

    cookies.set(name, value);
  }

  if (!hasUsableLevnetCookies(cookies)) {
    return null;
  }

  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

export function cookieNames(cookieHeader) {
  return String(cookieHeader ?? "")
    .split(";")
    .map((part) => part.trim().split("=", 1)[0])
    .filter(Boolean)
    .sort();
}

export function hasUsableLevnetCookies(cookies) {
  return (
    REQUIRED_COOKIE_NAMES.every((name) => cookies.has(name)) ||
    OPTIONAL_SESSION_COOKIE_NAMES.some((name) => cookies.has(name))
  );
}

