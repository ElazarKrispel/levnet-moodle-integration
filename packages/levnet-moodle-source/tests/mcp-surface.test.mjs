import assert from "node:assert/strict";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = resolve(pluginRoot, "..", "..", "plugins", "levnet-moodle-integration");
const expectedTools = [
  "lmi_clear_sessions",
  "lmi_doctor",
  "lmi_levnet_capabilities",
  "lmi_levnet_download",
  "lmi_levnet_download_notebook",
  "lmi_levnet_endpoint_inventory",
  "lmi_levnet_grades",
  "lmi_levnet_execute_action",
  "lmi_levnet_open_official_flow",
  "lmi_levnet_prepare_action",
  "lmi_levnet_read",
  "lmi_levnet_reconcile_action",
  "lmi_levnet_test_notebooks",
  "lmi_levnet_tests",
  "lmi_levnet_upload",
  "lmi_moodle_assignment",
  "lmi_moodle_calendar_events",
  "lmi_moodle_execute_calendar_pairing",
  "lmi_moodle_courses",
  "lmi_moodle_download_resources",
  "lmi_moodle_prepare_calendar_pairing",
  "lmi_preflight",
  "lmi_refresh_sessions",
  "lmi_setup",
  "lmi_status",
].sort();

test("MCP server starts and exposes the unified onboarding and provider tools", async () => {
  await assertToolSurface({ cwd: pluginRoot, entrypoint: "scripts/server.mjs" });
});

test("bundled release exposes the same MCP tool surface", async () => {
  await assertToolSurface({ cwd: releaseRoot, entrypoint: "dist/server.mjs" });
});

test("bundled MCP config resolves its relative entrypoint from the plugin root", async () => {
  const config = JSON.parse(await readFile(resolve(releaseRoot, ".mcp.json"), "utf8"));
  assert.equal(config.mcpServers?.levnet_moodle?.cwd, ".");
  assert.equal(config.mcpServers?.levnet_moodle?.args?.[0], "./dist/server.mjs");
});

async function assertToolSurface({ cwd, entrypoint }) {
  const client = new Client({ name: "levnet-moodle-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint],
    cwd,
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, expectedTools);
  } finally {
    await client.close();
  }
}
