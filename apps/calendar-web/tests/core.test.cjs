const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  LMI_DEFAULT_ASSIGNMENT_PATTERNS,
  buildGoogleEvent,
  deterministicGoogleEventId,
  parseIcs,
  planReconciliation,
  selectAssignments,
} = require("../src/Core.js");

const digest = (value) => [...crypto.createHash("sha256").update(value).digest()];

test("parses real JCT-style Hebrew ICS including folded lines, escaped categories, UTC and TZID", () => {
  const parsed = parseIcs(fixture("jct-hebrew.ics"));
  assert.equal(parsed.rawEventCount, 3);
  assert.equal(parsed.events[1].summary, "יש להגיש את 'מטלה ארוכה עם שורה מקופלת'");
  assert.equal(parsed.events[1].categories[0], "מבוא, מתקדם");
  assert.equal(new Date(parsed.events[0].startMs).toISOString(), "2026-08-10T18:00:00.000Z");
  assert.equal(new Date(parsed.events[1].startMs).toISOString(), "2026-12-01T10:00:00.000Z");
});

test("selects Hebrew and English Moodle assignment titles and reports skipped course events", () => {
  const hebrew = selectAssignments(parseIcs(fixture("jct-hebrew.ics")), LMI_DEFAULT_ASSIGNMENT_PATTERNS);
  assert.equal(hebrew.assignments.length, 2);
  assert.equal(hebrew.assignments[0].assignmentName, "Word Processing Task 6");
  assert.equal(hebrew.skipped.length, 1);

  const english = selectAssignments(parseIcs(fixture("jct-english.ics")), LMI_DEFAULT_ASSIGNMENT_PATTERNS);
  assert.deepEqual(english.assignments.map((item) => item.assignmentName), ["Database project", "Algorithms worksheet"]);
});

test("buildGoogleEvent creates a stable transparent one-hour deadline event with exact reminders", () => {
  const assignment = {
    uid: "98231@moodle.jct.ac.il",
    assignmentName: "Task 6",
    courseName: "Computer Applications",
    dueMs: Date.parse("2026-08-10T18:00:00Z")
  };
  const event = buildGoogleEvent(assignment, digest);
  assert.match(event.id, /^lmi[0-9a-f]{40}$/);
  assert.equal(event.start.dateTime, "2026-08-10T17:00:00.000Z");
  assert.equal(event.end.dateTime, "2026-08-10T18:00:00.000Z");
  assert.equal(event.transparency, "transparent");
  assert.equal(event.status, "confirmed");
  assert.deepEqual(event.reminders.overrides.map((item) => item.minutes), [10020, 1380, 60]);
  assert.equal(event.extendedProperties.private.uid, assignment.uid);
});

test("deterministic IDs are idempotent and differ for distinct Moodle UIDs", () => {
  assert.equal(deterministicGoogleEventId("same", digest), deterministicGoogleEventId("same", digest));
  assert.notEqual(deterministicGoogleEventId("one", digest), deterministicGoogleEventId("two", digest));
});

test("reconciliation creates, updates and preserves identical managed events without duplicates", () => {
  const desired = buildGoogleEvent({
    uid: "one@moodle", assignmentName: "Task", courseName: "Course", dueMs: Date.parse("2026-08-10T18:00:00Z")
  }, digest);
  const initial = planReconciliation([desired], [], Date.parse("2026-08-01T00:00:00Z"));
  assert.equal(initial.create.length, 1);

  const identical = planReconciliation([desired], [JSON.parse(JSON.stringify(desired))], Date.parse("2026-08-01T00:00:00Z"));
  assert.equal(identical.unchanged.length, 1);
  assert.equal(identical.create.length, 0);

  const googleFormatted = JSON.parse(JSON.stringify(desired));
  googleFormatted.start.dateTime = googleFormatted.start.dateTime.replace(".000Z", "Z");
  googleFormatted.end.dateTime = googleFormatted.end.dateTime.replace(".000Z", "Z");
  assert.equal(planReconciliation([desired], [googleFormatted], Date.parse("2026-08-01T00:00:00Z")).unchanged.length, 1);

  const changed = JSON.parse(JSON.stringify(desired));
  changed.summary = "Old title";
  const update = planReconciliation([desired], [changed], Date.parse("2026-08-01T00:00:00Z"));
  assert.equal(update.update.length, 1);
});

test("a reappearing source event clears its old missing marker", () => {
  const desired = buildGoogleEvent({
    uid: "back@moodle", assignmentName: "Back", courseName: "Course", dueMs: Date.parse("2026-08-10T18:00:00Z")
  }, digest);
  const existing = JSON.parse(JSON.stringify(desired));
  existing.extendedProperties.private.missingSince = "2026-08-01T00:00:00.000Z";
  const plan = planReconciliation([desired], [existing], Date.parse("2026-08-02T00:00:00Z"));
  assert.equal(plan.update.length, 1);
  assert.equal(plan.update[0].extendedProperties.private.missingSince, null);
});

test("missing events are marked first and deleted only after 24 hours", () => {
  const existing = buildGoogleEvent({
    uid: "missing@moodle", assignmentName: "Missing", courseName: "Course", dueMs: Date.parse("2026-08-10T18:00:00Z")
  }, digest);
  const firstAt = Date.parse("2026-08-01T00:00:00Z");
  const first = planReconciliation([], [existing], firstAt);
  assert.equal(first.markMissing.length, 1);
  assert.equal(first.remove.length, 0);

  existing.extendedProperties.private.missingSince = new Date(firstAt).toISOString();
  const beforeGrace = planReconciliation([], [existing], firstAt + 23 * 60 * 60 * 1000);
  assert.equal(beforeGrace.remove.length, 0);
  const afterGrace = planReconciliation([], [existing], firstAt + 24 * 60 * 60 * 1000);
  assert.deepEqual(afterGrace.remove, [existing.id]);
});

test("malformed or incomplete ICS fails before reconciliation", () => {
  assert.throws(() => parseIcs("not a calendar"), /not a complete/);
  assert.throws(() => parseIcs("BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nEND:VEVENT\nEND:VCALENDAR"), /malformed/);
});

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, "..", "fixtures", name), "utf8");
}
