export class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  setFromResponse(url, setCookieHeader) {
    if (!setCookieHeader) {
      return;
    }
    const list = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    for (const raw of list) {
      const parsed = parseSetCookie(raw, url);
      if (!parsed) {
        continue;
      }
      const key = `${parsed.domain}|${parsed.path}|${parsed.name}|${parsed.hostOnly ? "h" : "d"}`;
      if (parsed.expired) {
        this.cookies.delete(key);
      } else {
        this.cookies.set(key, parsed);
      }
    }
  }

  cookieHeaderFor(url) {
    const target = new URL(url);
    const now = Date.now();
    const matching = [];
    for (const cookie of this.cookies.values()) {
      if (cookie.expiresMs && cookie.expiresMs <= now) {
        continue;
      }
      if (cookie.secure && target.protocol !== "https:") {
        continue;
      }
      if (!domainMatches(target.hostname, cookie.domain, cookie.hostOnly)) {
        continue;
      }
      if (!pathMatches(target.pathname || "/", cookie.path)) {
        continue;
      }
      matching.push(cookie);
    }
    matching.sort((a, b) => b.path.length - a.path.length);
    return matching.map((c) => `${c.name}=${c.value}`).join("; ");
  }

  filter(predicate) {
    const out = [];
    for (const cookie of this.cookies.values()) {
      if (predicate(cookie)) {
        out.push(cookie);
      }
    }
    return out;
  }

  toCookieHeaderForHost(hostname, { secureOnly = true } = {}) {
    const fakeUrl = `${secureOnly ? "https" : "http"}://${hostname}/`;
    return this.cookieHeaderFor(fakeUrl);
  }

  toJSON() {
    const now = Date.now();
    const out = [];
    for (const cookie of this.cookies.values()) {
      if (cookie.expiresMs && cookie.expiresMs <= now) {
        continue;
      }
      out.push({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        hostOnly: cookie.hostOnly,
        path: cookie.path,
        expiresMs: cookie.expiresMs,
        secure: cookie.secure,
      });
    }
    return out;
  }

  static fromJSON(serialized) {
    const jar = new CookieJar();
    if (!Array.isArray(serialized)) {
      return jar;
    }
    const now = Date.now();
    for (const entry of serialized) {
      if (!entry || !entry.name || !entry.domain || !entry.path) {
        continue;
      }
      if (entry.expiresMs && entry.expiresMs <= now) {
        continue;
      }
      const key = `${entry.domain}|${entry.path}|${entry.name}|${entry.hostOnly ? "h" : "d"}`;
      jar.cookies.set(key, {
        name: entry.name,
        value: entry.value,
        domain: entry.domain,
        hostOnly: Boolean(entry.hostOnly),
        path: entry.path,
        expiresMs: entry.expiresMs ?? null,
        secure: Boolean(entry.secure),
        expired: false,
      });
    }
    return jar;
  }
}

function parseSetCookie(raw, requestUrl) {
  const segments = String(raw).split(";");
  const first = segments.shift();
  if (!first) {
    return null;
  }
  const eq = first.indexOf("=");
  if (eq <= 0) {
    return null;
  }
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) {
    return null;
  }

  const target = new URL(requestUrl);
  let domain = target.hostname.toLowerCase();
  let hostOnly = true;
  let path = defaultPath(target.pathname);
  let expiresMs = null;
  let maxAgeMs = null;
  let secure = false;

  for (const segment of segments) {
    const [rawAttr, ...rest] = segment.split("=");
    const attr = rawAttr.trim().toLowerCase();
    const attrValue = rest.join("=").trim();
    if (!attr) {
      continue;
    }
    if (attr === "domain" && attrValue) {
      const normalized = attrValue.replace(/^\./, "").toLowerCase();
      if (normalized && (target.hostname.toLowerCase() === normalized || target.hostname.toLowerCase().endsWith(`.${normalized}`))) {
        domain = normalized;
        hostOnly = false;
      }
    } else if (attr === "path" && attrValue) {
      path = attrValue.startsWith("/") ? attrValue : defaultPath(target.pathname);
    } else if (attr === "expires" && attrValue) {
      const parsed = Date.parse(attrValue);
      if (Number.isFinite(parsed)) {
        expiresMs = parsed;
      }
    } else if (attr === "max-age" && attrValue) {
      const seconds = Number(attrValue);
      if (Number.isFinite(seconds)) {
        maxAgeMs = Date.now() + seconds * 1000;
      }
    } else if (attr === "secure") {
      secure = true;
    }
  }

  const finalExpiresMs = maxAgeMs ?? expiresMs;
  const expired = finalExpiresMs !== null && finalExpiresMs <= Date.now();

  return {
    name,
    value,
    domain,
    hostOnly,
    path,
    expiresMs: finalExpiresMs,
    secure,
    expired,
  };
}

function defaultPath(pathname) {
  if (!pathname || !pathname.startsWith("/")) {
    return "/";
  }
  const lastSlash = pathname.lastIndexOf("/");
  if (lastSlash <= 0) {
    return "/";
  }
  return pathname.slice(0, lastSlash);
}

function domainMatches(host, cookieDomain, hostOnly) {
  const h = host.toLowerCase();
  const d = cookieDomain.toLowerCase();
  if (hostOnly) {
    return h === d;
  }
  return h === d || h.endsWith(`.${d}`);
}

function pathMatches(requestPath, cookiePath) {
  if (cookiePath === requestPath) {
    return true;
  }
  if (requestPath.startsWith(cookiePath)) {
    if (cookiePath.endsWith("/")) {
      return true;
    }
    if (requestPath.charAt(cookiePath.length) === "/") {
      return true;
    }
  }
  return false;
}
