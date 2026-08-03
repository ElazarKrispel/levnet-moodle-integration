import { parseCookieHeader } from "./cookie.mjs";
import { normalizeBase32, runSecureDialog } from "../platform/securePrompt.mjs";

export async function promptForCookie(reason = "Levnet session cookie is missing or expired.") {
  const stdout = await runSecureDialog({
    title: "JCT Levnet Cookie",
    prompt: `${reason}\n\nPaste the full Cookie header from levnet.jct.ac.il.`,
    hidden: true,
  });

  const parsed = parseCookieHeader(stdout);
  if (!parsed) {
    throw new Error("The pasted value did not contain a usable Levnet Cookie header.");
  }
  return parsed;
}

export async function promptForCredentials({
  reason = "Set up automatic JCT Levnet sign-in.",
  defaults = {},
} = {}) {
  const email = (await runSecureDialog({
    title: "JCT Levnet — Email",
    prompt: `${reason}\n\nEnter your full Levnet/Microsoft email (e.g. firstname.lastname@acad.jct.ac.il).`,
    defaultValue: defaults.email ?? "",
  })).trim();
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) {
    throw new Error("A valid email address is required.");
  }

  const password = await runSecureDialog({
    title: "JCT Levnet — Password",
    prompt: `Enter the Microsoft account password for ${email}.\n\nIt is stored in your operating system's protected credential storage and used only for JCT sign-in.`,
    hidden: true,
  });
  if (!password) {
    throw new Error("Password is required.");
  }

  const rawSeed = await runSecureDialog({
    title: "JCT Levnet — TOTP Secret",
    prompt:
      "Paste your authenticator app TOTP secret (the base32 string shown when you set up MFA).\n\n" +
      "If you do not have it yet, cancel and let the JCT skill guide the one-time Microsoft Authenticator setup. " +
      "Letters A–Z and digits 2–7 only.",
    hidden: true,
  });
  const mfaSeed = normalizeBase32(rawSeed);
  if (!mfaSeed) {
    throw new Error("TOTP secret is required and must be a base32 string.");
  }

  return { email, password, mfaSeed };
}

export async function promptForText({ title, prompt, defaultValue = "", hidden = false }) {
  return runSecureDialog({ title, prompt, defaultValue, hidden });
}
