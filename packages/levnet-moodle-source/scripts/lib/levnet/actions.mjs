import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { readSecret, writeSecret } from "../platform/secretStore.mjs";
import { ensureSession, readAccountBindingMaterial, readOperation } from "./levnet.mjs";
import { levnetRequest } from "./http.mjs";

const BASE_URL = "https://levnet.jct.ac.il";
const ACTION_SERVICE = "codex-levnet-moodle-actions";
const HMAC_ACCOUNT = "prepare-token-hmac";
const ACCOUNT_BINDING_HMAC = "account-binding-hmac";
const STATE_ACCOUNT = "prepare-token-state";
const TOKEN_TTL_MS = 5 * 60 * 1000;

const idSchema = z.union([z.string().min(1).max(200), z.number().int().nonnegative()]);
const mutationResponse = z.object({
  success: z.boolean(),
  error: z.unknown().optional(),
}).passthrough();

const MUTATIONS = new Map([
  mutation({
    id: "student.test-registration.register",
    handler: "/api/student/TestReg",
    action: "Reg",
    inputSchema: z.object({ actualCourseTestId: idSchema }).strict(),
    risk: "high",
    summary: "Register for the selected Levnet test",
    target: (input) => ({ actualCourseTestId: input.actualCourseTestId }),
    match: (item, input) => String(item.actualCourseTestId) === String(input.actualCourseTestId),
    desired: (item) => Boolean(item?.isStudentReg),
  }),
  mutation({
    id: "student.test-registration.cancel",
    handler: "/api/student/TestReg",
    action: "CancelReg",
    inputSchema: z.object({ studentTestRegistrationId: idSchema }).strict(),
    risk: "high",
    summary: "Cancel the selected Levnet test registration",
    target: (input) => ({ studentTestRegistrationId: input.studentTestRegistrationId }),
    match: (item, input) => String(item.studentTestRegistrationId) === String(input.studentTestRegistrationId),
    desired: (item) => !item?.isStudentReg,
  }),
].map((operation) => [operation.id, operation]));

const OFFICIAL_FLOWS = Object.freeze({
  "student.credit-payment": "/Student/AccountCreditPayments.aspx",
  "student.voucher-payment": "/Student/AccountVouchers.aspx",
  "student.standing-order": "/Student/StandingOrder.aspx",
  "student.appeal": "/Student/Appeals.aspx",
  "student.request": "/Student/Requests.aspx",
});

export function createLevnetActionService(overrides = {}) {
  const dependencies = {
    now: () => Date.now(),
    readSecret,
    writeSecret,
    readAccountIdentity: readAccountBindingMaterial,
    readOperation,
    ensureSession,
    sendMutation: defaultSendMutation,
    ...overrides,
  };

  return {
    capabilities: () => actionCapabilities(),
    prepare: (input) => prepareAction(input, dependencies),
    execute: (input) => executeAction(input, dependencies),
    reconcile: (input) => reconcileAction(input, dependencies),
    upload: (input) => uploadAction(input),
    officialFlow: (input) => officialFlow(input),
  };
}

export function actionCapabilities() {
  return {
    source: "manual-reviewed-allowlist",
    mutations: [...MUTATIONS.values()].map(({ id, version, risk, summary }) => ({ id, version, risk, summary })),
    uploads: [],
    officialFlows: Object.keys(OFFICIAL_FLOWS),
  };
}

async function prepareAction({ operationId, input = {} } = {}, dependencies) {
  const operation = requireMutation(operationId);
  const parsedInput = operation.inputSchema.parse(input);
  const account = await currentAccount(dependencies);
  const precondition = await loadPrecondition(operation, parsedInput, dependencies);
  const now = dependencies.now();
  const payload = {
    version: 1,
    nonce: randomUUID(),
    account,
    operationId: operation.id,
    operationVersion: operation.version,
    parametersHash: hashCanonical(parsedInput),
    preconditionHash: hashCanonical(precondition),
    issuedAt: now,
    expiresAt: now + TOKEN_TTL_MS,
  };
  const token = await signPayload(payload, dependencies);
  const state = await readState(dependencies);
  state.records[payload.nonce] = {
    payload,
    input: parsedInput,
    precondition,
    status: "prepared",
    createdAt: now,
  };
  await writeState(state, dependencies);
  return {
    operation: publicMutation(operation),
    preview: previewMutation(operation, parsedInput, precondition),
    prepareToken: token,
    expiresAt: new Date(payload.expiresAt).toISOString(),
    confirmationRequired: operation.risk === "high" ? "double" : "single",
  };
}

async function executeAction({ prepareToken, confirm = false, confirmHighRisk = false } = {}, dependencies) {
  if (!confirm) throw new Error("Explicit confirm=true is required.");
  const { payload, record, state } = await verifyAndLoadRecord(prepareToken, dependencies);
  const operation = requireMutation(payload.operationId);
  if (operation.risk === "high" && !confirmHighRisk) {
    throw new Error("This high-risk action also requires confirmHighRisk=true.");
  }

  const account = await currentAccount(dependencies);
  assertEqual(account, payload.account, "Prepare token belongs to another account.");
  assertEqual(hashCanonical(record.input), payload.parametersHash, "Prepared parameters no longer match.");
  const currentPrecondition = await loadPrecondition(operation, record.input, dependencies);
  assertEqual(hashCanonical(currentPrecondition), payload.preconditionHash, "Levnet state changed after prepare; create a new preview.");

  record.status = "in_flight";
  record.inFlightAt = dependencies.now();
  await writeState(state, dependencies);

  let outcome;
  try {
    const response = await dependencies.sendMutation(operation, record.input);
    if (!response || typeof response !== "object" || typeof response.success !== "boolean") {
      outcome = { status: "unknown_outcome", reason: "unparseable_response" };
    } else if (response.success) {
      outcome = { status: "succeeded", response };
    } else {
      outcome = { status: "failed", response };
    }
  } catch (error) {
    outcome = {
      status: "unknown_outcome",
      reason: "transport_error_after_dispatch",
      error: safeError(error),
    };
  }

  record.status = outcome.status;
  record.outcome = outcome;
  record.completedAt = dependencies.now();
  await writeState(state, dependencies);

  if (outcome.status === "unknown_outcome") {
    const reconciliation = await reconcileRecord(operation, record, dependencies);
    record.reconciliation = reconciliation;
    await writeState(state, dependencies);
    return { ...outcome, reconciliation, retryAllowed: false };
  }
  return { ...outcome, retryAllowed: false };
}

async function reconcileAction({ prepareToken } = {}, dependencies) {
  const { payload, record, state } = await verifyAndLoadRecord(prepareToken, dependencies, {
    allowedStatuses: ["in_flight", "unknown_outcome", "succeeded", "failed"],
    allowExpired: true,
  });
  const operation = requireMutation(payload.operationId);
  const reconciliation = await reconcileRecord(operation, record, dependencies);
  record.reconciliation = reconciliation;
  record.reconciledAt = dependencies.now();
  await writeState(state, dependencies);
  return { operationId: operation.id, originalStatus: record.status, reconciliation };
}

function uploadAction({ operationId } = {}) {
  throw new Error(`No upload operation is currently allowlisted${operationId ? `: ${operationId}` : "."}`);
}

function officialFlow({ flowId } = {}) {
  const path = OFFICIAL_FLOWS[flowId];
  if (!path) throw new Error(`Official Levnet flow is not allowlisted: ${flowId}`);
  return {
    flowId,
    url: new URL(path, BASE_URL).toString(),
    requiresUserInteraction: true,
    credentialsAcceptedInChat: false,
  };
}

async function defaultSendMutation(operation, input) {
  const session = await ensureSession();
  const response = await levnetRequest(`${operation.handler}.ashx?action=${encodeURIComponent(operation.action)}`, {
    method: operation.method,
    cookie: session.cookie,
    body: JSON.stringify(operation.target(input)),
    followRedirects: false,
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Origin: BASE_URL,
      Referer: `${BASE_URL}/Student/TestRegistration.aspx`,
      Accept: "application/json, text/plain, */*",
    },
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw Object.assign(new Error(`Levnet mutation returned HTTP ${response.statusCode}.`), { statusCode: response.statusCode });
  }
  let parsed;
  try { parsed = JSON.parse(response.text); } catch { return null; }
  return mutationResponse.parse(parsed);
}

async function loadPrecondition(operation, input, dependencies) {
  const result = await dependencies.readOperation({ operationId: "student.test-registration.list", input: {} });
  const items = Array.isArray(result.data?.tests) ? result.data.tests : [];
  const item = items.find((candidate) => operation.match(candidate, input)) ?? null;
  return {
    exists: Boolean(item),
    isStudentReg: Boolean(item?.isStudentReg),
    actualCourseTestId: item?.actualCourseTestId ?? input.actualCourseTestId ?? null,
    studentTestRegistrationId: item?.studentTestRegistrationId ?? input.studentTestRegistrationId ?? null,
    courseName: item?.courseName ?? null,
    courseFullNumber: item?.courseFullNumber ?? null,
    testDate: item?.testDate ?? null,
    finalDateForReg: item?.finalDateForReg ?? null,
    finalDateForCancelReg: item?.finalDateForCancelReg ?? null,
  };
}

async function reconcileRecord(operation, record, dependencies) {
  const current = await loadPrecondition(operation, record.input, dependencies);
  const applied = operation.desired(current);
  return {
    status: applied ? "applied" : "not_applied_or_indeterminate",
    applied,
    current,
  };
}

async function currentAccount(dependencies) {
  try {
    return await levnetSessionAccount(dependencies);
  } catch (error) {
    throw new Error("Levnet account identity is unavailable; refresh the session before preparing an action.", {
      cause: error,
    });
  }
}

async function levnetSessionAccount(dependencies) {
  const material = await dependencies.readAccountIdentity();
  if (!material?.ownerKeyNumber) {
    throw new Error("Levnet returned incomplete account identity.");
  }
  const key = await accountBindingKey(dependencies);
  const subject = createHmac("sha256", key)
    .update(canonicalJson({
      ownerKeyNumber: String(material.ownerKeyNumber),
      secondaryId: material.secondaryId == null ? null : String(material.secondaryId),
    }))
    .digest("base64url");
  return {
    authority: "levnet-session",
    tenant: "7b410031-6333-4080-9e61-afdbd57b3bd9",
    subject,
  };
}

async function verifyAndLoadRecord(token, dependencies, options = {}) {
  const payload = await verifyToken(token, dependencies);
  if (!options.allowExpired && payload.expiresAt < dependencies.now()) throw new Error("Prepare token expired.");
  const state = await readState(dependencies);
  const record = state.records[payload.nonce];
  if (!record) throw new Error("Prepare token state was not found.");
  const allowedStatuses = options.allowedStatuses ?? ["prepared"];
  if (!allowedStatuses.includes(record.status)) throw new Error(`Prepare token cannot be used from state ${record.status}.`);
  assertEqual(record.payload, payload, "Prepare token payload mismatch.");
  return { payload, record, state };
}

async function signPayload(payload, dependencies) {
  const encoded = Buffer.from(canonicalJson(payload)).toString("base64url");
  const key = await hmacKey(dependencies);
  const signature = createHmac("sha256", key).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

async function verifyToken(token, dependencies) {
  const [encoded, signature, extra] = String(token ?? "").split(".");
  if (!encoded || !signature || extra) throw new Error("Invalid prepare token.");
  const key = await hmacKey(dependencies);
  const expected = createHmac("sha256", key).update(encoded).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.toString("base64url") !== signature || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Invalid prepare token signature.");
  }
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid prepare token payload.");
  }
}

async function hmacKey(dependencies) {
  let encoded = await dependencies.readSecret(ACTION_SERVICE, HMAC_ACCOUNT);
  if (!encoded) {
    encoded = randomBytes(32).toString("base64url");
    await dependencies.writeSecret(ACTION_SERVICE, HMAC_ACCOUNT, encoded);
  }
  return Buffer.from(encoded, "base64url");
}

async function accountBindingKey(dependencies) {
  let encoded = await dependencies.readSecret(ACTION_SERVICE, ACCOUNT_BINDING_HMAC);
  if (!encoded) {
    encoded = randomBytes(32).toString("base64url");
    await dependencies.writeSecret(ACTION_SERVICE, ACCOUNT_BINDING_HMAC, encoded);
  }
  return Buffer.from(encoded, "base64url");
}

async function readState(dependencies) {
  const raw = await dependencies.readSecret(ACTION_SERVICE, STATE_ACCOUNT);
  let parsed = { version: 1, records: {} };
  if (raw) {
    try { parsed = JSON.parse(raw); } catch { parsed = { version: 1, records: {} }; }
  }
  const cutoff = dependencies.now() - 24 * 60 * 60 * 1000;
  parsed.records = Object.fromEntries(Object.entries(parsed.records ?? {})
    .filter(([, record]) => Number(record.createdAt) >= cutoff)
    .slice(-100));
  return parsed;
}

async function writeState(state, dependencies) {
  await dependencies.writeSecret(ACTION_SERVICE, STATE_ACCOUNT, JSON.stringify(state));
}

function mutation(definition) {
  return Object.freeze({ version: 1, method: "POST", ...definition });
}

function requireMutation(operationId) {
  const operation = MUTATIONS.get(operationId);
  if (!operation) throw new Error(`Levnet mutation is not allowlisted: ${operationId}`);
  return operation;
}

function previewMutation(operation, input, precondition) {
  return {
    summary: operation.summary,
    risk: operation.risk,
    parameters: input,
    currentState: precondition,
    retryPolicy: "never_retry_after_dispatch",
  };
}

function publicMutation(operation) {
  return {
    id: operation.id,
    version: operation.version,
    risk: operation.risk,
    summary: operation.summary,
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashCanonical(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("base64url");
}

function assertEqual(actual, expected, message) {
  const left = Buffer.from(hashCanonical(actual));
  const right = Buffer.from(hashCanonical(expected));
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error(message);
}

function safeError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    code: error?.code ?? null,
  };
}
