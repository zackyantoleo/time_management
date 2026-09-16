const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "assets/js/worklog.js"),
  "utf8",
);
const readme = fs.readFileSync(
  path.join(__dirname, "..", "README.md"),
  "utf8",
);

const pickerBlock = src.slice(
  src.indexOf("Tombol"),
  src.indexOf("Pindah ke tanggal lain"),
);

assert.ok(pickerBlock.length > 80, "worklog picker block must exist");
assert.equal(
  pickerBlock.includes('e.priority === "kalender"'),
  false,
  "BAU/TDBU picker must not be gated on calendar entries only — a done task without a Jira key also needs the button",
);
assert.match(
  pickerBlock,
  /bolehKirim\s*&&\s*!ticketKey/,
  "picker must appear for any sendable log without an explicit Jira key (task, routine, calendar)",
);
assert.match(
  pickerBlock,
  /jira\.bau\.items\.length/,
  "picker still requires fetched BAU/TDBU topics",
);

const targetBlock = src.slice(
  src.indexOf("Tujuan worklog"),
  src.indexOf("const target ="),
);
assert.match(
  targetBlock,
  /priority === "kalender"[\s\S]*bauKey \? bauByKey\(e\.bauKey\) : null/,
  "calendar logs must not auto-match TDBU via cocokBau — only an explicit pick",
);
assert.match(
  targetBlock,
  /cocokBau\(e\.text\)/,
  "non-calendar logs without a ticket key may still auto-match a BAU topic",
);

assert.match(
  readme,
  /pilih tiket BAU\/TDBU/,
  "README must keep the explicit TDBU pick-before-push contract",
);

console.log("PASS worklog TDBU picker is available for non-calendar logs");
