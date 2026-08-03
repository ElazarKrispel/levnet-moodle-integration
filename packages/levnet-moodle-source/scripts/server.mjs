#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { formatToolResult } from "./lib/format.mjs";
import { onboardingStatus, setupReadiness } from "./lib/onboarding.mjs";
import {
  clearStoredSession as clearMoodleSession, downloadResources, getAssignment, listCalendarEvents, listCourses,
  refreshCookie as refreshMoodle, sessionStatus as moodleStatus, setupCredentials as setupMoodleCredentials,
} from "./lib/moodle.mjs";
import {
  capabilities as levnetCapabilities, clearStoredSession as clearLevnetSession,
  downloadOperation as downloadLevnetOperation, endpointInventory, readOperation as readLevnetOperation,
  refreshCookie as refreshLevnet, sessionStatus as levnetStatus, setupCredentials as setupLevnetCredentials,
} from "./lib/levnet/levnet.mjs";
import { createLevnetActionService } from "./lib/levnet/actions.mjs";
import { createMoodleCalendarPairingService } from "./lib/moodleCalendarPairing.mjs";
import { migrateLegacySecrets } from "./lib/legacyMigration.mjs";

const levnetActions = createLevnetActionService();
const moodleCalendarPairing = createMoodleCalendarPairingService();

export const server = new McpServer(
  { name: "levnet-moodle-integration", version: "2.0.0" },
  { instructions: "Independent Levnet and JCT Moodle tools. Start with lmi_status and prefer these tools over UI automation. Levnet discovery is metadata-only; only manually reviewed operation IDs are executable. Mutations and calendar-feed pairing require prepare, explicit confirmation, and a single-use account-bound token. The private Moodle calendar URL is copied only through a local secure dialog and must never be returned in chat or tool output. Use lmi_preflight only for setup diagnostics. Computer Use is allowed only when preflight reports onboarding.useComputerUse=true because the authenticator seed is missing. Once credentials are complete, never use Computer Use for authentication. Secrets are collected by local secure dialogs and protected by the operating system; never request them in chat. Moodle and Levnet share Microsoft credentials but keep separate sessions." },
);

server.tool("lmi_status", {}, async () => formatToolResult(await combinedStatus()));
server.tool("lmi_preflight", {}, async () => formatToolResult(await onboardingStatus()));
server.tool("lmi_setup", {
  target: z.enum(["all", "moodle", "levnet"]).optional().default("all"),
  authenticatorReady: z.boolean().optional().default(false).describe("Set true only after the user has completed the one-time authenticator setup and has the base32 setup key ready for the local secure dialog."),
}, async ({ target, authenticatorReady }) => formatToolResult(await setup(target, authenticatorReady)));
server.tool("lmi_refresh_sessions", {
  target: z.enum(["all", "moodle", "levnet"]).optional().default("all"),
  prompt: z.boolean().optional().default(true),
}, async ({ target, prompt }) => formatToolResult(await refresh(target, prompt)));
server.tool("lmi_clear_sessions", { alsoCredentials: z.boolean().optional().default(false) }, async ({ alsoCredentials }) => formatToolResult({
  moodle: await clearMoodleSession({ alsoCredentials }),
  levnet: await clearLevnetSession({ alsoCredentials }),
}));

server.tool("lmi_moodle_courses", {
  classification: z.enum(["all", "inprogress", "future", "past", "favourites", "hidden"]).optional().default("all"),
  limit: z.number().int().min(0).max(500).optional().default(0),
  offset: z.number().int().min(0).optional().default(0),
  sort: z.enum(["fullname", "shortname", "id", "ul.timeaccess desc"]).optional().default("fullname"),
}, async (input) => formatToolResult(await listCourses(input)));
server.tool("lmi_moodle_calendar_events", {
  daysBack: z.number().int().min(0).max(365).optional().default(7),
  daysAhead: z.number().int().min(1).max(365).optional().default(120),
  limit: z.number().int().min(1).max(20).optional().default(20),
}, async (input) => formatToolResult(await listCalendarEvents(input)));
server.tool("lmi_moodle_prepare_calendar_pairing", {}, async () =>
  formatToolResult(await moodleCalendarPairing.prepare()));
server.tool("lmi_moodle_execute_calendar_pairing", {
  prepareToken: z.string().min(1),
  confirm: z.boolean(),
}, async (input) => formatToolResult(await moodleCalendarPairing.execute(input)));
server.tool("lmi_moodle_assignment", { cmid: z.number().int().positive().optional(), url: z.string().url().optional() }, async (input) => formatToolResult(await getAssignment(input)));
server.tool("lmi_moodle_download_resources", {
  outputDir: z.string().min(1),
  resources: z.array(z.object({ url: z.string().url(), name: z.string().min(1) })).min(1).max(50),
}, async (input) => formatToolResult(await downloadResources(input)));

server.tool("lmi_levnet_endpoint_inventory", {}, async () => formatToolResult(await endpointInventory()));
server.tool("lmi_levnet_capabilities", {
  kind: z.enum(["read", "download"]).optional(),
}, async (input) => formatToolResult({
  data: await levnetCapabilities(input),
  actions: levnetActions.capabilities(),
}));
server.tool("lmi_levnet_read", {
  operationId: z.string().min(1),
  input: z.record(z.string(), z.unknown()).optional().default({}),
}, async (input) => formatToolResult(await readLevnetOperation(input)));
server.tool("lmi_levnet_download", {
  operationId: z.string().min(1),
  input: z.record(z.string(), z.unknown()).optional().default({}),
  outputDir: z.string().min(1),
  fileName: z.string().min(1).optional(),
  overwrite: z.boolean().optional().default(false),
}, async (input) => formatToolResult(await downloadLevnetOperation(input)));
server.tool("lmi_levnet_test_notebooks", {
  selectedAcademicYear: z.union([z.string(), z.number(), z.null()]).optional(),
  selectedSemester: z.union([z.string(), z.number(), z.null()]).optional(),
  selectedTestTimeType: z.union([z.string(), z.number(), z.null()]).optional(),
  current: z.number().int().positive().optional(),
  pageSize: z.number().int().min(1).max(500).optional(),
}, async (input) => formatToolResult(await readLevnetOperation({ operationId: "student.notebooks.search", input })));
server.tool("lmi_levnet_download_notebook", {
  notebookId: z.union([z.string().min(1), z.number().int().nonnegative()]),
  outputDir: z.string().min(1),
  fileName: z.string().min(1).optional(),
  overwrite: z.boolean().optional().default(false),
}, async ({ notebookId, ...options }) => formatToolResult(await downloadLevnetOperation({
  operationId: "student.notebooks.download",
  input: { notebookId },
  ...options,
})));
server.tool("lmi_levnet_grades", {
  selectedAcademicYear: z.union([z.string(), z.number(), z.null()]).optional(),
  selectedSemester: z.union([z.string(), z.number(), z.null()]).optional(),
  current: z.number().int().positive().optional(),
  pageSize: z.number().int().min(1).max(500).optional(),
}, async (input) => formatToolResult(await readLevnetOperation({ operationId: "student.grades.list", input })));
server.tool("lmi_levnet_tests", {
  selectedAcademicYear: z.union([z.string(), z.number(), z.null()]).optional(),
  selectedSemester: z.union([z.string(), z.number(), z.null()]).optional(),
  current: z.number().int().positive().optional(),
  pageSize: z.number().int().min(1).max(500).optional(),
}, async (input) => formatToolResult(await readLevnetOperation({ operationId: "student.tests.list", input })));
server.tool("lmi_levnet_prepare_action", {
  operationId: z.string().min(1),
  input: z.record(z.string(), z.unknown()).optional().default({}),
}, async (input) => formatToolResult(await levnetActions.prepare(input)));
server.tool("lmi_levnet_execute_action", {
  prepareToken: z.string().min(1),
  confirm: z.boolean(),
  confirmHighRisk: z.boolean().optional().default(false),
}, async (input) => formatToolResult(await levnetActions.execute(input)));
server.tool("lmi_levnet_reconcile_action", {
  prepareToken: z.string().min(1),
}, async (input) => formatToolResult(await levnetActions.reconcile(input)));
server.tool("lmi_levnet_upload", {
  operationId: z.string().min(1),
  filePath: z.string().min(1),
  input: z.record(z.string(), z.unknown()).optional().default({}),
}, async (input) => formatToolResult(await levnetActions.upload(input)));
server.tool("lmi_levnet_open_official_flow", {
  flowId: z.enum([
    "student.credit-payment",
    "student.voucher-payment",
    "student.standing-order",
    "student.appeal",
    "student.request",
  ]),
}, async (input) => formatToolResult(await levnetActions.officialFlow(input)));
server.tool("lmi_doctor", {}, async () => formatToolResult({ node: process.version, status: await combinedStatus(), inventory: await endpointInventory() }));

async function combinedStatus() {
  const migration = await migrateLegacySecrets();
  const [moodle, levnet, preflight] = await Promise.allSettled([moodleStatus({ promptIfExpired: false }), levnetStatus({ promptIfExpired: false }), onboardingStatus()]);
  return { migration, moodle: settledValue(moodle), levnet: settledValue(levnet), preflight: settledValue(preflight) };
}

async function setup(target, authenticatorReady) {
  const readiness = await setupReadiness({ authenticatorReady });
  if (!readiness.canStart) return readiness;
  if (target === "moodle") return { moodle: await setupMoodleCredentials() };
  if (target === "levnet") return { levnet: await setupLevnetCredentials() };
  const moodle = await setupMoodleCredentials();
  const levnet = await refreshLevnet({ prompt: false });
  return { moodle, levnet };
}

async function refresh(target, prompt) {
  if (target === "moodle") return { moodle: await refreshMoodle({ prompt }) };
  if (target === "levnet") return { levnet: await refreshLevnet({ prompt }) };
  const [moodle, levnet] = await Promise.allSettled([refreshMoodle({ prompt }), refreshLevnet({ prompt: false })]);
  return { moodle: settledValue(moodle), levnet: settledValue(levnet) };
}

function settledValue(result) {
  return result.status === "fulfilled" ? result.value : { error: result.reason instanceof Error ? result.reason.message : String(result.reason) };
}

export async function main() {
  await migrateLegacySecrets();
  await server.connect(new StdioServerTransport());
  console.error("Levnet & Moodle Integration MCP server running on stdio");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error("Fatal error starting Levnet & Moodle Integration MCP server:", error); process.exit(1); });
}
