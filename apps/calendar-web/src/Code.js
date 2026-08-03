var LMI_APP_VERSION = "2.0.0";
var LMI_CALENDAR_NAME = "Moodle – Assignments";
var LMI_TIME_ZONE = "Asia/Jerusalem";
var LMI_FEED_HOST = "moodle.jct.ac.il";
var LMI_FEED_PATH = "/calendar/export_execute.php";
var LMI_DAILY_HANDLER = "dailySync";

function doGet() {
  return HtmlService.createHtmlOutputFromFile("Index")
    .setTitle("Levnet & Moodle Calendar")
    .addMetaTag("viewport", "width=device-width, initial-scale=1")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function getStatus() {
  var properties = PropertiesService.getUserProperties();
  var connected = Boolean(properties.getProperty("moodleFeedUrl"));
  var stats = parseJsonProperty_(properties.getProperty("lastRunStats"), null);
  return {
    appVersion: LMI_APP_VERSION,
    connected: connected,
    calendarName: connected ? LMI_CALENDAR_NAME : "",
    calendarUrl: connected ? "https://calendar.google.com/calendar/u/0/r" : "",
    lastSuccessfulSync: formatStoredDate_(properties.getProperty("lastSuccessfulSync")),
    nextAutomaticSync: connected && hasDailyTrigger_() ? nextSyncLabel_(new Date()) : "לא מותקן",
    automaticSyncInstalled: connected && hasDailyTrigger_(),
    stats: stats,
    lastError: properties.getProperty("lastError") || ""
  };
}

function previewFeed(feedUrl) {
  var selection = fetchAndSelectAssignments_(feedUrl);
  return {
    assignmentCount: selection.assignments.length,
    rawEventCount: selection.rawEventCount,
    skippedCount: selection.skipped.length,
    samples: selection.assignments.slice(0, 5).map(function (item) {
      return {
        title: item.assignmentName,
        course: item.courseName,
        dueAt: Utilities.formatDate(new Date(item.dueMs), LMI_TIME_ZONE, "dd/MM/yyyy HH:mm")
      };
    }),
    warning: selection.assignments.length === 0
      ? "הקישור תקין, אך לא זוהו בו הגשות. לא בוצע שום שינוי ביומן."
      : ""
  };
}

function completeSetup(feedUrl) {
  var selection = fetchAndSelectAssignments_(feedUrl);
  if (selection.assignments.length === 0) {
    throw new Error("הקישור תקין אך לא נמצאו בו הגשות מזוהות. לא בוצע שום שינוי ביומן.");
  }
  var properties = PropertiesService.getUserProperties();
  properties.setProperties({
    moodleFeedUrl: validateFeedUrl_(feedUrl),
    schemaVersion: LMI_SYNC_SCHEMA_VERSION,
    lastError: ""
  }, false);
  try {
    createOrGetCalendar_();
    installDailyTrigger_();
    var result = syncCalendar_("setup", selection);
    return { status: getStatus(), result: result };
  } catch (error) {
    properties.deleteProperty("moodleFeedUrl");
    properties.setProperty("lastError", redactError_(error));
    removeManagedTriggers_();
    throw new Error(redactError_(error));
  }
}

function syncNow() {
  return syncCalendar_("manual");
}

function dailySync() {
  return syncCalendar_("daily");
}

function repairTrigger() {
  if (!PropertiesService.getUserProperties().getProperty("moodleFeedUrl")) {
    throw new Error("החיבור טרם הוגדר.");
  }
  installDailyTrigger_();
  return getStatus();
}

function disconnectSync() {
  removeManagedTriggers_();
  PropertiesService.getUserProperties().deleteAllProperties();
  return getStatus();
}

function getRedactedDiagnostics() {
  var properties = PropertiesService.getUserProperties();
  return {
    appVersion: LMI_APP_VERSION,
    schemaVersion: properties.getProperty("schemaVersion") || "",
    connected: Boolean(properties.getProperty("moodleFeedUrl")),
    dailyTriggerCount: countDailyTriggers_(),
    lastSuccessfulSync: properties.getProperty("lastSuccessfulSync") || "",
    lastError: properties.getProperty("lastError") || ""
  };
}

function syncCalendar_(origin, prefetchedSelection) {
  var lock = LockService.getUserLock();
  if (!lock.tryLock(5000)) throw new Error("סנכרון אחר כבר פועל. נסה שוב בעוד דקה.");
  try {
    return runSync_({ origin: origin, prefetchedSelection: prefetchedSelection });
  } finally {
    lock.releaseLock();
  }
}

function runSync_(options) {
  var properties = PropertiesService.getUserProperties();
  var feedUrl = properties.getProperty("moodleFeedUrl");
  if (!feedUrl) throw new Error("החיבור טרם הוגדר.");
  try {
    var selection = options.prefetchedSelection || fetchAndSelectAssignments_(feedUrl);
    var calendar = createOrGetCalendar_();
    var existing = listManagedEvents_(calendar.id);
    if (selection.assignments.length === 0) {
      throw new Error("Moodle לא החזיר הגשות מזוהות. לא בוצע שום שינוי ביומן.");
    }
    var desired = selection.assignments.map(function (assignment) {
      return buildGoogleEvent(assignment);
    });
    var plan = planReconciliation(desired, existing, Date.now());
    var stats = applyPlan_(calendar.id, plan);
    stats.skipped = selection.skipped.length;
    stats.unchanged = plan.unchanged.length;
    stats.origin = String(options.origin || "unknown");
    stats.completedAt = new Date().toISOString();
    properties.setProperties({
      lastSuccessfulSync: stats.completedAt,
      lastRunStats: JSON.stringify(stats),
      lastError: ""
    }, false);
    return stats;
  } catch (error) {
    var safeMessage = redactError_(error);
    properties.setProperty("lastError", safeMessage);
    throw new Error(safeMessage);
  }
}

function fetchAndSelectAssignments_(feedUrl) {
  var safeUrl = validateFeedUrl_(feedUrl);
  var response = fetchWithRetry_(safeUrl);
  var contentType = String(response.getHeaders()["Content-Type"] || response.getHeaders()["content-type"] || "");
  var body = response.getContentText();
  if (contentType && !/calendar|text\/plain|octet-stream/i.test(contentType) && !/BEGIN:VCALENDAR/i.test(body)) {
    throw new Error("Moodle לא החזיר קובץ iCalendar תקין.");
  }
  var parsed = parseIcs(body);
  if (parsed.rawEventCount === 0) {
    throw new Error("קובץ היומן של Moodle ריק. לא בוצע שום שינוי ביומן.");
  }
  return selectAssignments(parsed, LMI_DEFAULT_ASSIGNMENT_PATTERNS);
}

function validateFeedUrl_(value) {
  var raw = String(value || "").trim();
  var match = raw.match(/^https:\/\/moodle\.jct\.ac\.il\/calendar\/export_execute\.php\?([^#]+)$/i);
  if (!match) {
    throw new Error("יש להשתמש רק בכתובת יצוא מאובטחת של moodle.jct.ac.il.");
  }
  var params = {};
  match[1].split("&").forEach(function (part) {
    var equals = part.indexOf("=");
    if (equals > 0) {
      params[decodeURIComponent(part.slice(0, equals))] = decodeURIComponent(part.slice(equals + 1));
    }
  });
  if (!params.authtoken || !params.userid) {
    throw new Error("כתובת היצוא חסרה מזהה משתמש או מפתח יומן.");
  }
  if (params.preset_what !== "all") {
    throw new Error("כתובת היצוא חייבת לכלול את כל אירועי Moodle; היישום יסנן מתוכם רק הגשות.");
  }
  return raw;
}

function fetchWithRetry_(url) {
  var delays = [0, 750, 2000, 5000];
  var lastStatus = null;
  for (var attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt]) Utilities.sleep(delays[attempt]);
    var response = UrlFetchApp.fetch(url, {
      method: "get",
      followRedirects: false,
      muteHttpExceptions: true,
      headers: { Accept: "text/calendar, text/plain;q=0.9" }
    });
    var status = response.getResponseCode();
    lastStatus = status;
    if (status >= 200 && status < 300) return response;
    if (status !== 429 && status < 500) break;
  }
  throw new Error("טעינת יומן Moodle נכשלה (HTTP " + lastStatus + "). ייתכן שצריך להפיק קישור חדש.");
}

function createOrGetCalendar_() {
  var properties = PropertiesService.getUserProperties();
  var calendarId = properties.getProperty("googleCalendarId");
  if (calendarId) {
    try {
      return calendarCall_(function () { return Calendar.Calendars.get(calendarId); });
    } catch (error) {
      properties.deleteProperty("googleCalendarId");
    }
  }
  var calendar = calendarCall_(function () {
    return Calendar.Calendars.insert({
      summary: LMI_CALENDAR_NAME,
      description: "מטלות והגשות שמסונכרנות אוטומטית מ-Moodle על ידי Levnet & Moodle Integration.",
      timeZone: LMI_TIME_ZONE
    });
  });
  properties.setProperty("googleCalendarId", calendar.id);
  return calendar;
}

function listManagedEvents_(calendarId) {
  var items = [];
  var pageToken;
  do {
    var result = calendarCall_(function () {
      return Calendar.Events.list(calendarId, {
        privateExtendedProperty: ["source=" + LMI_SYNC_SOURCE],
        showDeleted: false,
        maxResults: 2500,
        pageToken: pageToken
      });
    });
    items = items.concat(result.items || []);
    pageToken = result.nextPageToken;
  } while (pageToken);
  return items;
}

function applyPlan_(calendarId, plan) {
  var stats = { created: 0, updated: 0, markedMissing: 0, deleted: 0 };
  plan.create.forEach(function (event) {
    try {
      calendarCall_(function () { return Calendar.Events.insert(event, calendarId); });
      stats.created += 1;
    } catch (error) {
      if (!/409|already exists|duplicate/i.test(String(error && error.message || error))) throw error;
      calendarCall_(function () { return Calendar.Events.patch(calendarPatchResource_(event), calendarId, event.id); });
      stats.updated += 1;
    }
  });
  plan.update.forEach(function (event) {
    calendarCall_(function () { return Calendar.Events.patch(calendarPatchResource_(event), calendarId, event.id); });
    stats.updated += 1;
  });
  plan.markMissing.forEach(function (event) {
    calendarCall_(function () {
      return Calendar.Events.patch({ extendedProperties: event.extendedProperties }, calendarId, event.id);
    });
    stats.markedMissing += 1;
  });
  plan.remove.forEach(function (eventId) {
    calendarCall_(function () { return Calendar.Events.remove(calendarId, eventId); });
    stats.deleted += 1;
  });
  return stats;
}

function calendarPatchResource_(event) {
  var resource = JSON.parse(JSON.stringify(event));
  delete resource.id;
  return resource;
}

function calendarCall_(operation) {
  var delays = [0, 500, 1500, 3500];
  var error;
  for (var attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt]) Utilities.sleep(delays[attempt]);
    try {
      return operation();
    } catch (candidate) {
      error = candidate;
      if (!/429|rate|quota|500|502|503|504|backend/i.test(String(candidate && candidate.message || candidate))) throw candidate;
    }
  }
  throw error;
}

function installDailyTrigger_() {
  removeManagedTriggers_();
  var trigger = ScriptApp.newTrigger(LMI_DAILY_HANDLER)
    .timeBased()
    .atHour(6)
    .nearMinute(30)
    .everyDays(1)
    .inTimezone(LMI_TIME_ZONE)
    .create();
  PropertiesService.getUserProperties().setProperty("dailyTriggerUid", trigger.getUniqueId());
}

function removeManagedTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === LMI_DAILY_HANDLER) ScriptApp.deleteTrigger(trigger);
  });
  PropertiesService.getUserProperties().deleteProperty("dailyTriggerUid");
}

function hasDailyTrigger_() {
  return countDailyTriggers_() > 0;
}

function countDailyTriggers_() {
  return ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === LMI_DAILY_HANDLER;
  }).length;
}

function nextSyncLabel_(fromDate) {
  var tomorrow = new Date(fromDate.getTime() + 24 * 60 * 60 * 1000);
  return Utilities.formatDate(tomorrow, LMI_TIME_ZONE, "dd/MM/yyyy") + " סביב 06:30";
}

function formatStoredDate_(value) {
  if (!value) return "טרם בוצע";
  var date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "טרם בוצע";
  return Utilities.formatDate(date, LMI_TIME_ZONE, "dd/MM/yyyy HH:mm:ss");
}

function parseJsonProperty_(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (error) {
    return fallback;
  }
}

function redactError_(error) {
  return String(error && error.message || error || "שגיאה לא ידועה")
    .replace(/https:\/\/moodle\.jct\.ac\.il\/calendar\/export_execute\.php\?\S+/gi, "[calendar-feed-redacted]")
    .replace(/([?&](?:authtoken|userid)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 500);
}

if (typeof module !== "undefined") {
  module.exports = {
    calendarPatchResource_: calendarPatchResource_,
    redactError_: redactError_,
    validateFeedUrl_: validateFeedUrl_
  };
}
