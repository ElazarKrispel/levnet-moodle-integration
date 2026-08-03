import assert from "node:assert/strict";
import test from "node:test";

import { parseCookieHeader, cookieNames } from "../scripts/lib/levnet/cookie.mjs";
import { endpointInventoryFromBundle, extractCallSites, isReadOnlyAction } from "../scripts/lib/levnet/discovery.mjs";
import { buildOperationRequest, getLevnetOperation, listLevnetCapabilities } from "../scripts/lib/levnet/registry.mjs";
import { headersForRedirect, validateRequestUrl } from "../scripts/lib/levnet/http.mjs";
import { redactSensitive } from "../scripts/lib/format.mjs";

test("parseCookieHeader keeps a normalized full cookie header", () => {
  const parsed = parseCookieHeader("Cookie: ASP.NET_SessionId=abc; X-LevNet-Token=header.payload.sig; TS01ea2c90=xyz");
  assert.equal(parsed, "ASP.NET_SessionId=abc; X-LevNet-Token=header.payload.sig; TS01ea2c90=xyz");
  assert.deepEqual(cookieNames(parsed), ["ASP.NET_SessionId", "TS01ea2c90", "X-LevNet-Token"]);
});

test("parseCookieHeader rejects unrelated cookies", () => {
  assert.equal(parseCookieHeader("foo=bar; baz=qux"), null);
});

test("endpointInventoryFromBundle extracts handlers, actions, and pages", () => {
  const bundle = String.raw`
    "./student/tests/tests.ts":function(t,e,n){var s="/api/student/Tests";e.post({handler:s,action:"LoadFilters"});e.post({handler:s,action:"LoadTests"});return"/Course/ActualCourse.aspx?ActualCourseID="+id}
    "./student/files.ts":function(t,e,n){e.post({handler:"/api/student/files",action:"LoadCategiriesWithUsefulForms"});e.post({handler:"/api/student/files",action:"UploadFile"});}
  `;
  const inventory = endpointInventoryFromBundle(bundle);
  assert.equal(inventory.counts.apiHandlers, 2);
  assert.equal(inventory.apiActions.some((item) => item.handler === "/api/student/Tests" && item.action === "LoadFilters"), true);
  assert.equal(inventory.apiActions.some((item) => item.handler === "/api/student/files" && item.action === "UploadFile"), true);
  assert.equal(inventory.pages.some((item) => item.path.startsWith("/Course/ActualCourse.aspx")), true);
});

test("call-site extraction does not cross-pair handlers and actions from one module", () => {
  const moduleText = String.raw`"./mixed.ts":function(){var a="/api/student/Tests",b="/api/student/grades";client.post({handler:a,action:"LoadTests",json:q});client.post({handler:b,action:"LoadGrades",json:g})}`;
  const calls = extractCallSites(moduleText, "./mixed.ts");
  assert.deepEqual(calls.map(({ handler, action }) => ({ handler, action })), [
    { handler: "/api/student/Tests", action: "LoadTests" },
    { handler: "/api/student/grades", action: "LoadGrades" },
  ]);
  assert.equal(calls.some((item) => item.handler === "/api/student/Tests" && item.action === "LoadGrades"), false);
});

test("call-site extraction maps direct download parameters", () => {
  const moduleText = String.raw`"./notebooks.ts":function(){var s="/api/student/testNotebooks";return s+".ashx?action=DownloadNotebook&notebookId="+item.id}`;
  const calls = extractCallSites(moduleText, "./notebooks.ts");
  assert.deepEqual(calls[0].parameters, { kind: "query", keys: ["notebookId"] });
  assert.equal(calls[0].method, "GET");
});

test("isReadOnlyAction classifies obvious read and write actions", () => {
  assert.equal(isReadOnlyAction("LoadFilters"), true);
  assert.equal(isReadOnlyAction("GetStudentData"), true);
  assert.equal(isReadOnlyAction("UploadTavYarok"), false);
  assert.equal(isReadOnlyAction("UpdateSignature"), false);
});

test("redactSensitive removes OAuth-like values", () => {
  const redacted = redactSensitive("https://x.test/cb?code=abc123&state=verylongsecretvalue X-LevNet-Token=abcdef0123456789abcdef0123456789abcdef0123456789");
  assert.match(redacted, /code=\[redacted\]/);
  assert.match(redacted, /state=\[redacted\]/);
  assert.doesNotMatch(redacted, /abcdef0123456789/);
});

test("secure redirect policy blocks downgrade and strips cross-origin credentials", () => {
  assert.throws(() => validateRequestUrl("http://levnet.jct.ac.il/file"), /HTTPS/);
  assert.throws(() => validateRequestUrl("https://evil.example/file"), /not allowlisted/);
  const headers = headersForRedirect({
    Cookie: "secret",
    Authorization: "Bearer secret",
    Accept: "application/pdf",
  }, "https://levnet.jct.ac.il/a", "https://files.example/b");
  assert.deepEqual(headers, { Accept: "application/pdf" });
});

test("only manually registered Levnet operations are executable", () => {
  assert.throws(() => getLevnetOperation("student.arbitrary.SaveEverything"), /not allowlisted/);
  const operation = getLevnetOperation("student.notebooks.download", "download");
  const request = buildOperationRequest(operation, { notebookId: 42 });
  assert.match(request.url, /action=DownloadNotebook/);
  assert.match(request.url, /notebookId=42/);
  assert.equal(listLevnetCapabilities().some((item) => item.id === "student.notebooks.download"), true);
});
