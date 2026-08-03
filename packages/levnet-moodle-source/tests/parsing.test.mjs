import test from "node:test";
import assert from "node:assert/strict";

import { parseMoodleCookie } from "../scripts/lib/cookie.mjs";
import { extractCalendarExportUrl, extractMoodleUserId, extractSesskey } from "../scripts/lib/moodle.mjs";

test("parseMoodleCookie accepts a bare session value", () => {
  assert.equal(parseMoodleCookie("abc123DEF456"), "abc123DEF456");
});

test("parseMoodleCookie extracts MoodleSessiondev from a Cookie header", () => {
  assert.equal(
    parseMoodleCookie("_ga=ignored; MoodleSessiondev=ke70jthedf4l7l0e6ftl9045gp; twk=ignored"),
    "ke70jthedf4l7l0e6ftl9045gp",
  );
});

test("parseMoodleCookie rejects unsafe values", () => {
  assert.equal(parseMoodleCookie("MoodleSessiondev=<script>"), null);
});

test("extractSesskey reads Moodle JSON config", () => {
  assert.equal(extractSesskey('M.cfg = {"sesskey":"BvzyinShSl"};'), "BvzyinShSl");
});

test("extractMoodleUserId reads the authenticated page identity", () => {
  assert.equal(extractMoodleUserId('<body data-userid="4821">'), "4821");
  assert.equal(extractMoodleUserId('<a href="/user/profile.php?id=73">Profile</a>'), "73");
});

test("extractCalendarExportUrl accepts only the reviewed JCT feed shape", () => {
  const token = "a".repeat(64);
  const html = `<a href="https://moodle.jct.ac.il/calendar/export_execute.php?userid=42&amp;authtoken=${token}&amp;preset_what=all&amp;preset_time=recentupcoming">feed</a>`;
  const url = new URL(extractCalendarExportUrl(html));
  assert.equal(url.hostname, "moodle.jct.ac.il");
  assert.equal(url.searchParams.get("authtoken"), token);
  assert.equal(url.searchParams.get("preset_what"), "all");
});

test("extractCalendarExportUrl rejects another host and incomplete feeds", () => {
  assert.throws(() => extractCalendarExportUrl(
    "https://evil.example/calendar/export_execute.php?userid=42&authtoken=x&preset_what=all&preset_time=recentupcoming",
  ));
  assert.throws(() => extractCalendarExportUrl(
    "https://moodle.jct.ac.il/calendar/export_execute.php?userid=42&authtoken=x&preset_what=user&preset_time=recentupcoming",
  ));
});
