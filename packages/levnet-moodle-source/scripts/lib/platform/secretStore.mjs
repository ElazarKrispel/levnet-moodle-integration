import { execFile } from "node:child_process";
import { access, mkdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_WINDOWS_ROOT = "LevnetMoodleIntegration";

export async function readSecret(service, account, { platform = process.platform, windowsRoot = DEFAULT_WINDOWS_ROOT } = {}) {
  try {
    if (platform === "darwin") return await readMacSecret(service, account);
    if (platform === "win32") return await readWindowsSecret(service, account, windowsRoot);
    if (platform === "linux") return await readLinuxSecret(service, account);
    throw unsupportedPlatform(platform);
  } catch (error) {
    if (isMissingSecretError(error, platform)) return null;
    throw error;
  }
}

export async function writeSecret(service, account, value, { platform = process.platform, windowsRoot = DEFAULT_WINDOWS_ROOT } = {}) {
  if (!value) throw new Error(`Refusing to save an empty secret for ${service}/${account}.`);
  if (platform === "darwin") return writeMacSecret(service, account, value);
  if (platform === "win32") return writeWindowsSecret(service, account, value, windowsRoot);
  if (platform === "linux") return writeLinuxSecret(service, account, value);
  throw unsupportedPlatform(platform);
}

export async function deleteSecret(service, account, { platform = process.platform, windowsRoot = DEFAULT_WINDOWS_ROOT } = {}) {
  try {
    if (platform === "darwin") return await deleteMacSecret(service, account);
    if (platform === "win32") return await deleteWindowsSecret(service, account, windowsRoot);
    if (platform === "linux") return await deleteLinuxSecret(service, account);
    throw unsupportedPlatform(platform);
  } catch (error) {
    if (!isMissingSecretError(error, platform)) throw error;
  }
}

export async function secretStoreStatus({ platform = process.platform } = {}) {
  if (platform === "darwin") {
    return { platform, backend: "macos-keychain", available: await commandAvailable("security") };
  }
  if (platform === "win32") {
    const command = await resolvePowerShell();
    return { platform, backend: "windows-dpapi", available: Boolean(command), command };
  }
  if (platform === "linux") {
    return { platform, backend: "secret-service", available: await commandAvailable("secret-tool") };
  }
  return { platform, backend: null, available: false, reason: "unsupported_platform" };
}

async function readMacSecret(service, account) {
  const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", service, "-a", account, "-w"]);
  return stdout.replace(/\n$/, "") || null;
}

async function writeMacSecret(service, account, value) {
  await execFileAsync("security", ["add-generic-password", "-U", "-s", service, "-a", account, "-w", value]);
}

async function deleteMacSecret(service, account) {
  await execFileAsync("security", ["delete-generic-password", "-s", service, "-a", account]);
}

async function readWindowsSecret(service, account, windowsRoot) {
  const command = await requirePowerShell();
  const path = windowsSecretPath(service, account, windowsRoot);
  try {
    await access(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const script = [
    "Add-Type -AssemblyName System.Security",
    "$bytes = [IO.File]::ReadAllBytes($env:LMI_SECRET_PATH)",
    "$plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))",
  ].join("; ");
  const { stdout } = await execFileAsync(command, ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, LMI_SECRET_PATH: path },
  });
  return stdout || null;
}

async function writeWindowsSecret(service, account, value, windowsRoot) {
  const command = await requirePowerShell();
  const path = windowsSecretPath(service, account, windowsRoot);
  await mkdir(dirname(path), { recursive: true });
  const script = [
    "Add-Type -AssemblyName System.Security",
    "$plain = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())",
    "$encrypted = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[IO.File]::WriteAllBytes($env:LMI_SECRET_PATH, $encrypted)",
  ].join("; ");
  await execFileWithInput(command, ["-NoProfile", "-NonInteractive", "-Command", script], value, {
    env: { ...process.env, LMI_SECRET_PATH: path },
  });
}

async function deleteWindowsSecret(service, account, windowsRoot) {
  await unlink(windowsSecretPath(service, account, windowsRoot));
}

function windowsSecretPath(service, account, windowsRoot = DEFAULT_WINDOWS_ROOT) {
  const root = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  const key = Buffer.from(`${service}\0${account}`).toString("base64url");
  return join(root, "Codex", windowsRoot, "secrets", `${key}.bin`);
}

async function readLinuxSecret(service, account) {
  const { stdout } = await execFileAsync("secret-tool", ["lookup", "service", service, "account", account]);
  return stdout.replace(/\n$/, "") || null;
}

async function writeLinuxSecret(service, account, value) {
  await execFileWithInput("secret-tool", ["store", "--label", `JCT ${account}`, "service", service, "account", account], value);
}

async function deleteLinuxSecret(service, account) {
  await execFileAsync("secret-tool", ["clear", "service", service, "account", account]);
}

async function commandAvailable(command) {
  try {
    const locator = process.platform === "win32" ? "where.exe" : "which";
    await execFileAsync(locator, [command]);
    return true;
  } catch {
    return false;
  }
}

async function resolvePowerShell() {
  for (const command of ["powershell.exe", "pwsh.exe", "pwsh"]) {
    if (await commandAvailable(command)) return command;
  }
  return null;
}

async function requirePowerShell() {
  const command = await resolvePowerShell();
  if (!command) throw new Error("Windows PowerShell is required for DPAPI-backed JCT secret storage.");
  return command;
}

function isMissingSecretError(error, platform) {
  if (error?.code === "ENOENT") return true;
  if (platform === "darwin") return error?.code === 44;
  if (platform === "linux") return error?.code === 1;
  if (platform === "win32") return /FileNotFoundException|DirectoryNotFoundException|Could not find (?:a part of )?(?:the )?(?:file|path)|cannot find the path/i.test(error?.stderr ?? "");
  return false;
}

function unsupportedPlatform(platform) {
  return new Error(`JCT secure storage is not supported on platform ${platform}.`);
}

function execFileWithInput(command, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, options, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    child.stdin.end(input);
  });
}
