import assert from "node:assert/strict";
import test from "node:test";

import { createLevnetActionService } from "../scripts/lib/levnet/actions.mjs";

test("prepare token is account-bound, single-use, and executes an allowlisted mutation once", async () => {
  const fixture = actionFixture();
  const prepared = await fixture.service.prepare({
    operationId: "student.test-registration.register",
    input: { actualCourseTestId: 17 },
  });
  assert.equal(prepared.confirmationRequired, "double");
  const result = await fixture.service.execute({
    prepareToken: prepared.prepareToken,
    confirm: true,
    confirmHighRisk: true,
  });
  assert.equal(result.status, "succeeded");
  assert.equal(fixture.sendCount(), 1);
  await assert.rejects(() => fixture.service.execute({
    prepareToken: prepared.prepareToken,
    confirm: true,
    confirmHighRisk: true,
  }), /state succeeded/);
  assert.equal(fixture.sendCount(), 1);
});

test("prepare token rejects another account, tampering, and changed preconditions", async () => {
  const fixture = actionFixture();
  const prepared = await fixture.service.prepare({
    operationId: "student.test-registration.register",
    input: { actualCourseTestId: 17 },
  });
  fixture.setAccount({ tid: "tenant", oid: "other-user" });
  await assert.rejects(() => fixture.service.execute({
    prepareToken: prepared.prepareToken,
    confirm: true,
    confirmHighRisk: true,
  }), /another account/);

  fixture.setAccount({ tid: "tenant", oid: "user" });
  await assert.rejects(() => fixture.service.execute({
    prepareToken: `${prepared.prepareToken.slice(0, -1)}x`,
    confirm: true,
    confirmHighRisk: true,
  }), /signature/);

  fixture.setRegistered(true);
  await assert.rejects(() => fixture.service.execute({
    prepareToken: prepared.prepareToken,
    confirm: true,
    confirmHighRisk: true,
  }), /state changed/);
  assert.equal(fixture.sendCount(), 0);
});

test("transport ambiguity returns unknown_outcome, never retries, and reconciles by reading", async () => {
  const fixture = actionFixture({ ambiguous: true });
  const prepared = await fixture.service.prepare({
    operationId: "student.test-registration.register",
    input: { actualCourseTestId: 17 },
  });
  const result = await fixture.service.execute({
    prepareToken: prepared.prepareToken,
    confirm: true,
    confirmHighRisk: true,
  });
  assert.equal(result.status, "unknown_outcome");
  assert.equal(result.retryAllowed, false);
  assert.equal(result.reconciliation.status, "applied");
  assert.equal(fixture.sendCount(), 1);
  const reconciled = await fixture.service.reconcile({ prepareToken: prepared.prepareToken });
  assert.equal(reconciled.reconciliation.applied, true);
  assert.equal(fixture.sendCount(), 1);
});

test("prepare token expires and cannot send a mutation", async () => {
  const fixture = actionFixture();
  const prepared = await fixture.service.prepare({
    operationId: "student.test-registration.register",
    input: { actualCourseTestId: 17 },
  });
  fixture.advanceTime(5 * 60 * 1000 + 1);
  await assert.rejects(() => fixture.service.execute({
    prepareToken: prepared.prepareToken,
    confirm: true,
    confirmHighRisk: true,
  }), /expired/);
  assert.equal(fixture.sendCount(), 0);
});

test("uploads stay blocked and official flows are manually allowlisted", async () => {
  const fixture = actionFixture();
  assert.throws(
    () => fixture.service.upload({ operationId: "arbitrary-upload" }),
    /No upload operation is currently allowlisted/,
  );
  assert.equal(
    fixture.service.officialFlow({ flowId: "student.credit-payment" }).url,
    "https://levnet.jct.ac.il/Student/AccountCreditPayments.aspx",
  );
  assert.throws(
    () => fixture.service.officialFlow({ flowId: "arbitrary-flow" }),
    /not allowlisted/,
  );
});

function actionFixture({ ambiguous = false } = {}) {
  const secrets = new Map();
  let levnetIdentity = { ownerKeyNumber: "owner-1", secondaryId: "id-1" };
  let registered = false;
  let sends = 0;
  let now = 1_800_000_000_000;
  const testItem = () => ({
    actualCourseTestId: 17,
    studentTestRegistrationId: registered ? 91 : null,
    isStudentReg: registered,
    courseName: "Operating Systems",
    courseFullNumber: "123",
    testDate: "2026-08-01T09:00:00Z",
  });
  const service = createLevnetActionService({
    now: () => now,
    readSecret: async (serviceName, accountName) => secrets.get(`${serviceName}:${accountName}`) ?? null,
    writeSecret: async (serviceName, accountName, value) => secrets.set(`${serviceName}:${accountName}`, value),
    readAccountIdentity: async () => levnetIdentity,
    readOperation: async () => ({ data: { success: true, tests: [testItem()] } }),
    ensureSession: async () => ({ cookie: "test" }),
    sendMutation: async () => {
      sends += 1;
      registered = true;
      if (ambiguous) throw Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
      return { success: true, tests: [testItem()] };
    },
  });
  return {
    service,
    sendCount: () => sends,
    advanceTime: (milliseconds) => { now += milliseconds; },
    setAccount: (claims) => {
      levnetIdentity = claims?.oid === "other-user"
        ? { ownerKeyNumber: "owner-2", secondaryId: "id-2" }
        : { ownerKeyNumber: "owner-1", secondaryId: "id-1" };
    },
    setLevnetIdentity: (identity) => { levnetIdentity = identity; },
    setRegistered: (value) => { registered = value; },
  };
}

test("prepare falls back to an opaque Levnet session identity when OAuth token capture is unavailable", async () => {
  const fixture = actionFixture();
  const prepared = await fixture.service.prepare({
    operationId: "student.test-registration.register",
    input: { actualCourseTestId: 17 },
  });
  const [encoded] = prepared.prepareToken.split(".");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  assert.deepEqual(Object.keys(payload.account).sort(), ["authority", "subject", "tenant"]);
  assert.equal(payload.account.authority, "levnet-session");
  assert.equal(payload.account.tenant, "7b410031-6333-4080-9e61-afdbd57b3bd9");
  assert.match(payload.account.subject, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(payload).includes("owner-1"), false);
  assert.equal(JSON.stringify(payload).includes("id-1"), false);
});

test("Levnet fallback identity remains account-bound without exposing raw identifiers", async () => {
  const fixture = actionFixture();
  const prepared = await fixture.service.prepare({
    operationId: "student.test-registration.register",
    input: { actualCourseTestId: 17 },
  });
  fixture.setLevnetIdentity({ ownerKeyNumber: "owner-2", secondaryId: "id-2" });
  await assert.rejects(() => fixture.service.execute({
    prepareToken: prepared.prepareToken,
    confirm: true,
    confirmHighRisk: true,
  }), /another account/);
  assert.equal(fixture.sendCount(), 0);
});
