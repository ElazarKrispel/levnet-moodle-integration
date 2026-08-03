import { execFileSync } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

if (process.platform !== "win32") {
  throw new Error("The local Windows executable build must run on Windows.");
}

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = resolve(sourceRoot, "..", "..", "plugins", "levnet-moodle-integration");
const buildRoot = resolve(sourceRoot, ".sea-build");
const binRoot = resolve(pluginRoot, "bin");
const bundleFile = resolve(buildRoot, "server.cjs");
const configFile = resolve(buildRoot, "sea-config.json");
const blobFile = resolve(buildRoot, "sea-prep.blob");
const executableFile = resolve(binRoot, "levnet-moodle-integration-win-x64.exe");

await rm(buildRoot, { recursive: true, force: true });
await mkdir(buildRoot, { recursive: true });
await mkdir(binRoot, { recursive: true });

await build({
  entryPoints: [resolve(sourceRoot, "scripts", "sea-entry.mjs")],
  outfile: bundleFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  minify: false,
  sourcemap: false,
  legalComments: "none"
});

await writeFile(configFile, JSON.stringify({
  main: bundleFile,
  output: blobFile,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false
}, null, 2));

execFileSync(process.execPath, ["--experimental-sea-config", configFile], { stdio: "inherit" });
await copyFile(process.execPath, executableFile);

execFileSync(process.execPath, [
  resolve(sourceRoot, "node_modules", "postject", "dist", "cli.js"),
  executableFile, "NODE_SEA_BLOB", blobFile,
  "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  "--overwrite"
], { stdio: "inherit" });

await rm(buildRoot, { recursive: true, force: true });
console.log("Built " + executableFile);
