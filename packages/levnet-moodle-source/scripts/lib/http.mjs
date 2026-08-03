import https from "node:https";
import { URL } from "node:url";

import { cookieHeader, extractMoodleCookieFromSetCookie } from "./cookie.mjs";

const BASE_URL = "https://moodle.jct.ac.il";

export async function moodleRequest(pathOrUrl, options = {}) {
  const url = new URL(pathOrUrl, BASE_URL);
  return requestWithRedirects(url, options, 0);
}

async function requestWithRedirects(url, options, depth) {
  if (depth > 5) {
    throw new Error("Too many Moodle redirects.");
  }

  const response = await rawRequest(url, options);
  const location = response.headers.location;

  if ([301, 302, 303, 307, 308].includes(response.statusCode) && location) {
    const nextUrl = new URL(location, url);
    if (nextUrl.hostname !== "moodle.jct.ac.il") {
      return { ...response, redirectedOutsideMoodle: nextUrl.toString() };
    }

    return requestWithRedirects(nextUrl, { ...options, method: "GET", body: null }, depth + 1);
  }

  return response;
}

function rawRequest(url, options) {
  const body = options.body ? Buffer.from(options.body) : null;
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.3 Safari/605.1.15",
    "Accept-Language": "en-US,en;q=0.9,he;q=0.8",
    ...options.headers,
  };

  if (options.cookie) {
    headers.Cookie = cookieHeader(options.cookie);
  }

  if (body && !headers["Content-Length"]) {
    headers["Content-Length"] = String(body.length);
  }

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: options.method || "GET",
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        headers,
        rejectUnauthorized: url.hostname !== "moodle.jct.ac.il" ? true : false,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          const text = buffer.toString("utf8");
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            buffer,
            text,
            url: url.toString(),
            refreshedCookie: extractMoodleCookieFromSetCookie(res.headers["set-cookie"]),
          });
        });
      },
    );

    req.on("error", reject);
    req.setTimeout(options.timeoutMs || 30000, () => req.destroy(new Error("Moodle request timed out.")));

    if (body) {
      req.write(body);
    }

    req.end();
  });
}
