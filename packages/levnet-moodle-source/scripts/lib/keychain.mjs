import { deleteSecret, readSecret, secretStoreStatus, writeSecret } from "./platform/secretStore.mjs";

const PLUGIN_SERVICE = "codex-levnet-moodle-moodle";
const COOKIE_ACCOUNT = "MoodleSessiondev";
const TOKENS_ACCOUNT = "moodle-oauth-tokens";

const SHARED_SERVICE = "codex-levnet-moodle-microsoft";
const SHARED_ACCOUNTS = Object.freeze({
  email: "email",
  password: "password",
  mfaSeed: "mfa-seed",
  msSsoCookies: "ms-sso-cookies",
});

export async function readCookieFromKeychain() {
  return readSecret(PLUGIN_SERVICE, COOKIE_ACCOUNT);
}

export async function saveCookieToKeychain(cookieValue) {
  return writeSecret(PLUGIN_SERVICE, COOKIE_ACCOUNT, cookieValue);
}

export async function deleteCookieFromKeychain() {
  return deleteSecret(PLUGIN_SERVICE, COOKIE_ACCOUNT);
}

export async function readCredentialsFromKeychain() {
  const [email, password, mfaSeed] = await Promise.all([
    readSecret(SHARED_SERVICE, SHARED_ACCOUNTS.email),
    readSecret(SHARED_SERVICE, SHARED_ACCOUNTS.password),
    readSecret(SHARED_SERVICE, SHARED_ACCOUNTS.mfaSeed),
  ]);
  if (email && password && mfaSeed) {
    return { email, password, mfaSeed, source: "shared" };
  }
  return null;
}

export async function credentialStatus() {
  const [email, password, mfaSeed, storage] = await Promise.all([
    readSecret(SHARED_SERVICE, SHARED_ACCOUNTS.email),
    readSecret(SHARED_SERVICE, SHARED_ACCOUNTS.password),
    readSecret(SHARED_SERVICE, SHARED_ACCOUNTS.mfaSeed),
    secretStoreStatus(),
  ]);
  return {
    complete: Boolean(email && password && mfaSeed),
    present: { email: Boolean(email), password: Boolean(password), mfaSeed: Boolean(mfaSeed) },
    missing: [!email && "email", !password && "password", !mfaSeed && "mfaSeed"].filter(Boolean),
    storage,
  };
}

export async function saveCredentialsToKeychain({ email, password, mfaSeed }) {
  if (!email || !password || !mfaSeed) {
    throw new Error("Cannot save credentials: email, password, and mfaSeed are all required.");
  }
  await writeSecret(SHARED_SERVICE, SHARED_ACCOUNTS.email, email);
  await writeSecret(SHARED_SERVICE, SHARED_ACCOUNTS.password, password);
  await writeSecret(SHARED_SERVICE, SHARED_ACCOUNTS.mfaSeed, mfaSeed);
}

export async function deleteCredentialsFromKeychain() {
  await Promise.all([
    deleteSecret(SHARED_SERVICE, SHARED_ACCOUNTS.email),
    deleteSecret(SHARED_SERVICE, SHARED_ACCOUNTS.password),
    deleteSecret(SHARED_SERVICE, SHARED_ACCOUNTS.mfaSeed),
    deleteSecret(SHARED_SERVICE, SHARED_ACCOUNTS.msSsoCookies),
  ]);
}

export async function readMsSsoCookiesFromKeychain() {
  const raw = await readSecret(SHARED_SERVICE, SHARED_ACCOUNTS.msSsoCookies);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveMsSsoCookiesToKeychain(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) {
    return;
  }
  await writeSecret(SHARED_SERVICE, SHARED_ACCOUNTS.msSsoCookies, JSON.stringify(cookies));
}

export async function deleteMsSsoCookiesFromKeychain() {
  await deleteSecret(SHARED_SERVICE, SHARED_ACCOUNTS.msSsoCookies);
}

export async function readTokensFromKeychain() {
  const raw = await readSecret(PLUGIN_SERVICE, TOKENS_ACCOUNT);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveTokensToKeychain(tokens) {
  if (!tokens || typeof tokens !== "object") {
    return;
  }
  await writeSecret(PLUGIN_SERVICE, TOKENS_ACCOUNT, JSON.stringify(tokens));
}

export async function deleteTokensFromKeychain() {
  await deleteSecret(PLUGIN_SERVICE, TOKENS_ACCOUNT);
}

export function keychainLocation() {
  return {
    backend: process.platform === "darwin" ? "macos-keychain" : process.platform === "win32" ? "windows-dpapi" : "secret-service",
    pluginService: PLUGIN_SERVICE,
    cookieAccount: COOKIE_ACCOUNT,
    tokensAccount: TOKENS_ACCOUNT,
    sharedService: SHARED_SERVICE,
    sharedAccounts: { ...SHARED_ACCOUNTS },
  };
}
