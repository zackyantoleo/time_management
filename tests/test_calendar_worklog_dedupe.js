const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "assets/js/calendar.js"),
  "utf8",
);
const RealDate = Date;
const fixedNow = new RealDate("2026-09-15T12:00:00.000Z");
const localDateStr = (date) => date.getUTCFullYear() + "-" + String(date.getUTCMonth() + 1).padStart(2, "0") + "-" + String(date.getUTCDate()).padStart(2, "0");
class FixedDate extends RealDate {
  constructor(...args) { super(args.length ? args[0] : fixedNow); }
  static now() { return fixedNow.getTime(); }
}

const context = vm.createContext({
  Intl,
  Date: FixedDate,
  Math,
  Set,
  URL,
  console,
  worklog: [],
  saves: 0,
  saveWorklog() { context.saves++; },
  localDateStr,
});
vm.runInContext(source, context);

const withoutId = {
  summary: "Daily standup",
  start: "2026-09-15T02:00:00.000Z",
  end: "2026-09-15T02:30:00.000Z",
  allDay: false,
};
const withId = {
  ...withoutId,
  id: "uid-standup@example.com|2026-09-15T02:00:00.000Z",
};

assert.equal(
  vm.runInContext(`calendarEventKey(${JSON.stringify(withoutId)})`, context),
  vm.runInContext(`calendarEventKey(${JSON.stringify(withId)})`, context),
  "worker with/without UID must share one occurrence key",
);

assert.equal(vm.runInContext(`importCalendarEventsToWorklog([${JSON.stringify(withoutId)}])`, context), true);
assert.equal(context.worklog.length, 1);
assert.equal(vm.runInContext(`importCalendarEventsToWorklog([${JSON.stringify(withId)}])`, context), false,
  "same occurrence with UID must not create a second log entry");
assert.equal(context.worklog.length, 1);

// Pre-existing doubles from the old key scheme should collapse to one entry.
context.worklog = [
  {
    id: "calendar:oldfallback",
    taskId: "calendar:oldfallback",
    calendarEventKey: "Daily standup|2026-09-15T02:00:00.000Z|2026-09-15T02:30:00.000Z",
    calendarEvent: true,
    date: "2026-09-15",
    ts: "2026-09-15T02:00:00.000Z",
    text: "Daily standup",
    priority: "kalender",
    mins: 30,
  },
  {
    id: "calendar:olduid",
    taskId: "calendar:olduid",
    calendarEventKey: "uid-standup@example.com|2026-09-15T02:00:00.000Z",
    calendarEvent: true,
    date: "2026-09-15",
    ts: "2026-09-15T02:00:00.000Z",
    text: "Daily standup",
    priority: "kalender",
    mins: 30,
    bauKey: "TDBU-1",
  },
];
context.saves = 0;
assert.equal(vm.runInContext("dedupeCalendarWorklogEntries()", context), true);
assert.equal(context.worklog.length, 1, "existing duplicate calendar rows must collapse");
assert.equal(context.worklog[0].bauKey, "TDBU-1", "keep the richer duplicate when collapsing");
assert.equal(context.saves, 0, "dedupe itself only mutates; caller decides when to save");

console.log("PASS calendar worklog dedupe");
