import { credentialStatus } from "./keychain.mjs";
import { browserRuntimeStatus } from "./platform/browserRuntime.mjs";

export const MICROSOFT_SECURITY_INFO_URL = "https://mysignins.microsoft.com/security-info";

export async function onboardingStatus() {
  const [credentials, browser] = await Promise.all([credentialStatus(), browserRuntimeStatus()]);
  return buildOnboardingStatus({ platform: process.platform, credentials, browser });
}

export function buildOnboardingStatus({ platform, credentials, browser }) {
  const needsAuthenticatorBootstrap = !credentials.present.mfaSeed;
  const blockers = [];
  if (!credentials.storage.available) blockers.push({ code: "secure_storage_unavailable", detail: credentials.storage });
  if (!browser.available) blockers.push({ code: "browser_runtime_unavailable", detail: browser });

  return {
    platform,
    readyForAutomaticLogin: credentials.complete && blockers.length === 0,
    credentials,
    browser,
    blockers,
    onboarding: credentials.complete
      ? {
          required: false,
          useComputerUse: false,
          next: "Use lmi_refresh_sessions if a provider session is expired.",
          automaticRenewal: true,
        }
      : {
          required: true,
          useComputerUse: needsAuthenticatorBootstrap,
          reason: needsAuthenticatorBootstrap ? "authenticator_seed_missing" : "stored_credentials_incomplete",
          url: needsAuthenticatorBootstrap ? MICROSOFT_SECURITY_INFO_URL : null,
          next: needsAuthenticatorBootstrap
            ? "Use Computer Use once to navigate to Microsoft Security Info. Hand control to the user for authenticator creation and secret handling, then call lmi_setup with authenticatorReady=true."
            : "Call lmi_setup; local secure dialogs collect only the missing setup data.",
          steps: needsAuthenticatorBootstrap ? [
            "Open Microsoft Security Info and add Microsoft Authenticator.",
            "Choose a different authenticator app and manual setup.",
            "Copy the new Base32 setup key and complete Microsoft verification.",
            "Immediately call lmi_setup with authenticatorReady=true.",
            "Paste the key, email, and password only into the local secure dialogs.",
          ] : ["Call lmi_setup to complete the missing protected credentials."],
          privacyNotice: "The password and TOTP seed are stored only in the operating system protected secret store. Keeping both enables unattended renewal but reduces MFA separation if the computer account is compromised.",
        },
  };
}

export async function setupReadiness({ authenticatorReady = false } = {}) {
  const status = await onboardingStatus();
  if (status.blockers.length > 0) {
    return { canStart: false, reason: "missing_local_prerequisite", status };
  }
  if (status.onboarding.useComputerUse && !authenticatorReady) {
    return { canStart: false, reason: "authenticator_bootstrap_required", status };
  }
  return { canStart: true, status };
}
