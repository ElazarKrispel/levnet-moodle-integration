import assert from "node:assert/strict";
import test from "node:test";

import { buildOnboardingStatus } from "../scripts/lib/onboarding.mjs";
import { normalizeBase32 } from "../scripts/lib/platform/securePrompt.mjs";
import { secretStoreStatus } from "../scripts/lib/platform/secretStore.mjs";

const availableStorage = { available: true, backend: "test" };
const availableBrowser = { available: true, engine: "chromium-cdp" };

test("clean installation requests one-time Computer Use bootstrap", () => {
  const status = buildOnboardingStatus({
    platform: "win32",
    credentials: {
      complete: false,
      present: { email: false, password: false, mfaSeed: false },
      missing: ["email", "password", "mfaSeed"],
      storage: availableStorage,
    },
    browser: availableBrowser,
  });
  assert.equal(status.onboarding.required, true);
  assert.equal(status.onboarding.useComputerUse, true);
  assert.equal(status.onboarding.reason, "authenticator_seed_missing");
  assert.match(status.onboarding.url, /mysignins\.microsoft\.com/);
  assert.equal(status.onboarding.steps.length, 5);
  assert.match(status.onboarding.privacyNotice, /TOTP seed/);
});

test("stored seed prevents Computer Use even when another credential is missing", () => {
  const status = buildOnboardingStatus({
    platform: "darwin",
    credentials: {
      complete: false,
      present: { email: true, password: false, mfaSeed: true },
      missing: ["password"],
      storage: availableStorage,
    },
    browser: availableBrowser,
  });
  assert.equal(status.onboarding.useComputerUse, false);
  assert.equal(status.onboarding.reason, "stored_credentials_incomplete");
});

test("complete credentials always prefer plugin session refresh", () => {
  const status = buildOnboardingStatus({
    platform: "linux",
    credentials: {
      complete: true,
      present: { email: true, password: true, mfaSeed: true },
      missing: [],
      storage: availableStorage,
    },
    browser: availableBrowser,
  });
  assert.equal(status.onboarding.required, false);
  assert.equal(status.onboarding.useComputerUse, false);
  assert.equal(status.readyForAutomaticLogin, true);
  assert.equal(status.onboarding.automaticRenewal, true);
});

test("missing secure storage and browser are reported as blockers", () => {
  const status = buildOnboardingStatus({
    platform: "win32",
    credentials: {
      complete: false,
      present: { email: false, password: false, mfaSeed: false },
      missing: ["email", "password", "mfaSeed"],
      storage: { available: false, backend: "windows-dpapi" },
    },
    browser: { available: false },
  });
  assert.deepEqual(status.blockers.map((item) => item.code), ["secure_storage_unavailable", "browser_runtime_unavailable"]);
});

test("base32 normalization accepts formatted setup keys and rejects invalid values", () => {
  assert.equal(normalizeBase32("jbsw y3dp-ehpk3pxp"), "JBSWY3DPEHPK3PXP");
  assert.equal(normalizeBase32("JBSWY3DPEHPK3PXP===="), "JBSWY3DPEHPK3PXP");
  assert.equal(normalizeBase32("not-a-seed!"), null);
});

test("unknown platforms report unavailable secure storage", async () => {
  assert.deepEqual(await secretStoreStatus({ platform: "plan9" }), {
    platform: "plan9", backend: null, available: false, reason: "unsupported_platform",
  });
});
