import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export async function browserRuntimeStatus({ platform = process.platform } = {}) {
  const executable = await findBrowserExecutable(platform);
  return {
    available: Boolean(executable),
    executable,
    engine: executable ? "chromium-cdp" : null,
    supportedPlatforms: ["darwin", "win32", "linux"],
  };
}

export async function startBrowserRuntime({ port = 9222, platform = process.platform } = {}) {
  const executable = await findBrowserExecutable(platform);
  if (!executable) {
    throw new Error("JCT automatic sign-in requires Google Chrome, Chromium, Microsoft Edge, or a bundled browser runtime.");
  }

  const profile = await mkdtemp(join(tmpdir(), "levnet-moodle-auth-browser-"));
  const args = [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-component-update", "--disable-sync", "--ignore-certificate-errors", "about:blank",
  ];
  const proc = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        const meta = await response.json();
        return {
          proc, meta, executable,
          cleanup: async () => { proc.kill(); await rm(profile, { recursive: true, force: true }).catch(() => {}); },
          getStderr: () => stderr,
        };
      }
    } catch {}
    if (proc.exitCode !== null) break;
    await sleep(150);
  }

  proc.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  throw new Error(`JCT browser runtime did not start. ${stderr.slice(-500)}`);
}

async function findBrowserExecutable(platform) {
  const override = process.env.LMI_BROWSER_PATH;
  const candidates = override ? [override] : browserCandidates(platform);
  for (const candidate of candidates) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (await exists(candidate)) return candidate;
    } else if (await commandExists(candidate, platform)) {
      return candidate;
    }
  }
  return null;
}

function browserCandidates(platform) {
  if (platform === "darwin") return [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  if (platform === "win32") {
    const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
    return roots.flatMap((root) => [
      join(root, "Google", "Chrome", "Application", "chrome.exe"),
      join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(root, "Chromium", "Application", "chrome.exe"),
    ]);
  }
  return ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function commandExists(command, platform) {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => execFile(platform === "win32" ? "where.exe" : "which", [command], (error) => resolve(!error)));
}
