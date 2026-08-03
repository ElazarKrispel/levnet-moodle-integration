# Levnet API Surface

Generated from Levnet's public Angular bundle and validated with a local
authenticated cookie session on 2026-04-26.

## Architecture Observations

- Levnet is an ASP.NET application serving Angular components from
  `/dist/app.bundle.js`.
- Client calls use `.ashx` handlers shaped as:
  `/api/<area>/<resource>.ashx?action=<Action>&nocache=<timestamp>`.
- Most data reads are `POST` requests with JSON bodies.
- The browser carries Levnet session state through cookies, including
  `ASP.NET_SessionId` and `X-LevNet-Token`.
- The Microsoft OAuth login flow creates the Levnet session; the Moodle
  `MoodleSessiondev` cookie is not accepted by Levnet.

## Discovery Counts

- API handlers: 85
- API handler/action pairs: 272
- Read-looking actions: 195
- Pages: 89

## Main Areas

- `api/student`: 40 handlers, 155 actions, 112 read-looking actions.
- `api/common`: shared account, announcements, actual courses, files, schedule
  and survey helpers.
- `api/lecturer`: appeals, exams, questionnaires, grades, schedule and course
  management.
- `api/admin`, `api/employee`, `api/Secretariat`: staff and operational
  workflows, with some read actions but also obvious mutation actions.
- `api/home`: login, registration, password recovery, localization and timeout.

## Student Data That Appears Fetchable

- Weekly schedule and schedule list.
- Tests/exams table.
- Grades and grade filters.
- Grade charts and averages.
- Course part grades.
- Account operations, vouchers, fees, standing order and credit-payment state.
- Certificates availability for tuition, grades sheet, dorms, schedule,
  studying, tests, maternity leave, miluim and registration acceptance.
- Useful forms/files.
- Personal announcements, requests and student conditions.
- Appeals and test notebooks.
- Dorms, gym, lockers, dining room and printing state.
- Scholarships and scholarship statement state.
- Course registration warnings, test registration options and future tests.
- Beit Midrash attendance data.

## Validated Read Endpoint Shapes

The connector successfully validated these read endpoints with an authenticated
session:

- `/api/student/schedule:LoadFilters`
  Returns `academicYears`, `semesters`, `selectedAcademicYear`,
  `selectedSemester`, `success`.
- `/api/student/Tests:LoadFilters`
  Returns `academicYears`, `semesters`, `success`.
- `/api/student/Tests:LoadTests`
  Returns paged `items` with pagination metadata.
- `/api/student/grades:LoadFilters`
  Returns `academicYears`, `semesters`, `success`.
- `/api/student/grades:LoadGrades`
  Returns paged `items` with pagination metadata.
- `/api/student/certificates:LoadDataForTuitionCertificate`
  Returns certificate availability/blocking state.
- `/api/student/files:LoadCategiriesWithUsefulForms`
  Returns categories and forms.
- `/api/student/accountoperations:LoadData`
  Returns account-operation filter state.
- `/api/common/actualCourses:LoadFilters`
  Returns course filter state.
- `/api/common/actualCourses:LoadActualCourses`
  Returns paged course `items`.

Some endpoints need request parameters from their companion filter endpoint.
For example, `LoadWeeklySchedule` needs the selected academic year/semester
payload returned by `LoadFilters`.

## Safety Rules

- Treat all responses as private student data.
- Default to read-looking actions: `Load*`, `Get*`, `List*`, `Search*`,
  `Download*`.
- Avoid actions like `Save*`, `Update*`, `Insert*`, `Upload*`, `Delete*`,
  `Pay*`, `Register*`, `Approve*`, `Cancel*`, `Validate*`, `Change*`,
  `Submit*`, and `Extend*` unless the user explicitly requests a write action.

