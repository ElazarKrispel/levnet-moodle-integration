import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function openExternalUrl(url, { platform = process.platform } = {}) {
  const safeUrl = validateExternalUrl(url);
  if (platform === "win32") {
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Start-Process -FilePath $env:LMI_EXTERNAL_URL",
    ], { windowsHide: true, env: { ...process.env, LMI_EXTERNAL_URL: safeUrl } });
    return { opened: true };
  }
  if (platform === "darwin") {
    await execFileAsync("open", [safeUrl]);
    return { opened: true };
  }
  if (platform === "linux") {
    await execFileAsync("xdg-open", [safeUrl]);
    return { opened: true };
  }
  throw new Error(`Opening the Google connection page is not supported on ${platform}.`);
}

export function validateExternalUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:" || url.hostname !== "script.google.com" || !/^\/macros\/s\/[^/]+\/(?:exec|dev)$/.test(url.pathname)) {
    throw new Error("The configured Google connection URL is invalid.");
  }
  url.hash = "";
  url.search = "";
  return url.toString();
}
