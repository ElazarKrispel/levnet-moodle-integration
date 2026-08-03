import { parseMoodleCookie } from "./cookie.mjs";
import { normalizeBase32, runSecureDialog } from "./platform/securePrompt.mjs";
import { base32ToBuffer, generateTOTP } from "./totp.mjs";

export async function promptForCookie(reason = "Moodle session cookie is missing or expired.") {
  const stdout = await runSecureDialog({
    title: "JCT Moodle Cookie",
    prompt: `${reason}\n\nPaste the MoodleSessiondev value or full Cookie header from moodle.jct.ac.il.`,
    hidden: true,
  });
  const parsed = parseMoodleCookie(stdout);
  if (!parsed) throw new Error("The pasted value did not contain a valid MoodleSessiondev cookie.");
  return parsed;
}

export async function promptForCredentials({
  reason = "הגדרת התחברות אוטומטית ל־Moodle וללב־נט.",
  defaults = {},
} = {}) {
  const rawSeed = await runSecureDialog({
    title: "JCT — שלב 1 מתוך 3: מפתח אימות",
    prompt:
      "הדבק כאן את מפתח ההגדרה החדש שהעתקת מאתר Microsoft.\n\n" +
      "המפתח נשמר מוצפן במחשב ומשמש רק לחידוש אוטומטי של החיבור ל־JCT. " +
      "אין לשלוח אותו בצ׳אט. אפשר להדביק עם רווחים או מקפים.",
    hidden: true,
  });
  const mfaSeed = normalizeBase32(rawSeed);
  if (!mfaSeed || base32ToBuffer(mfaSeed).length < 10) {
    throw new Error("מפתח האימות אינו תקין. הדבק רק את מפתח ה־Base32 החדש, ללא שם החשבון או כתובת המייל.");
  }
  generateTOTP(mfaSeed);

  const email = (await runSecureDialog({
    title: "JCT — שלב 2 מתוך 3: כתובת מייל",
    prompt: `${reason}\n\nהזן את כתובת המייל המלאה של JCT, לדוגמה name@acad.jct.ac.il.`,
    defaultValue: defaults.email ?? "",
  })).trim();
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error("נדרשת כתובת מייל תקינה.");

  const password = await runSecureDialog({
    title: "JCT — שלב 3 מתוך 3: סיסמה",
    prompt: `הזן את סיסמת Microsoft עבור ${email}.\n\nהסיסמה נשמרת באחסון המוצפן של מערכת ההפעלה ומשמשת רק להתחברות לשירותי JCT.`,
    hidden: true,
  });
  if (!password) throw new Error("נדרשת סיסמה.");

  return { email, password, mfaSeed };
}
