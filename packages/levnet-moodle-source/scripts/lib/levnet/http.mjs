import { createWriteStream } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, open, rename, unlink } from "node:fs/promises";
import https from "node:https";
import tls from "node:tls";
import { basename, extname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { URL } from "node:url";
import { randomUUID } from "node:crypto";

const BASE_URL = "https://levnet.jct.ac.il";
const DEFAULT_ALLOWED_ORIGINS = Object.freeze([new URL(BASE_URL).origin]);
const DEFAULT_MAX_REDIRECTS = 5;
export const DEFAULT_MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "proxy-authorization", "x-levnet-token"]);

export async function levnetRequest(pathOrUrl, options = {}) {
  const url = validateRequestUrl(new URL(pathOrUrl, BASE_URL), options.allowedOrigins);
  const response = await requestWithRedirects(url, options, 0);
  const buffer = await collectResponse(response.stream, options.maxResponseBytes ?? 20 * 1024 * 1024);
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    text: buffer.toString("utf8"),
    buffer,
    url: response.url,
  };
}

export async function downloadLevnetFile({
  pathOrUrl,
  cookie,
  outputDir,
  fileName,
  overwrite = false,
  allowedOrigins,
  maxBytes = DEFAULT_MAX_DOWNLOAD_BYTES,
  headers = {},
} = {}) {
  if (!pathOrUrl || !outputDir) throw new Error("pathOrUrl and outputDir are required.");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > DEFAULT_MAX_DOWNLOAD_BYTES) {
    throw new Error(`maxBytes must be between 1 and ${DEFAULT_MAX_DOWNLOAD_BYTES}.`);
  }

  const initialUrl = validateRequestUrl(new URL(pathOrUrl, BASE_URL), allowedOrigins);
  const response = await requestWithRedirects(initialUrl, {
    method: "GET",
    cookie,
    headers,
    allowedOrigins,
    followRedirects: true,
    stream: true,
  }, 0);

  if (response.statusCode < 200 || response.statusCode >= 300) {
    response.stream.resume();
    throw Object.assign(new Error(`Levnet download failed with HTTP ${response.statusCode}.`), {
      code: [401, 403].includes(response.statusCode) ? "LEVNET_AUTH_REQUIRED" : "LEVNET_DOWNLOAD_HTTP",
      statusCode: response.statusCode,
    });
  }

  const contentLength = Number(response.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    response.stream.resume();
    throw new Error(`Levnet download exceeds the ${maxBytes}-byte limit.`);
  }

  const peeked = await peekReadable(response.stream);
  const declaredContentType = String(response.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  const contentType = sniffContentType(peeked.prefix) ?? declaredContentType;
  if (!isAllowedDownloadType(contentType)) {
    peeked.stream.resume();
    throw Object.assign(new Error(`Refusing unexpected Levnet download content type: ${contentType || "unknown"}.`), {
      code: looksLikeHtml(peeked.prefix) ? "LEVNET_AUTH_REQUIRED" : "LEVNET_DOWNLOAD_CONTENT_TYPE",
      contentType,
    });
  }

  await mkdir(outputDir, { recursive: true });
  const proposedName = fileName || fileNameFromDisposition(response.headers["content-disposition"]) || basename(new URL(response.url).pathname) || "levnet-download";
  const safeName = withInferredExtension(sanitizeFileName(proposedName), contentType);
  const finalPath = await chooseDestination(outputDir, safeName, overwrite);
  const tempPath = join(outputDir, `.${basename(finalPath)}.${randomUUID()}.part`);
  const limiter = byteLimitTransform(maxBytes);

  try {
    await pipeline(peeked.stream, limiter, createWriteStream(tempPath, { flags: "wx", mode: 0o600 }));
    const handle = await open(tempPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!overwrite) await access(finalPath, fsConstants.F_OK).then(
      () => Promise.reject(Object.assign(new Error(`Destination already exists: ${finalPath}`), { code: "EEXIST" })),
      (error) => {
        if (error?.code !== "ENOENT") throw error;
      },
    );
    await rename(tempPath, finalPath);
    return {
      path: finalPath,
      fileName: basename(finalPath),
      size: limiter.bytesRead(),
      contentType,
      sourceUrl: response.url,
    };
  } catch (error) {
    peeked.stream.destroy();
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

export function validateRequestUrl(url, allowedOrigins = DEFAULT_ALLOWED_ORIGINS) {
  const parsed = url instanceof URL ? url : new URL(url, BASE_URL);
  if (parsed.protocol !== "https:") throw new Error("Levnet requests require HTTPS.");
  const origins = new Set((allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS).map((value) => new URL(value).origin));
  if (!origins.has(parsed.origin)) throw new Error(`Levnet request origin is not allowlisted: ${parsed.origin}`);
  if (parsed.username || parsed.password) throw new Error("Credentials in Levnet URLs are forbidden.");
  return parsed;
}

export function headersForRedirect(headers, fromUrl, toUrl) {
  const sameOrigin = new URL(fromUrl).origin === new URL(toUrl).origin;
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => sameOrigin || !SENSITIVE_HEADERS.has(name.toLowerCase())));
}

async function requestWithRedirects(url, options, depth) {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  if (depth > maxRedirects) throw new Error("Too many Levnet redirects.");
  const response = await rawRequest(url, options);
  const location = response.headers.location;
  if (options.followRedirects !== false && [301, 302, 303, 307, 308].includes(response.statusCode) && location) {
    const nextUrl = validateRequestUrl(new URL(location, url), options.allowedOrigins);
    response.stream.resume();
    const nextHeaders = headersForRedirect(buildHeaders(options), url, nextUrl);
    const preserveMethod = response.statusCode === 307 || response.statusCode === 308;
    return requestWithRedirects(nextUrl, {
      ...options,
      method: preserveMethod ? options.method : "GET",
      body: preserveMethod ? options.body : null,
      cookie: nextUrl.origin === url.origin ? options.cookie : null,
      headers: nextHeaders,
    }, depth + 1);
  }
  return response;
}

function rawRequest(url, options) {
  const body = options.body ? Buffer.from(options.body) : null;
  const headers = buildHeaders(options, body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: options.method || "GET",
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      headers,
      rejectUnauthorized: true,
      ca: trustedCaCertificates(),
    }, (stream) => resolve({
      statusCode: stream.statusCode,
      headers: stream.headers,
      stream,
      url: url.toString(),
    }));
    req.on("error", reject);
    req.setTimeout(options.timeoutMs || 30000, () => req.destroy(Object.assign(new Error("Levnet request timed out."), { code: "ETIMEDOUT" })));
    if (body) req.write(body);
    req.end();
  });
}

function buildHeaders(options, body = options.body ? Buffer.from(options.body) : null) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.3 Safari/605.1.15",
    "Accept-Language": "en-US,en;q=0.9,he;q=0.8",
    Accept: "*/*",
    ...options.headers,
  };
  if (options.cookie) headers.Cookie = options.cookie;
  if (body && !hasHeader(headers, "content-length")) headers["Content-Length"] = String(body.length);
  return headers;
}

async function collectResponse(stream, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) {
      stream.destroy();
      throw new Error(`Levnet response exceeds the ${maxBytes}-byte limit.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function byteLimitTransform(maxBytes) {
  let bytes = 0;
  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) callback(new Error(`Levnet download exceeds the ${maxBytes}-byte limit.`));
      else callback(null, chunk);
    },
  });
  transform.bytesRead = () => bytes;
  return transform;
}

async function peekReadable(stream) {
  const iterator = stream[Symbol.asyncIterator]();
  const first = await iterator.next();
  const prefix = first.done ? Buffer.alloc(0) : Buffer.from(first.value);
  const replay = Readable.from((async function* replayChunks() {
    if (!first.done) yield first.value;
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      yield next.value;
    }
  })());
  replay.on("close", () => stream.destroy());
  return { prefix, stream: replay };
}

function sniffContentType(prefix) {
  if (prefix.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (prefix.subarray(0, 2).toString("hex") === "504b") return "application/zip";
  if (prefix.subarray(0, 3).toString("hex") === "ffd8ff") return "image/jpeg";
  if (prefix.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  return null;
}

function looksLikeHtml(prefix) {
  return /<(?:!doctype\s+html|html|head|body)\b/i.test(prefix.subarray(0, 1024).toString("utf8"));
}

async function chooseDestination(outputDir, safeName, overwrite) {
  const requested = join(outputDir, safeName);
  if (overwrite) return requested;
  try {
    await access(requested, fsConstants.F_OK);
  } catch (error) {
    if (error?.code === "ENOENT") return requested;
    throw error;
  }
  const extension = extname(safeName);
  const stem = extension ? safeName.slice(0, -extension.length) : safeName;
  for (let index = 2; index <= 999; index += 1) {
    const candidate = join(outputDir, `${stem} (${index})${extension}`);
    try {
      await access(candidate, fsConstants.F_OK);
    } catch (error) {
      if (error?.code === "ENOENT") return candidate;
      throw error;
    }
  }
  throw new Error("Could not choose an unused Levnet download filename.");
}

function fileNameFromDisposition(value) {
  if (!value) return null;
  const utf8 = String(value).match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (utf8) {
    try { return decodeURIComponent(utf8); } catch { return utf8; }
  }
  return String(value).match(/filename\s*=\s*"([^"]+)"/i)?.[1] ?? String(value).match(/filename\s*=\s*([^;]+)/i)?.[1]?.trim() ?? null;
}

export function sanitizeFileName(value) {
  const clean = basename(String(value ?? "levnet-download"))
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 180);
  if (!clean || clean === "." || clean === "..") return "levnet-download";
  return clean;
}

function withInferredExtension(name, contentType) {
  if (extname(name)) return name;
  const extension = {
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.ms-excel": ".xls",
    "image/jpeg": ".jpg",
    "image/png": ".png",
  }[contentType];
  return extension ? `${name}${extension}` : name;
}

function isAllowedDownloadType(contentType) {
  return contentType === "application/octet-stream"
    || contentType === "application/pdf"
    || contentType === "application/zip"
    || contentType === "application/vnd.ms-excel"
    || contentType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    || contentType.startsWith("image/");
}

function hasHeader(headers, target) {
  return Object.keys(headers).some((name) => name.toLowerCase() === target);
}

function trustedCaCertificates() {
  if (typeof tls.getCACertificates !== "function") return undefined;
  return [...new Set([
    ...tls.getCACertificates("bundled"),
    ...tls.getCACertificates("system"),
    ...tls.getCACertificates("extra"),
  ])];
}
