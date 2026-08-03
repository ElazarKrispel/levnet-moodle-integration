/* Pure synchronization logic shared by Apps Script and the Node test suite. */

var LMI_SYNC_SCHEMA_VERSION = "2";
var LMI_SYNC_SOURCE = "levnet-moodle-integration";
var LMI_DEFAULT_ASSIGNMENT_PATTERNS = [
  "^\\s*יש להגיש את\\s+['\"״]?(.+?)['\"״]?\\s*$",
  "^\\s*Submit\\s+['\"]?(.+?)['\"]?\\s*$",
  "^\\s*(.+?)\\s+is due\\s*$",
  "^\\s*Assignment due:\\s*(.+?)\\s*$"
];

function parseIcs(text) {
  var source = String(text || "");
  if (!/BEGIN:VCALENDAR/i.test(source) || !/END:VCALENDAR/i.test(source)) {
    throw new Error("The Moodle response is not a complete iCalendar feed.");
  }
  var lines = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  var events = [];
  var current = null;
  var malformed = 0;
  lines.forEach(function (line) {
    if (/^BEGIN:VEVENT$/i.test(line)) {
      current = {};
      return;
    }
    if (/^END:VEVENT$/i.test(line)) {
      if (current) {
        try {
          events.push(normalizeIcsEvent_(current));
        } catch (error) {
          malformed += 1;
        }
      }
      current = null;
      return;
    }
    if (!current || !line) return;
    var property = parsePropertyLine_(line);
    if (!property) return;
    if (!current[property.name]) current[property.name] = [];
    current[property.name].push(property);
  });
  if (malformed > 0) throw new Error("One or more iCalendar events were malformed; no calendar changes were made.");
  return { events: events, rawEventCount: events.length };
}

function selectAssignments(parsed, patternSources) {
  var patterns = compilePatterns_(patternSources || LMI_DEFAULT_ASSIGNMENT_PATTERNS);
  var assignments = [];
  var skipped = [];
  (parsed.events || []).forEach(function (event) {
    var match = matchAssignmentTitle_(event.summary, patterns);
    if (!match) {
      skipped.push({ uid: event.uid, summary: event.summary, reason: "title_not_recognized" });
      return;
    }
    assignments.push({
      uid: event.uid,
      assignmentName: stripWrappingQuotes_(match),
      courseName: event.categories[0] || "",
      dueMs: event.startMs,
      sourceSummary: event.summary
    });
  });
  return { assignments: assignments, skipped: skipped, rawEventCount: parsed.rawEventCount };
}

function buildGoogleEvent(assignment, digestFunction) {
  if (!assignment || !assignment.uid || !Number.isFinite(assignment.dueMs)) {
    throw new Error("Cannot build a Google event without a Moodle UID and due time.");
  }
  var due = new Date(assignment.dueMs);
  var start = new Date(assignment.dueMs - 60 * 60 * 1000);
  var course = String(assignment.courseName || "").trim();
  var name = String(assignment.assignmentName || assignment.sourceSummary || "Moodle assignment").trim();
  return {
    id: deterministicGoogleEventId(assignment.uid, digestFunction),
    summary: course ? "[" + course + "] " + name : name,
    description: [
      course ? "Course: " + course : null,
      "Automatically synchronized from Moodle by Levnet & Moodle Integration.",
      "Moodle calendar: https://moodle.jct.ac.il/calendar/view.php"
    ].filter(Boolean).join("\n"),
    start: { dateTime: start.toISOString() },
    end: { dateTime: due.toISOString() },
    status: "confirmed",
    transparency: "transparent",
    reminders: {
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 10020 },
        { method: "popup", minutes: 1380 },
        { method: "popup", minutes: 60 }
      ]
    },
    extendedProperties: {
      private: {
        source: LMI_SYNC_SOURCE,
        uid: assignment.uid,
        schemaVersion: LMI_SYNC_SCHEMA_VERSION
      }
    }
  };
}

function deterministicGoogleEventId(uid, digestFunction) {
  var digest = digestFunction ? digestFunction(String(uid)) : appsScriptDigest_(String(uid));
  var hex = Array.prototype.map.call(digest, function (value) {
    return ((value < 0 ? value + 256 : value) + 256).toString(16).slice(-2);
  }).join("");
  if (hex.length < 40) throw new Error("SHA-256 digest is too short.");
  return "lmi" + hex.slice(0, 40);
}

function planReconciliation(sourceEvents, existingEvents, nowMs) {
  var sourceById = {};
  (sourceEvents || []).forEach(function (event) { sourceById[event.id] = event; });
  var existingById = {};
  (existingEvents || []).forEach(function (event) { existingById[event.id] = event; });
  var plan = { create: [], update: [], markMissing: [], remove: [], unchanged: [] };

  Object.keys(sourceById).forEach(function (id) {
    var desired = sourceById[id];
    var existing = existingById[id];
    if (!existing) {
      plan.create.push(desired);
    } else if (!sameManagedEvent_(desired, existing)) {
      var updateResource = desired;
      var existingPrivate = ((existing.extendedProperties || {}).private || {});
      if (existingPrivate.missingSince) {
        updateResource = JSON.parse(JSON.stringify(desired));
        updateResource.extendedProperties.private.missingSince = null;
      }
      plan.update.push(updateResource);
    } else {
      plan.unchanged.push(id);
    }
  });

  Object.keys(existingById).forEach(function (id) {
    if (sourceById[id]) return;
    var existing = existingById[id];
    var privateProperties = ((existing.extendedProperties || {}).private || {});
    if (privateProperties.source !== LMI_SYNC_SOURCE) return;
    var missingSince = Date.parse(privateProperties.missingSince || "");
    if (Number.isFinite(missingSince) && nowMs - missingSince >= 24 * 60 * 60 * 1000) {
      plan.remove.push(id);
    } else if (!Number.isFinite(missingSince)) {
      plan.markMissing.push({
        id: id,
        extendedProperties: {
          private: Object.assign({}, privateProperties, { missingSince: new Date(nowMs).toISOString() })
        }
      });
    }
  });
  return plan;
}

function parsePropertyLine_(line) {
  var colon = line.indexOf(":");
  if (colon < 1) return null;
  var head = line.slice(0, colon).split(";");
  var name = head.shift().toUpperCase();
  var params = {};
  head.forEach(function (part) {
    var equals = part.indexOf("=");
    if (equals > 0) params[part.slice(0, equals).toUpperCase()] = part.slice(equals + 1).replace(/^"|"$/g, "");
  });
  return { name: name, params: params, value: line.slice(colon + 1) };
}

function normalizeIcsEvent_(properties) {
  var uid = firstValue_(properties.UID);
  var summary = unescapeIcsText_(firstValue_(properties.SUMMARY));
  var startProperty = properties.DTSTART && properties.DTSTART[0];
  if (!uid || !summary || !startProperty) throw new Error("VEVENT is missing UID, SUMMARY, or DTSTART.");
  var categories = [];
  (properties.CATEGORIES || []).forEach(function (property) {
    splitEscapedCommas_(property.value).forEach(function (value) {
      var decoded = unescapeIcsText_(value).trim();
      if (decoded) categories.push(decoded);
    });
  });
  return {
    uid: unescapeIcsText_(uid),
    summary: summary,
    categories: categories,
    startMs: parseIcsDateTime_(startProperty.value, startProperty.params)
  };
}

function parseIcsDateTime_(value, params) {
  var input = String(value || "").trim();
  var match = input.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?$/);
  if (!match) throw new Error("Unsupported DTSTART value.");
  var parts = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4] || 0), minute: Number(match[5] || 0), second: Number(match[6] || 0)
  };
  if (match[7]) return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  var timeZone = params.TZID || "Asia/Jerusalem";
  return zonedDateTimeToUtc_(parts, timeZone);
}

function zonedDateTimeToUtc_(parts, timeZone) {
  var wallClockUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  var guess = wallClockUtc;
  for (var i = 0; i < 3; i += 1) {
    var offset = timeZoneOffsetMinutes_(guess, timeZone);
    var next = wallClockUtc - offset * 60 * 1000;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

function timeZoneOffsetMinutes_(epochMs, timeZone) {
  if (typeof Utilities !== "undefined" && Utilities.formatDate) {
    var formatted = Utilities.formatDate(new Date(epochMs), timeZone, "Z");
    var sign = formatted.charAt(0) === "-" ? -1 : 1;
    return sign * (Number(formatted.slice(1, 3)) * 60 + Number(formatted.slice(3, 5)));
  }
  var formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  });
  var values = {};
  formatter.formatToParts(new Date(epochMs)).forEach(function (part) { values[part.type] = part.value; });
  var asUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second));
  return Math.round((asUtc - epochMs) / 60000);
}

function appsScriptDigest_(value) {
  if (typeof Utilities === "undefined") throw new Error("A SHA-256 digest implementation is required.");
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8);
}

function compilePatterns_(sources) {
  if (!Array.isArray(sources) || sources.length === 0) throw new Error("At least one assignment title pattern is required.");
  return sources.map(function (source) {
    try { return new RegExp(source, "iu"); } catch (error) { throw new Error("Invalid assignment title pattern: " + source); }
  });
}

function matchAssignmentTitle_(summary, patterns) {
  for (var i = 0; i < patterns.length; i += 1) {
    var match = String(summary || "").match(patterns[i]);
    if (match) return match[1] || match[0];
  }
  return null;
}

function sameManagedEvent_(desired, existing) {
  var desiredPrivate = ((desired.extendedProperties || {}).private || {});
  var existingPrivate = ((existing.extendedProperties || {}).private || {});
  var desiredShape = {
    summary: desired.summary,
    description: desired.description,
    start: desired.start,
    end: desired.end,
    status: desired.status,
    transparency: desired.transparency,
    reminders: normalizeReminders_(desired.reminders),
    privateProperties: {
      source: desiredPrivate.source,
      uid: desiredPrivate.uid,
      schemaVersion: desiredPrivate.schemaVersion,
      missingSince: desiredPrivate.missingSince || null
    }
  };
  var existingShape = {
    summary: existing.summary,
    description: existing.description,
    start: { dateTime: normalizeDateTime_(existing.start && existing.start.dateTime) },
    end: { dateTime: normalizeDateTime_(existing.end && existing.end.dateTime) },
    status: existing.status,
    transparency: existing.transparency,
    reminders: normalizeReminders_(existing.reminders),
    privateProperties: {
      source: existingPrivate.source,
      uid: existingPrivate.uid,
      schemaVersion: existingPrivate.schemaVersion,
      missingSince: existingPrivate.missingSince || null
    }
  };
  desiredShape.start.dateTime = normalizeDateTime_(desiredShape.start.dateTime);
  desiredShape.end.dateTime = normalizeDateTime_(desiredShape.end.dateTime);
  return canonicalJson_(desiredShape) === canonicalJson_(existingShape);
}

function normalizeReminders_(reminders) {
  var value = reminders || {};
  return {
    useDefault: Boolean(value.useDefault),
    overrides: (value.overrides || []).map(function (item) {
      return { method: item.method, minutes: Number(item.minutes) };
    }).sort(function (left, right) {
      return left.minutes - right.minutes || String(left.method).localeCompare(String(right.method));
    })
  };
}

function normalizeDateTime_(value) {
  var parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value || "");
}

function canonicalJson_(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson_).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(function (key) { return JSON.stringify(key) + ":" + canonicalJson_(value[key]); }).join(",") + "}";
  }
  return JSON.stringify(value);
}

function firstValue_(properties) {
  return properties && properties[0] ? properties[0].value : "";
}

function unescapeIcsText_(value) {
  return String(value || "")
    .replace(/\\[nN]/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function splitEscapedCommas_(value) {
  var parts = [];
  var current = "";
  var escaped = false;
  String(value || "").split("").forEach(function (character) {
    if (character === "," && !escaped) {
      parts.push(current);
      current = "";
    } else {
      current += character;
    }
    if (character === "\\" && !escaped) escaped = true;
    else escaped = false;
  });
  parts.push(current);
  return parts;
}

function stripWrappingQuotes_(value) {
  return String(value || "").trim().replace(/^[\s'\"״“”]+|[\s'\"״“”]+$/g, "");
}

if (typeof module !== "undefined") {
  module.exports = {
    LMI_DEFAULT_ASSIGNMENT_PATTERNS: LMI_DEFAULT_ASSIGNMENT_PATTERNS,
    LMI_SYNC_SCHEMA_VERSION: LMI_SYNC_SCHEMA_VERSION,
    LMI_SYNC_SOURCE: LMI_SYNC_SOURCE,
    buildGoogleEvent: buildGoogleEvent,
    deterministicGoogleEventId: deterministicGoogleEventId,
    parseIcs: parseIcs,
    planReconciliation: planReconciliation,
    selectAssignments: selectAssignments
  };
}
