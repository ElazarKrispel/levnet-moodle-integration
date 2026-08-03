import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { generateCalendarExportUrl, readAccountBindingMaterial } from "./moodle.mjs";
import { readSecret, writeSecret } from "./platform/secretStore.mjs";
import { showSecretCopyDialog } from "./platform/securePrompt.mjs";
import { openExternalUrl, validateExternalUrl } from "./platform/openExternal.mjs";

const SERVICE = "codex-levnet-moodle-calendar-pairing";
const HMAC_ACCOUNT = "prepare-token-hmac";
const ACCOUNT_BINDING_HMAC = "account-binding-hmac";
const STATE_ACCOUNT = "prepare-token-state";
const TOKEN_TTL_MS = 5 * 60 * 1000;
const KEY_MANAGEMENT_URL = "https://moodle.jct.ac.il/user/managetoken.php";

export function createMoodleCalendarPairingService(overrides = {}) {
  const dependencies = {
    now: () => Date.now(),
    readSecret,
    writeSecret,
    readAccountBindingMaterial,
    generateCalendarExportUrl,
    showSecret: showCalendarFeedDialog,
    openExternal: openExternalUrl,
    webAppUrl: configuredWebAppUrl(),
    ...overrides,
  };

  return {
    prepare: () => preparePairing(dependencies),
    execute: (input) => executePairing(input, dependencies),
  };
}

async function preparePairing(dependencies) {
  const account = await currentAccount(dependencies);
  const now = dependencies.now();
  const payload = {
    version: 1,
    nonce: randomUUID(),
    account,
    operationId: "moodle.calendar-feed.copy",
    issuedAt: now,
    expiresAt: now + TOKEN_TTL_MS,
  };
  const prepareToken = await signPayload(payload, dependencies);
  const state = await readState(dependencies);
  state.records[payload.nonce] = {
    payload,
    status: "prepared",
    createdAt: now,
  };
  await writeState(state, dependencies);

  return {
    status: "prepared",
    operation: {
      id: payload.operationId,
      risk: "sensitive",
      summary: "Generate the authenticated Moodle calendar feed and continue to Google Calendar",
    },
    preview: {
      source: "https://moodle.jct.ac.il",
      eventSelection: "all",
      period: "recentupcoming",
      destination: dependencies.webAppUrl ? "local secure dialog, clipboard, and the Google connection page" : "local secure dialog and clipboard only",
      secretReturnedToModel: false,
      securityNote: "Anyone with the copied URL can read the exported Moodle calendar. Paste it only into the Levnet & Moodle Integration Google page.",
      keyManagementUrl: KEY_MANAGEMENT_URL,
    },
    prepareToken,
    expiresAt: new Date(payload.expiresAt).toISOString(),
    confirmationRequired: "single",
  };
}

async function executePairing({ prepareToken, confirm = false } = {}, dependencies) {
  if (!confirm) throw new Error("Explicit confirm=true is required.");
  const { payload, record, state } = await verifyAndLoadRecord(prepareToken, dependencies);
  const account = await currentAccount(dependencies);
  assertEqual(account, payload.account, "Prepare token belongs to another Moodle account.");

  record.status = "in_flight";
  record.inFlightAt = dependencies.now();
  await writeState(state, dependencies);

  try {
    const feedUrl = await dependencies.generateCalendarExportUrl({
      exportEvents: "all",
      timePeriod: "recentupcoming",
    });
    const presentation = await dependencies.showSecret(feedUrl);
    let webAppOpened = false;
    if (dependencies.webAppUrl) {
      try {
        await dependencies.openExternal(dependencies.webAppUrl);
        webAppOpened = true;
      } catch {}
    }
    record.status = "succeeded";
    record.completedAt = dependencies.now();
    record.presentation = sanitizePresentation(presentation);
    await writeState(state, dependencies);
    return {
      status: "succeeded",
      copiedToClipboard: Boolean(presentation?.copied),
      webAppOpened,
      webAppUrl: dependencies.webAppUrl || undefined,
      manualCopyRequired: Boolean(presentation?.manualCopyRequired),
      secretReturnedToModel: false,
      nextStep: webAppOpened
        ? "The Google connection page is open. Paste the copied calendar link there and select Connect."
        : "Open the Google connection page, paste the copied calendar link, and select Connect.",
      keyManagementUrl: KEY_MANAGEMENT_URL,
      retryAllowed: false,
    };
  } catch (error) {
    record.status = error?.code === 2 ? "cancelled" : "presentation_failed";
    record.completedAt = dependencies.now();
    record.error = safeError(error);
    await writeState(state, dependencies);
    return {
      status: record.status,
      secretReturnedToModel: false,
      retryAllowed: false,
      nextStep: record.status === "cancelled"
        ? "Create a new preview when you are ready to copy the calendar link."
        : "Create a new preview and try again. The calendar link was not returned through chat.",
    };
  }
}

async function showCalendarFeedDialog(feedUrl) {
  return showSecretCopyDialog({
    title: "Levnet & Moodle Integration",
    prompt:
      "Your private Moodle calendar link is ready.\n\n" +
      "Copy it, then paste it only into the Google connection page that opens next. " +
      "Do not paste it into chat or send it to another person.",
    secret: feedUrl,
  });
}

function configuredWebAppUrl() {
  const value = String(process.env.LMI_CALENDAR_WEB_APP_URL || "").trim();
  if (!value) return null;
  return validateExternalUrl(value);
}

async function currentAccount(dependencies) {
  const material = await dependencies.readAccountBindingMaterial();
  if (!material?.userId) throw new Error("Moodle account identity is unavailable; refresh the Moodle session first.");
  const key = await accountBindingKey(dependencies);
  return {
    authority: "moodle-session",
    subject: createHmac("sha256", key).update(String(material.userId)).digest("base64url"),
  };
}

async function verifyAndLoadRecord(token, dependencies) {
  const payload = await verifyToken(token, dependencies);
  if (payload.expiresAt < dependencies.now()) throw new Error("Prepare token expired.");
  const state = await readState(dependencies);
  const record = state.records[payload.nonce];
  if (!record) throw new Error("Prepare token state was not found.");
  if (record.status !== "prepared") throw new Error(`Prepare token cannot be used from state ${record.status}.`);
  assertEqual(record.payload, payload, "Prepare token payload mismatch.");
  return { payload, record, state };
}

async function signPayload(payload, dependencies) {
  const encoded = Buffer.from(canonicalJson(payload)).toString("base64url");
  const key = await hmacKey(dependencies);
  const signature = createHmac("sha256", key).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

async function verifyToken(token, dependencies) {
  const [encoded, signature, extra] = String(token ?? "").split(".");
  if (!encoded || !signature || extra) throw new Error("Invalid prepare token.");
  const key = await hmacKey(dependencies);
  const expected = createHmac("sha256", key).update(encoded).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.toString("base64url") !== signature || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Invalid prepare token signature.");
  }
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid prepare token payload.");
  }
}

async function hmacKey(dependencies) {
  let encoded = await dependencies.readSecret(SERVICE, HMAC_ACCOUNT);
  if (!encoded) {
    encoded = randomBytes(32).toString("base64url");
    await dependencies.writeSecret(SERVICE, HMAC_ACCOUNT, encoded);
  }
  return Buffer.from(encoded, "base64url");
}

async function accountBindingKey(dependencies) {
  let encoded = await dependencies.readSecret(SERVICE, ACCOUNT_BINDING_HMAC);
  if (!encoded) {
    encoded = randomBytes(32).toString("base64url");
    await dependencies.writeSecret(SERVICE, ACCOUNT_BINDING_HMAC, encoded);
  }
  return Buffer.from(encoded, "base64url");
}

async function readState(dependencies) {
  const raw = await dependencies.readSecret(SERVICE, STATE_ACCOUNT);
  let parsed = { version: 1, records: {} };
  if (raw) {
    try { parsed = JSON.parse(raw); } catch { parsed = { version: 1, records: {} }; }
  }
  const cutoff = dependencies.now() - 24 * 60 * 60 * 1000;
  parsed.records = Object.fromEntries(Object.entries(parsed.records ?? {})
    .filter(([, record]) => Number(record.createdAt) >= cutoff)
    .slice(-100));
  return parsed;
}

async function writeState(state, dependencies) {
  await dependencies.writeSecret(SERVICE, STATE_ACCOUNT, JSON.stringify(state));
}

function sanitizePresentation(value) {
  return {
    copied: Boolean(value?.copied),
    shown: Boolean(value?.shown),
    manualCopyRequired: Boolean(value?.manualCopyRequired),
  };
}

function safeError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: String(error?.message ?? error ?? "Unknown error")
      .replace(/https:\/\/moodle\.jct\.ac\.il\/calendar\/export_execute\.php\?\S+/gi, "[calendar-feed-redacted]"),
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertEqual(actual, expected, message) {
  const actualHash = createHash("sha256").update(canonicalJson(actual)).digest();
  const expectedHash = createHash("sha256").update(canonicalJson(expected)).digest();
  if (actualHash.length !== expectedHash.length || !timingSafeEqual(actualHash, expectedHash)) throw new Error(message);
}
