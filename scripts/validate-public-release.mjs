import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const forbiddenNames = new Set([".clasp.json", "auth.json", ".env"]);
const textExtensions = new Set([".js", ".mjs", ".cjs", ".json", ".md", ".html", ".yml", ".yaml", ".ps1", ".cs", ".csproj", ".manifest"]);
const failures = [];

for (const file of await walk(root)) {
  const rel = relative(root, file).replaceAll("\\", "/");
  if (rel.startsWith(".git/") || rel.includes("/node_modules/") || rel.startsWith("artifacts/")) continue;
  const name = rel.split("/").at(-1);
  if (forbiddenNames.has(name)) failures.push("Forbidden private file: " + rel);
  if (!textExtensions.has(extname(file)) && name !== ".gitignore") continue;
  const content = await readFile(file, "utf8");
  if (/AIza[0-9A-Za-z_-]{30,}/.test(content)) failures.push("Possible Google API key: " + rel);
  if (/gh[opusr]_[0-9A-Za-z]{30,}/.test(content)) failures.push("Possible GitHub token: " + rel);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) failures.push("Private key: " + rel);
  if (/"refresh_token"\s*:\s*"(?!example|redacted)/i.test(content)) failures.push("Possible refresh token: " + rel);
}

const marketplace = JSON.parse(await readFile(join(root, ".agents", "plugins", "marketplace.json"), "utf8"));
if (marketplace.name !== "levnet-moodle") failures.push("Unexpected marketplace name.");
if (marketplace.plugins?.[0]?.name !== "levnet-moodle-integration") failures.push("Unexpected plugin id.");

const manifest = JSON.parse(await readFile(join(root, "apps", "calendar-web", "src", "appsscript.json"), "utf8"));
if (manifest.oauthScopes.some((scope) => scope.includes("spreadsheets") || scope.endsWith("/auth/calendar"))) {
  failures.push("Calendar manifest requests a broad scope.");
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("Public release surface validated.");

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
