import assert from "node:assert/strict";
import { copyFile, unlink } from "node:fs/promises";

const source = new URL("../worker/worker.js", import.meta.url);
const temp = "/tmp/catet-calendar-desc-worker-test.mjs";
await copyFile(source, temp);
const { default: worker } = await import("file://" + temp + "?v=" + Date.now());

const ics = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "DTSTART:20260821T090000Z",
  "DTEND:20260821T110000Z",
  "SUMMARY:Grooming Product Synonym Search",
  "DESCRIPTION:Agenda grooming. PRD: https://docs.google.com/document/d/abc123/edit",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).includes("calendar.google.com")) {
    return new Response(ics, { status: 200, headers: { "Content-Type": "text/calendar" } });
  }
  return originalFetch(url);
};

try {
  const res = await worker.fetch(new Request(
    "https://worker.test/calendar?from=2026-08-21&to=2026-08-21&tz=Asia/Jakarta&ics=https://calendar.google.com/calendar/ical/test%40group.calendar.google.com/private-x/basic.ics",
    { headers: { Origin: "https://zackyantoleo.github.io" } },
  ), {});
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  assert.ok(Array.isArray(body.events), "events array");
  assert.equal(body.events.length, 1, JSON.stringify(body));
  assert.ok(Array.isArray(body.events[0].urls), "urls must be present");
  assert.equal(body.events[0].urls[0], "https://docs.google.com/document/d/abc123/edit");
  console.log("PASS calendar description urls");
} finally {
  globalThis.fetch = originalFetch;
  await unlink(temp).catch(() => {});
}
