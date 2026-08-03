import { z } from "zod";

const scalarId = z.union([z.string().min(1).max(200), z.number().int().nonnegative()]);
const optionalFilter = z.union([scalarId, z.null()]).optional();
const pagedQuery = z.object({
  selectedAcademicYear: optionalFilter,
  selectedSemester: optionalFilter,
  current: z.number().int().positive().optional(),
  pageSize: z.number().int().min(1).max(500).optional(),
}).strict();
const responseObject = z.object({ success: z.boolean().optional() }).passthrough();

const READ_OPERATIONS = [
  read("student.tests.filters", "/api/student/Tests", "LoadFilters", z.object({}).strict()),
  read("student.tests.list", "/api/student/Tests", "LoadTests", pagedQuery),
  read("student.grades.filters", "/api/student/grades", "LoadFilters", z.object({}).strict()),
  read("student.grades.list", "/api/student/grades", "LoadGrades", pagedQuery),
  read("student.notebooks.filters", "/api/student/testNotebooks", "LoadFilters", z.object({}).strict()),
  read("student.notebooks.search", "/api/student/testNotebooks", "SearchQuery", pagedQuery.extend({
    selectedTestTimeType: optionalFilter,
  }).strict()),
  read("student.useful-forms.list", "/api/student/files", "LoadCategiriesWithUsefulForms", z.object({}).strict()),
  read("student.actual-courses.filters", "/api/common/actualCourses", "LoadFilters", z.object({}).strict()),
  read("student.actual-courses.list", "/api/common/actualCourses", "LoadActualCourses", pagedQuery),
  read("student.schedule.filters", "/api/student/schedule", "LoadFilters", z.object({}).strict()),
  read("student.test-registration.list", "/api/student/TestReg", "LoadTestsForReg", z.object({}).strict()),
];

const DOWNLOAD_OPERATIONS = [
  download("student.notebooks.download", "/api/student/testNotebooks", "DownloadNotebook", { notebookId: scalarId }),
  download("student.announcements.download", "/api/student/PersonalAnnouncements", "DownloadFile", { fileId: scalarId }),
  download("student.receipts.credit-payment", "/api/student/accountCreditPayments", "DownloadReceipt", { eTafnitReceiptNumber: scalarId }),
  download("student.receipts.voucher", "/api/student/accountVouchers", "DownloadReceipt", { voucherIdentity: scalarId }),
  download("student.receipts.voucher-masav", "/api/student/accountVouchers", "DownloadReceiptByMasav", { voucherIdentity: scalarId }),
  download("student.vouchers.download", "/api/student/accountVouchers", "DownloadVoucher", { academicYearName: scalarId }),
  download("student.account-operations.document", "/api/student/accountoperations", "DownloadAccountOperationDocument", { selectedAcademicYear: scalarId }),
  download("student.certificates.courses", "/api/student/certificates", "DownloadCoursesConfirmationCertificate", { academicYearId: scalarId }),
  download("student.certificates.grades", "/api/student/certificates", "DownloadGradesSheet", { selectedLanguage: z.string().min(1).max(20) }),
  download("student.certificates.maternity-leave", "/api/student/certificates", "DownloadMaternityLeaveCertificate", { maternityLeaveId: scalarId }),
  download("student.certificates.miluim", "/api/student/certificates", "DownloadMiluimCertificate", { studentMiluimId: scalarId }),
  download("student.certificates.schedule", "/api/student/certificates", "DownloadScheduleCertificate", { selectedAcademicYear: scalarId }),
  download("student.certificates.studying", "/api/student/certificates", "DownloadStudyingCertificate", { selectedLanguage: z.string().min(1).max(20) }),
  download("student.certificates.test", "/api/student/certificates", "DownloadTestCertificate", { academicYearId: scalarId }),
  download("student.certificates.dorms", "/api/student/certificates", "DownloadDormsCertificate"),
  download("student.certificates.registration-accepted", "/api/student/certificates", "DownloadRegistrationAcceptedCertificate"),
  download("student.certificates.completion-year", "/api/student/certificates", "DownloadShnatHashlamaCertificate"),
  download("student.certificates.tuition", "/api/student/certificates", "DownloadTuitionCertificate"),
  download("student.course-registration.certificate", "/api/student/RegWarningsForCourses", "DownloadCertificate"),
  download("student.dorms.regulations", "/api/student/Dorms", "downloadRegulations", { dormId: scalarId }),
];

const REGISTRY = new Map([...READ_OPERATIONS, ...DOWNLOAD_OPERATIONS].map((operation) => [operation.id, Object.freeze(operation)]));

export function listLevnetCapabilities({ kind } = {}) {
  return [...REGISTRY.values()]
    .filter((operation) => !kind || operation.kind === kind)
    .map(publicOperation)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function getLevnetOperation(operationId, expectedKind) {
  const operation = REGISTRY.get(operationId);
  if (!operation) throw new Error(`Levnet operation is not allowlisted: ${operationId}`);
  if (expectedKind && operation.kind !== expectedKind) {
    throw new Error(`Levnet operation ${operationId} is ${operation.kind}, not ${expectedKind}.`);
  }
  return operation;
}

export function parseOperationInput(operation, input = {}) {
  return operation.inputSchema.parse(input);
}

export function buildOperationRequest(operation, input = {}) {
  const parsed = parseOperationInput(operation, input);
  if (operation.kind === "download") {
    const url = new URL(`${operation.handler}.ashx`, "https://levnet.jct.ac.il");
    url.searchParams.set("action", operation.action);
    for (const [key, value] of Object.entries(parsed)) url.searchParams.set(key, String(value));
    return { method: "GET", url: url.toString(), body: null };
  }
  return {
    method: operation.method,
    url: `${operation.handler}.ashx?action=${encodeURIComponent(operation.action)}`,
    body: JSON.stringify(parsed),
  };
}

export function parseOperationResponse(operation, value) {
  return operation.outputSchema.parse(value);
}

function read(id, handler, action, inputSchema) {
  return {
    id,
    version: 1,
    kind: "read",
    risk: "read",
    handler,
    action,
    method: "POST",
    inputSchema,
    outputSchema: responseObject,
    redirects: ["https://levnet.jct.ac.il"],
  };
}

function download(id, handler, action, shape = {}) {
  return {
    id,
    version: 1,
    kind: "download",
    risk: "download",
    handler,
    action,
    method: "GET",
    inputSchema: z.object(shape).strict(),
    outputSchema: z.object({
      path: z.string(),
      fileName: z.string(),
      size: z.number().int().nonnegative(),
      contentType: z.string(),
      sourceUrl: z.string().url(),
    }),
    redirects: ["https://levnet.jct.ac.il"],
  };
}

function publicOperation(operation) {
  return {
    id: operation.id,
    version: operation.version,
    kind: operation.kind,
    risk: operation.risk,
    handler: operation.handler,
    action: operation.action,
    method: operation.method,
  };
}
