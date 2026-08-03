#!/usr/bin/env node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  downloadOperation,
  readOperation,
  refreshCookie,
  sessionStatus,
} from "./lib/levnet/levnet.mjs";
import { createLevnetActionService } from "./lib/levnet/actions.mjs";

let status = await sessionStatus({ promptIfExpired: false });
if (!status.authenticated && status.hasCredentials) {
  await refreshCookie({ prompt: false });
  status = await sessionStatus({ promptIfExpired: false });
}
if (!status.authenticated) {
  throw new Error(`Levnet smoke test requires an authenticated local session (${status.reason ?? "unknown"}).`);
}

const filters = await readOperation({ operationId: "student.notebooks.filters" });
const notebooks = await readOperation({
  operationId: "student.notebooks.search",
  input: { current: 1, pageSize: 10 },
});
const items = Array.isArray(notebooks.data?.items) ? notebooks.data.items : [];
const summary = {
  authenticated: true,
  filtersLoaded: Boolean(filters.data),
  notebookCount: items.length,
  downloadTested: false,
  actionPrepared: false,
};

if (process.env.LMI_SMOKE_DOWNLOAD === "1" && items[0]?.id != null) {
  const outputDir = await mkdtemp(join(tmpdir(), "levnet-moodle-smoke-"));
  try {
    const downloaded = await downloadOperation({
      operationId: "student.notebooks.download",
      input: { notebookId: items[0].id },
      outputDir,
    });
    summary.downloadTested = downloaded.downloaded.size > 0;
    summary.downloadSize = downloaded.downloaded.size;
    summary.downloadContentType = downloaded.downloaded.contentType;
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

if (process.env.LMI_SMOKE_PREPARE === "1") {
  const registrations = await readOperation({ operationId: "student.test-registration.list" });
  const candidate = registrations.data?.tests?.find((item) => !item.isStudentReg && item.actualCourseTestId != null);
  if (candidate) {
    try {
      const prepared = await createLevnetActionService().prepare({
        operationId: "student.test-registration.register",
        input: { actualCourseTestId: candidate.actualCourseTestId },
      });
      summary.actionPrepared = Boolean(prepared.prepareToken);
      summary.actionExecuted = false;
    } catch (error) {
      if (!/account identity is unavailable/i.test(error?.message ?? "")) throw error;
      summary.actionPrepareSkipped = "The existing cookie-only session has no Microsoft tenant/object claims; a fresh identity-bearing sign-in is required.";
    }
  }
}

console.log(JSON.stringify(summary, null, 2));
