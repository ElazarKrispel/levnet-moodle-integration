const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { calendarPatchResource_, redactError_, validateFeedUrl_ } = require("../src/Code.js");

const validFeed = "https://moodle.jct.ac.il/calendar/export_execute.php?userid=42&authtoken=secret&preset_what=all&preset_time=recentupcoming";

test("manifest is a per-user standalone web app with narrow Calendar access", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "src", "appsscript.json"), "utf8"));
  assert.equal(manifest.webapp.executeAs, "USER_ACCESSING");
  assert.equal(manifest.webapp.access, "ANYONE");
  assert.ok(manifest.oauthScopes.includes("https://www.googleapis.com/auth/calendar.app.created"));
  assert.ok(!manifest.oauthScopes.includes("https://www.googleapis.com/auth/calendar"));
  assert.ok(!manifest.oauthScopes.some((scope) => scope.includes("spreadsheets")));
  assert.ok(!manifest.oauthScopes.includes("https://www.googleapis.com/auth/script.container.ui"));
  assert.deepEqual(manifest.urlFetchWhitelist, ["https://moodle.jct.ac.il/calendar/export_execute.php"]);
  assert.equal(manifest.dependencies.enabledAdvancedServices[0].serviceId, "calendar");
});

test("feed validation accepts only the reviewed JCT all-events export", () => {
  assert.equal(validateFeedUrl_(validFeed), validFeed);
  assert.throws(() => validateFeedUrl_(validFeed.replace("moodle.jct.ac.il", "evil.example")), /moodle\.jct\.ac\.il/);
  assert.throws(() => validateFeedUrl_(validFeed.replace("preset_what=all", "preset_what=user")), /כל אירועי Moodle/);
  assert.throws(() => validateFeedUrl_(validFeed.replace("authtoken=secret&", "")), /מפתח יומן/);
});

test("errors redact calendar feed URLs and bearer query values", () => {
  const message = redactError_(new Error("Failed " + validFeed));
  assert.doesNotMatch(message, /secret|authtoken=secret|userid=42/);
  assert.match(message, /redacted/);
});

test("Calendar patch bodies never attempt to change an existing event ID", () => {
  const resource = calendarPatchResource_({ id: "lmi12345", summary: "Task" });
  assert.deepEqual(resource, { summary: "Task" });
});

test("server surface stores the feed only in UserProperties and never uses Sheets or logging", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "Code.js"), "utf8");
  assert.doesNotMatch(source, /(?:Logger|console)\s*\./);
  assert.doesNotMatch(source, /SpreadsheetApp/);
  assert.match(source, /function doGet\(\)/);
  assert.match(source, /function getStatus\(\)/);
  assert.match(source, /moodleFeedUrl:\s*validateFeedUrl_\(feedUrl\)/);
  assert.doesNotMatch(source, /moodleFeedUrl:\s*properties\.getProperty/);
});

test("daily trigger is user-owned, time based, and pinned to Israel time", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "Code.js"), "utf8");
  assert.match(source, /newTrigger\(LMI_DAILY_HANDLER\)/);
  assert.match(source, /\.atHour\(6\)/);
  assert.match(source, /\.nearMinute\(30\)/);
  assert.match(source, /\.inTimezone\(LMI_TIME_ZONE\)/);
  assert.doesNotMatch(source, /forSpreadsheet|onEdit|onOpen/);
});

test("the browser page treats the feed as a password and never persists it locally", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "Index.html"), "utf8");
  assert.match(html, /id="feed" type="password"/);
  assert.match(html, /callServer\("previewFeed", feed\)/);
  assert.doesNotMatch(html, /localStorage|sessionStorage|console\s*\./);
  assert.match(html, /confirm\("לנתק את הסנכרון/);
});
