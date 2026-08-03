import { deleteSecret, readSecret, writeSecret } from "../platform/secretStore.mjs";

const PLUGIN_SERVICE = "codex-levnet-moodle-levnet";
const COOKIE_ACCOUNT = "levnet-cookie-header";
const TOKENS_ACCOUNT = "levnet-oauth-tokens";

const SHARED_SERVICE = "codex-levnet-moodle-microsoft";
const SHARED_ACCOUNTS = Object.freeze({
  email: "email",
  password: "password",
  mfaSeed: "mfa-seed",
  msSsoCookies: "ms-sso-cookies",
});

// Legacy per-plugin credential accounts; migrated to shared on first read.
const LEGACY_CREDENTIAL_ACCOUNTS = Object.freeze({
  email: "levnet-email",
  password: "levnet-password",
  mfaSeed: "levnet-mfa-seed",
});

export async function readCookieFromKeychain() {
  return readSecret(PLUGIN_SERVICE, COOKIE_ACCOUNT);
}

export async function saveCookieToKeychain(cookieHeader) {
  return writeSecret(PLUGIN_SERVICE, COOKIE_ACCOUNT, cookieHeader);
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

  const [legacyEmail, legacyPassword, legacyMfa] = await Promise.all([
    readSecret(PLUGIN_SERVICE, LEGACY_CREDENTIAL_ACCOUNTS.email),
    readSecret(PLUGIN_SERVICE, LEGACY_CREDENTIAL_ACCOUNTS.password),
    readSecret(PLUGIN_SERVICE, LEGACY_CREDENTIAL_ACCOUNTS.mfaSeed),
  ]);
  if (legacyEmail && legacyPassword && legacyMfa) {
    await saveCredentialsToKeychain({ email: legacyEmail, password: legacyPassword, mfaSeed: legacyMfa });
    await Promise.all([
      deleteSecret(PLUGIN_SERVICE, LEGACY_CREDENTIAL_ACCOUNTS.email),
      deleteSecret(PLUGIN_SERVICE, LEGACY_CREDENTIAL_ACCOUNTS.password),
      deleteSecret(PLUGIN_SERVICE, LEGACY_CREDENTIAL_ACCOUNTS.mfaSeed),
    ]);
    return { email: legacyEmail, password: legacyPassword, mfaSeed: legacyMfa, source: "migrated" };
  }

  return null;
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
