// Synthetic fixtures only. Worker GAP → tiket Bug (preview + push di balik
// BUG_PUSH_ENABLED): Jira di-mock sebagai state machine kecil, D1 = SQLite
// in-memory sungguhan (node:sqlite) supaya klaim atomik/idempotency teruji
// persis. Tidak ada jaringan.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const source = (await readFile(new URL("../worker/worker.js", import.meta.url), "utf8")).replace("../assets/js/work-pattern-report-contract.js", new URL("../assets/js/work-pattern-report-contract.js", import.meta.url).href);
const { default: worker } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));

const JIRA_TOKENS = ["synthetic-jira-a", "synthetic-jira-b"];
const TICKET = "CD-1234";
const EPIC = "CD-1000";

// ---------- D1 di atas SQLite ----------
const db = new DatabaseSync(":memory:");
const nilai = (a) => a.map((x) => (x === undefined ? null : x));
const CATET_DB = {
  async exec(sql) { db.exec(sql); },
  prepare(sql) {
    let args = [];
    return {
      bind(...a) { args = nilai(a); return this; },
      async first() { const r = db.prepare(sql).get(...args); return r ? { ...r } : null; },
      async all() { return { results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }; },
      async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
    };
  },
};
const sha = async (text) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).toString("hex");
const envOff = { CATET_DB };
const env = { ...envOff, BUG_PUSH_ENABLED: "on" };

// ---------- Jira palsu ----------
const CD = { key: "CD", id: "10452" };
const issues = new Map(); // key → { project, issuetype, summary, status, issuelinks, parent, assignee, createdMs }
const ringkas = (key) => { const i = issues.get(key); return { summary: i.summary, status: { name: i.status }, issuetype: { name: i.issuetype } }; };
issues.set(EPIC, { project: CD, issuetype: "Epic", summary: "Synthetic epic", status: "To Do", issuelinks: [] });
issues.set("CD-1100", { project: CD, issuetype: "Story", summary: "Synthetic story", status: "To Do", issuelinks: [] });
issues.set(TICKET, { project: CD, issuetype: "Task", summary: "Synthetic task", status: "In Progress", issuelinks: [],
  parent: EPIC, assignee: { accountId: "acc-dev-1", displayName: "Synthetic Dev" } });
// Subtask: parent bukan epic, tanpa assignee → Bug tanpa parent & assignee.
issues.set("CD-1300", { project: CD, issuetype: "Subtask", summary: "Synthetic subtask", status: "To Do", issuelinks: [], parent: "CD-1100", assignee: null });
issues.set("NB-1", { project: { key: "NB", id: "20000" }, issuetype: "Task", summary: "No bug type", status: "To Do", issuelinks: [] });
const hierarki = { Epic: 1, Story: 0, Task: 0, Bug: 0, Subtask: -1 };
let nextKey = 7001;
const fake = {
  createMode: "ok",   // ok | 400 | 500 | 500-created
  linkFail: false,    // POST link ditolak Jira
  bulkFail: 0,        // jumlah bulkfetch berikutnya yang gagal
  searchFail: false,
};
let calls = [];
const creates = [], linkPosts = [];
const res = (body, status = 200) => new Response(JSON.stringify(body), { status });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const method = init.method || "GET";
  const auth = (init.headers && init.headers.Authorization) || "";
  calls.push({ method, host: u.host, path: u.pathname, auth });
  if (u.host !== "jira.test" || !/^Basic /.test(auth)) throw new Error("unexpected call: " + method + " " + u);
  const p = u.pathname;
  if (method === "GET" && /^\/rest\/api\/3\/issue\/createmeta\/[^/]+\/issuetypes$/.test(p)) {
    const proj = decodeURIComponent(p.split("/")[6]);
    const types = [{ id: "10340", name: "Story", subtask: false }, { id: "10341", name: "Task", subtask: false },
      { id: "10504", name: "Bug Prod", subtask: false }, { id: "10344", name: "Subtask", subtask: true }];
    if (proj === "CD") types.splice(2, 0, { id: "10342", name: "Bug", subtask: false });
    return res({ issueTypes: types, maxResults: 100, startAt: 0, total: types.length });
  }
  if (method === "GET" && p.startsWith("/rest/api/3/issue/")) {
    const key = decodeURIComponent(p.slice("/rest/api/3/issue/".length));
    const i = issues.get(key);
    if (!i) return res({ errorMessages: ["nope"] }, 404);
    const parent = i.parent ? { key: i.parent, fields: { summary: issues.get(i.parent).summary,
      issuetype: { name: issues.get(i.parent).issuetype, hierarchyLevel: hierarki[issues.get(i.parent).issuetype] } } } : undefined;
    return res({ key, fields: { project: i.project, issuetype: { name: i.issuetype }, issuelinks: i.issuelinks, summary: i.summary,
      ...(parent ? { parent } : {}), assignee: i.assignee || null } });
  }
  if (method === "POST" && p === "/rest/api/3/issue") {
    const body = JSON.parse(init.body);
    creates.push(body);
    if (fake.createMode === "400") return res({ errorMessages: [], errors: { assignee: "User cannot be assigned." } }, 400);
    if (fake.createMode === "500") return res({ message: "boom" }, 500);
    const key = "CD-" + nextKey++;
    issues.set(key, { project: CD, issuetype: "Bug", summary: body.fields.summary, status: "To Do", issuelinks: [], createdMs: Date.now() });
    if (fake.createMode === "500-created") return res({ message: "gateway" }, 502);
    return res({ id: String(nextKey), key, self: "https://jira.test/rest/api/3/issue/" + key }, 201);
  }
  if (method === "POST" && p === "/rest/api/3/issueLink") {
    const body = JSON.parse(init.body);
    linkPosts.push(body);
    if (fake.linkFail) return res({ errorMessages: ["no permission " + auth] }, 403);
    const a = body.inwardIssue.key, b = body.outwardIssue.key;
    issues.get(a).issuelinks.push({ type: { name: body.type.name }, outwardIssue: { key: b, fields: ringkas(b) } });
    issues.get(b).issuelinks.push({ type: { name: body.type.name }, inwardIssue: { key: a, fields: ringkas(a) } });
    return new Response(null, { status: 201 });
  }
  if (method === "POST" && p === "/rest/api/3/issue/bulkfetch") {
    if (fake.bulkFail > 0) { fake.bulkFail--; return res({}, 503); }
    const body = JSON.parse(init.body);
    return res({ issues: body.issueIdsOrKeys.filter((k) => issues.has(k)).map((k) => {
      const i = issues.get(k);
      return { key: k, fields: { summary: i.summary, issuelinks: i.issuelinks } };
    }) });
  }
  if (method === "GET" && p === "/rest/api/3/search/jql") {
    if (fake.searchFail) return res({}, 500);
    const jql = u.searchParams.get("jql");
    const menit = Number((jql.match(/created >= -(\d+)m/) || [])[1]);
    assert(/^project = "CD" AND issuetype = "Bug" AND reporter = currentUser\(\) AND created >= -\d+m/.test(jql) && menit > 0, "JQL pemulihan: " + jql);
    const batas = Date.now() - menit * 60000;
    return res({ issues: [...issues.entries()]
      .filter(([, i]) => i.issuetype === "Bug" && i.createdMs >= batas)
      .map(([key, i]) => ({ key, fields: { summary: i.summary } })) });
  }
  throw new Error("unexpected call: " + method + " " + u);
};

// ---------- helper ----------
const call = async (path, { method = "POST", body, code = "code-a", e = env } = {}) => {
  const headers = { Origin: "https://zackyantoleo.github.io", "Content-Type": "application/json" };
  if (code) headers["X-Catet-Key"] = code;
  const r = await worker.fetch(new Request("https://worker.test" + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), e);
  const text = await r.text();
  for (const secret of JIRA_TOKENS) assert(!text.includes(secret), path + " membocorkan rahasia");
  return { status: r.status, body: JSON.parse(text) };
};
const preview = (gap, issueKey = TICKET, e = env) => call("/bugs/preview", { body: { issueKey, gap }, e });
const push = async (gap, issueKey = TICKET, hash) => {
  const h = hash || (await preview(gap, issueKey)).body.previewHash;
  return call("/bugs/push", { body: { issueKey, gap, previewHash: h } });
};
const rows = () => db.prepare("SELECT * FROM bug_pushes ORDER BY created_at, summary").all().map((r) => ({ ...r }));
const row = (summary) => rows().find((r) => r.summary === summary);
const linked = (bug, ticket = TICKET) =>
  issues.get(bug).issuelinks.some((l) => l.type.name === "Relates" && l.outwardIssue && l.outwardIssue.key === ticket) &&
  issues.get(ticket).issuelinks.some((l) => l.type.name === "Relates" && l.inwardIssue && l.inwardIssue.key === bug);
const gap = (title, extra = {}) => ({
  title, preconditions: ["Admin has a valid token."], steps: ["Send POST request to /example with a foreign email domain."],
  expected: ["API returns 400 Bad Request.", "Response rejects the email domain."],
  actual: "API returns 201 Created.\nThe record is stored with the foreign domain.", endpoint: "POST /example", ...extra,
});
const writes = () => calls.filter((c) => c.method === "POST" && c.path !== "/rest/api/3/issue/bulkfetch");

try {
  for (const [code, id, jt] of [["code-a", "user-a", JIRA_TOKENS[0]], ["code-b", "user-b", JIRA_TOKENS[1]]]) {
    await call("/me", { method: "GET", code: "nobody" }); // SKEMA dibuat saat request pertama
    db.prepare("INSERT INTO users (id, name, token_hash, jira_site, jira_email, jira_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, id, await sha(code), "https://jira.test", id + "@example.invalid", jt, "2026-11-12T00:00:00Z");
  }
  const g1 = gap("GAP: Email domain lock is not enforced");

  // 1. Flag mati → push 404 tanpa memanggil Jira; preview tetap ada (read-only).
  calls = [];
  const offPrev = await preview(g1, TICKET, envOff);
  assert.equal(offPrev.status, 200, JSON.stringify(offPrev.body));
  calls = [];
  assert.equal((await call("/bugs/push", { body: { issueKey: TICKET, gap: g1, previewHash: offPrev.body.previewHash }, e: envOff })).status, 404);
  assert.equal(calls.length, 0);
  assert.equal((await call("/bugs/preview", { method: "GET" })).status, 404);
  assert.equal((await call("/bugs/preview", { body: { issueKey: TICKET, gap: g1 }, code: "" })).status, 401);

  // 2. Validasi: Actual result wajib, judul harus GAP:, issueKey valid.
  const bad = await preview({ ...g1, title: "Verify something", actual: "  ", steps: [], expected: "x" });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.errors, ["“expected” harus berupa daftar teks.", "Title harus diawali “GAP:”.",
    "Tidak ada Test Step (langkah reproduksi).", "Tidak ada Expected Result.", "Actual result wajib diisi dari hasil tes nyata."]);
  assert.deepEqual((await preview({ ...g1, title: "GAP:  " })).body.errors, ["Temuan setelah “GAP:” kosong."]);
  assert.match((await preview({ ...g1, title: "GAP: " + "x".repeat(250) })).body.errors[0], /Summary Bug lebih dari 255/);
  assert.equal((await preview(g1, "cd 1")).status, 400);
  assert.equal((await preview(g1, "NB-1")).status, 400, "project tanpa tipe Bug ditolak");
  assert.match((await preview(g1, "NB-1")).body.error, /tidak punya tipe issue Bug/);
  assert.equal((await preview(g1, "CD-404")).status, 404);

  // 3. Preview: isi Bug persis yang akan dibuat, tanpa menulis apa pun.
  calls = [];
  const p1 = await preview(g1);
  assert.equal(p1.status, 200, JSON.stringify(p1.body));
  assert.deepEqual(writes(), [], "preview read-only");
  assert.deepEqual({ ...p1.body, previewHash: undefined }, {
    issueKey: TICKET, issueSummary: "Synthetic task", project: CD, issueType: "Bug", linkType: "Relates",
    action: "create", bugKey: null, reason: null, previewHash: undefined,
    bug: { summary: "[Feedback] Email domain lock is not enforced", parent: { key: EPIC, summary: "Synthetic epic" },
      assignee: { accountId: "acc-dev-1", displayName: "Synthetic Dev" }, endpoint: "POST /example",
      preconditions: ["Admin has a valid token."], steps: ["Send POST request to /example with a foreign email domain."],
      expected: ["API returns 400 Bad Request.", "Response rejects the email domain."],
      actual: "API returns 201 Created.\nThe record is stored with the foreign domain." },
  });
  assert.match(p1.body.previewHash, /^[0-9a-f]{64}$/);
  assert.equal((await preview(g1)).body.previewHash, p1.body.previewHash, "previewHash stabil");

  // 4. previewHash wajib sama dengan isi yang di-dry-run (Actual diedit → 409).
  const wrong = await push({ ...g1, actual: "Something else." }, TICKET, p1.body.previewHash);
  assert.equal(wrong.status, 409);
  assert.match(wrong.body.error, /berubah sejak Dry run/);
  assert.equal(creates.length, 0);

  // 5. Push normal: payload create + link persis, lalu baca balik → Linked.
  calls = [];
  const r1 = await push(g1, TICKET, p1.body.previewHash);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  const k1 = "CD-7001";
  assert.deepEqual(r1.body, { issueKey: TICKET, summary: "[Feedback] Email domain lock is not enforced", status: "created_linked", bugKey: k1, error: null });
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0], { fields: {
    project: { id: "10452" }, issuetype: { id: "10342" }, summary: "[Feedback] Email domain lock is not enforced",
    parent: { key: EPIC }, assignee: { accountId: "acc-dev-1" },
    description: { type: "doc", version: 1, content: [
      { type: "paragraph", content: [{ type: "text", text: "Source ticket: " }, { type: "inlineCard", attrs: { url: "https://jira.test/browse/" + TICKET } }] },
      { type: "paragraph", content: [{ type: "text", text: "Endpoint: " }, { type: "text", text: "POST /example", marks: [{ type: "code" }] }] },
      { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Precondition" }] },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Admin has a valid token." }] }] }] },
      { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Steps to Reproduce" }] },
      { type: "orderedList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Send POST request to /example with a foreign email domain." }] }] }] },
      { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Expected Result" }] },
      { type: "orderedList", content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "API returns 400 Bad Request." }] }] },
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Response rejects the email domain." }] }] }] },
      { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Actual Result" }] },
      { type: "paragraph", content: [{ type: "text", text: "API returns 201 Created." }, { type: "hardBreak" }, { type: "text", text: "The record is stored with the foreign domain." }] },
      { type: "paragraph", content: [{ type: "text", text: "Created from CATET: GAP finding by AI, reproduced by QA.", marks: [{ type: "em" }] }] },
    ] },
  } }, "payload create Bug");
  assert.deepEqual(linkPosts, [{ type: { name: "Relates" }, inwardIssue: { key: k1 }, outwardIssue: { key: TICKET } }]);
  assert(linked(k1));
  assert.deepEqual([row(r1.body.summary).status, row(r1.body.summary).bug_key, row(r1.body.summary).user_id], ["created_linked", k1, "user-a"]);

  // 6. Push ulang / Dry run ulang (Actual diedit pun) → duplikat, tidak membuat lagi.
  assert.equal((await push(g1)).body.status, "skipped_duplicate");
  const p2 = await preview({ ...g1, actual: "Edited actual." });
  assert.deepEqual([p2.body.action, p2.body.bugKey], ["skip_duplicate", k1]);
  assert.match(p2.body.reason, /sudah ter-link ke CD-1234: CD-7001 \(To Do\)/);
  assert.equal((await push({ ...g1, actual: "Edited actual." })).body.status, "skipped_duplicate");
  // User lain tetap melihat Bug ter-link berjudul sama di Jira.
  assert.equal((await call("/bugs/preview", { body: { issueKey: TICKET, gap: g1 }, code: "code-b" })).body.action, "skip_duplicate");
  assert.equal(creates.length, 1);

  // 7. Link ditolak → Unlinked; Dry run berikutnya = relink; Create hanya link ulang.
  const g2 = gap("GAP: Date range filter is ignored");
  fake.linkFail = true;
  const r2 = await push(g2);
  assert.deepEqual([r2.body.status, r2.body.bugKey], ["created_unlinked", "CD-7002"]);
  assert.match(r2.body.error, /Jira menolak link \(HTTP 403\)\. Klik Retry link\./);
  fake.linkFail = false;
  const p3 = await preview(g2);
  assert.deepEqual([p3.body.action, p3.body.bugKey], ["relink", "CD-7002"]);
  const r3 = await push(g2, TICKET, p3.body.previewHash);
  assert.deepEqual([r3.body.status, r3.body.bugKey, creates.length], ["created_linked", "CD-7002", 2], "relink tanpa create baru");
  assert(linked("CD-7002"));
  // Link sebenarnya tersimpan tapi baca balik gagal → Unverified; relink tidak POST lagi.
  const g3 = gap("GAP: Error code is generic");
  fake.bulkFail = 1;
  const r4 = await push(g3);
  assert.deepEqual([r4.body.status, r4.body.bugKey], ["link_unverified", "CD-7003"]);
  const nLink = linkPosts.length;
  const r5 = await push(g3);
  assert.deepEqual([r5.body.status, linkPosts.length, creates.length], ["created_linked", nLink, 3], "link sudah ada → tidak POST lagi");

  // 8. Jira 4xx → Failed (pesan field), aman dicoba lagi setelah diperbaiki.
  const g4 = gap("GAP: Leetspeak bypasses the name check");
  fake.createMode = "400";
  const r6 = await push(g4);
  assert.deepEqual([r6.body.status, r6.body.bugKey], ["failed", null]);
  assert.match(r6.body.error, /Jira menolak membuat Bug \(HTTP 400\): assignee: User cannot be assigned\. — tidak ada yang dibuat\./);
  assert.equal(row("[Feedback] Leetspeak bypasses the name check").status, "failed");
  fake.createMode = "ok";
  const r7 = await push(g4);
  assert.deepEqual([r7.body.status, r7.body.bugKey], ["created_linked", "CD-7004"]);

  // 9. Hasil create tidak pasti (5xx setelah terbuat) → Pending; ditahan ±10 menit,
  //    lalu Create mencari dulu judulnya di Jira: ketemu → cukup di-link.
  const g5 = gap("GAP: Lowercase email is not normalised");
  fake.createMode = "500-created";
  const r8 = await push(g5);
  assert.equal(r8.body.status, "pending");
  assert.match(r8.body.error, /tidak pasti \(HTTP 502\)/);
  fake.createMode = "ok";
  assert.equal((await preview(g5)).body.action, "skip_busy");
  assert.equal((await push(g5)).body.status, "skipped_busy");
  const lalu = new Date(Date.now() - 20 * 60000).toISOString();
  db.prepare("UPDATE bug_pushes SET created_at = ?, updated_at = ? WHERE summary = ?").run(lalu, lalu, "[Feedback] Lowercase email is not normalised");
  const p4 = await preview(g5);
  assert.equal(p4.body.action, "create");
  assert.match(p4.body.reason, /terputus/);
  fake.searchFail = true;
  const r9 = await push(g5, TICKET, p4.body.previewHash);
  assert.equal(r9.body.status, "pending", "Jira tidak bisa dicek → tidak membuat apa pun");
  assert.equal(creates.length, 6);
  fake.searchFail = false;
  db.prepare("UPDATE bug_pushes SET updated_at = ? WHERE summary = ?").run(lalu, "[Feedback] Lowercase email is not normalised");
  const r10 = await push(g5);
  assert.deepEqual([r10.body.status, r10.body.bugKey, creates.length], ["created_linked", "CD-7005", 6], "pulih dari Jira, tidak kembar");
  // Create 500 tanpa terbuat → pending, lalu pulih: tidak ketemu → dibuat sekali.
  const g6 = gap("GAP: Phone number format is unspecified");
  fake.createMode = "500";
  assert.equal((await push(g6)).body.status, "pending");
  fake.createMode = "ok";
  db.prepare("UPDATE bug_pushes SET created_at = ?, updated_at = ? WHERE summary = ?").run(lalu, lalu, "[Feedback] Phone number format is unspecified");
  const r11 = await push(g6);
  assert.deepEqual([r11.body.status, r11.body.bugKey, creates.length], ["created_linked", "CD-7006", 8]);

  // 10. Klik ganda: dua push bersamaan → satu Bug.
  const g7 = gap("GAP: Pagination limit is unspecified");
  const h7 = (await preview(g7)).body.previewHash;
  const [x, y] = await Promise.all([push(g7, TICKET, h7), push(g7, TICKET, h7)]);
  const st = [x.body.status, y.body.status].sort();
  assert(st[0] === "created_linked" && ["skipped_busy", "skipped_duplicate"].includes(st[1]), st.join());
  assert.equal(creates.length, 9);

  // 11. Tiket tanpa epic (parent = story) & tanpa assignee → field tidak dikirim.
  const p5 = await preview(g1, "CD-1300");
  assert.deepEqual([p5.body.bug.parent, p5.body.bug.assignee, p5.body.action], [null, null, "create"]);
  const r12 = await push({ ...g1, preconditions: [], endpoint: "" }, "CD-1300");
  assert.equal(r12.body.status, "created_linked");
  const f12 = creates.at(-1).fields;
  assert.deepEqual(Object.keys(f12).sort(), ["description", "issuetype", "project", "summary"]);
  assert.deepEqual(f12.description.content.slice(1, 3), [
    { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Precondition" }] },
    { type: "paragraph", content: [{ type: "text", text: "—" }] },
  ], "tanpa endpoint & precondition kosong");

  console.log("bug push worker: ok");
} finally {
  db.close();
}
