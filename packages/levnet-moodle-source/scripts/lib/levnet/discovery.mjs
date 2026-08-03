import { levnetRequest } from "./http.mjs";

const BASE_URL = "https://levnet.jct.ac.il";
const APP_BUNDLE_RE = /<script[^>]+src=["']([^"']*\/dist\/app\.bundle\.js[^"']*)["']/i;
const API_HANDLER_RE = /["'](\/api\/[A-Za-z0-9/_-]+)(?:\.ashx)?["']/g;
const PAGE_RE = /["'](\/(?:Admin|Course|Employee|Kiosk|Lecturer|Login|Student|Teacher|Common)\/[^"']+?\.aspx(?:\?[^"']*)?)["']/g;

const READ_ACTION_RE = /^(Load|Get|List|Search|Find|Read|Download|Preview|Check|Calculate|Actual|Export)/i;
const MUTATION_ACTION_RE = /^(Save|Update|Delete|Remove|Upload|Insert|Create|Register|Recover|Validate|Change|Send|Submit|Confirm|Cancel|Approve|Reject|Extend)/i;

export function isReadOnlyAction(action) {
  return READ_ACTION_RE.test(action) && !MUTATION_ACTION_RE.test(action);
}

export async function discoverEndpoints() {
  const login = await levnetRequest("/Login/Login.aspx", { followRedirects: true });
  const bundlePath = login.text.match(APP_BUNDLE_RE)?.[1] ?? "/dist/app.bundle.js?v=1.3.26";
  const bundleUrl = new URL(bundlePath, BASE_URL).toString();
  const bundle = await levnetRequest(bundleUrl, { followRedirects: true });
  return endpointInventoryFromBundle(bundle.text, { bundleUrl, loginStatusCode: login.statusCode });
}

export function endpointInventoryFromBundle(bundleText, metadata = {}) {
  const modules = splitWebpackModules(bundleText);
  const apiHandlers = new Map();
  const callSites = [];
  const pages = new Map();

  for (const moduleText of modules) {
    const moduleName = moduleText.match(/^"([^"]+)"/)?.[1] ?? null;
    const moduleCallSites = extractCallSites(moduleText, moduleName);
    const pagePaths = uniqueMatches(moduleText, PAGE_RE).map(normalizePath);

    for (const callSite of moduleCallSites) {
      callSites.push(callSite);
      const handler = callSite.handler;
      if (!apiHandlers.has(handler)) {
        apiHandlers.set(handler, { handler, modules: new Set() });
      }
      if (moduleName) {
        apiHandlers.get(handler).modules.add(moduleName);
      }
    }

    for (const page of pagePaths) {
      if (!pages.has(page)) {
        pages.set(page, { path: page, modules: new Set() });
      }
      if (moduleName) {
        pages.get(page).modules.add(moduleName);
      }
    }
  }

  const apiHandlerList = [...apiHandlers.values()].map((item) => ({
    ...item,
    modules: [...item.modules].sort(),
  }));
  const apiActionList = dedupeCallSites(callSites)
    .sort((a, b) => `${a.handler}:${a.action}`.localeCompare(`${b.handler}:${b.action}`));
  const pageList = [...pages.values()]
    .map((item) => ({ ...item, modules: [...item.modules].sort() }))
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    ...metadata,
    counts: {
      apiHandlers: apiHandlerList.length,
      apiActions: apiActionList.length,
      readOnlyLikelyActions: apiActionList.filter((item) => item.readOnlyLikely).length,
      pages: pageList.length,
    },
    apiHandlers: apiHandlerList.sort((a, b) => a.handler.localeCompare(b.handler)),
    apiActions: apiActionList,
    callSites: callSites.sort((a, b) => `${a.module}:${a.offset}`.localeCompare(`${b.module}:${b.offset}`)),
    pages: pageList,
  };
}

export function extractCallSites(moduleText, moduleName = null) {
  const text = String(moduleText);
  const callSites = [];
  const callRe = /\.((?:get|post|put|delete))\(\{/gi;
  for (const match of text.matchAll(callRe)) {
    const objectStart = match.index + match[0].length - 1;
    const objectEnd = findMatchingBrace(text, objectStart);
    if (objectEnd < 0) continue;
    const objectText = text.slice(objectStart, objectEnd + 1);
    const action = objectText.match(/\baction\s*:\s*["']([A-Za-z0-9_]+)["']/)?.[1];
    const handlerExpression = objectText.match(/\bhandler\s*:\s*([^,}]+)/)?.[1]?.trim();
    const handler = resolveHandlerExpression(handlerExpression, text, objectStart);
    if (!action || !handler) continue;
    callSites.push({
      handler: normalizeHandler(handler),
      action,
      method: match[1].toUpperCase(),
      parameters: extractParameterShape(objectText),
      readOnlyLikely: isReadOnlyAction(action),
      module: moduleName,
      offset: match.index,
      source: text.slice(Math.max(0, match.index - 80), Math.min(text.length, objectEnd + 81)),
    });
  }

  const downloadRe = /([A-Za-z_$][\w$]*|["']\/api\/[^"']+["'])\s*\+\s*["']\.ashx\?action=([A-Za-z0-9_]+)([^"']*)["']/g;
  for (const match of text.matchAll(downloadRe)) {
    const handler = resolveHandlerExpression(match[1], text, match.index);
    if (!handler) continue;
    const parameters = [...match[3].matchAll(/&([A-Za-z0-9_]+)=/g)].map((item) => item[1]);
    callSites.push({
      handler: normalizeHandler(handler),
      action: match[2],
      method: "GET",
      parameters: { kind: "query", keys: parameters },
      readOnlyLikely: isReadOnlyAction(match[2]),
      module: moduleName,
      offset: match.index,
      source: text.slice(Math.max(0, match.index - 80), Math.min(text.length, match.index + match[0].length + 160)),
    });
  }
  return callSites;
}

function splitWebpackModules(bundleText) {
  return String(bundleText)
    .split(/,(?="\.[^"]+":function\()/g)
    .filter(Boolean);
}

function dedupeCallSites(callSites) {
  const items = new Map();
  for (const callSite of callSites) {
    const key = `${callSite.handler}\0${callSite.action}\0${callSite.method}`;
    if (!items.has(key)) {
      items.set(key, {
        handler: callSite.handler,
        action: callSite.action,
        method: callSite.method,
        parameters: callSite.parameters,
        readOnlyLikely: callSite.readOnlyLikely,
        modules: new Set(),
      });
    }
    if (callSite.module) items.get(key).modules.add(callSite.module);
  }
  return [...items.values()].map((item) => ({ ...item, modules: [...item.modules].sort() }));
}

function resolveHandlerExpression(expression, moduleText, callOffset = 0) {
  if (!expression) return null;
  const literal = expression.match(/^["'](\/api\/[^"']+)["']$/)?.[1];
  if (literal) return literal;
  if (!/^[A-Za-z_$][\w$]*$/.test(expression)) return null;
  const escaped = expression.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const definitions = [...moduleText.matchAll(new RegExp(`\\b${escaped}\\s*=\\s*["'](\\/api\\/[^"']+)["']`, "g"))];
  definitions.sort((a, b) => Math.abs(a.index - callOffset) - Math.abs(b.index - callOffset));
  return definitions[0]?.[1] ?? null;
}

function extractParameterShape(objectText) {
  const jsonExpression = objectText.match(/\bjson\s*:\s*([^,}]+)/)?.[1]?.trim();
  if (!jsonExpression) return { kind: "none", keys: [] };
  if (/^[A-Za-z_$][\w$.]*$/.test(jsonExpression)) return { kind: "reference", reference: jsonExpression };
  if (jsonExpression.startsWith("{")) {
    return {
      kind: "object",
      keys: [...jsonExpression.matchAll(/(?:^|[,{\s])([A-Za-z_$][\w$]*)\s*:/g)].map((match) => match[1]),
    };
  }
  return { kind: "expression", expression: jsonExpression.slice(0, 160) };
}

function findMatchingBrace(text, start) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return index;
  }
  return -1;
}

function uniqueMatches(text, regex) {
  regex.lastIndex = 0;
  return [...new Set([...String(text).matchAll(regex)].map((match) => match[1]))];
}

function normalizeHandler(handler) {
  return String(handler).replace(/\.ashx$/i, "");
}

function normalizePath(path) {
  return String(path).replace(/\\u0026/g, "&");
}

