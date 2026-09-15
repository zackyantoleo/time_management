const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "assets/js/calendar.js"),
  "utf8",
);
const context = vm.createContext({
  Intl,
  Date,
  Math,
  Set,
  URL,
  console,
  worklog: [],
  saves: 0,
  saveWorklogTanpaSinkron() { context.saves++; },
  localDateStr(date) {
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
  },
});
vm.runInContext(source, context);

const event = {
  id: "event-123",
  summary: "Weekly grooming",
  start: "2026-09-15T02:00:00.000Z",
  end: "2026-09-15T03:30:00.000Z",
  allDay: false,
};
const first = vm.runInContext(`calendarEventToWorklog(${JSON.stringify(event)})`, context);
const second = vm.runInContext(`calendarEventToWorklog(${JSON.stringify(event)})`, context);

assert.equal(first.text, "Weekly grooming");
assert.equal(first.date, "2026-09-15");
assert.equal(first.ts, event.start);
assert.equal(first.mins, 90);
assert.equal(first.priority, "kalender");
assert.equal(first.calendarEventKey, second.calendarEventKey, "same calendar event must be idempotent");
assert.equal(first.id, second.id, "same calendar event must keep the same log id");
assert.equal(first.jiraLogged, undefined, "calendar import must not mark Jira as logged");

assert.equal(
  vm.runInContext(`importCalendarEventsToWorklog([${JSON.stringify(event)}, ${JSON.stringify(event)}, { summary: "Absen Pulang", start: "2026-09-15T10:00:00.000Z" }])`, context),
  true,
);
assert.equal(vm.runInContext("worklog.length", context), 1, "duplicate calendar fetch must not duplicate log");
assert.equal(vm.runInContext("saves", context), 1, "calendar import persists only when it adds an entry");
assert.equal(vm.runInContext("importCalendarEventsToWorklog([" + JSON.stringify(event) + "])", context), false);
assert.equal(vm.runInContext("worklog[0].calendarEvent", context), true);
assert.equal(vm.runInContext("worklog[0].jiraLogged", context), undefined);

assert.equal(
  vm.runInContext('shouldImportCalendarEvent({ summary: "Absen Pulang" })', context),
  false,
  "Absen Pulang must never enter the work log",
);
assert.equal(
  vm.runInContext('shouldImportCalendarEvent({ summary: "Meeting absen pulang?" })', context),
  false,
  "case-insensitive Absen Pulang exclusion",
);
assert.equal(
  vm.runInContext('shouldImportCalendarEvent({ summary: "Absen Masuk" })', context),
  true,
);

console.log("PASS calendar to worklog mapping");
