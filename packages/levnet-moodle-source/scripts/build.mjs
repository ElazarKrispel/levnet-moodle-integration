#!/usr/bin/env node

import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputFile = resolve(sourceRoot, "..", "..", "plugins", "levnet-moodle-integration", "dist", "server.mjs");

await build({
  entryPoints: [resolve(sourceRoot, "scripts", "server.mjs")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  banner: {
    js: [
      "// Generated from packages/levnet-moodle-source. Do not edit directly.",
      "import { createRequire as __lmiCreateRequire } from 'node:module';",
      "const require = __lmiCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});

console.log(`Built ${outputFile}`);
