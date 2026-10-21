// Synthetic fixtures only. Worker import test case QAlity Fase 3 (push +
// relink di balik TESTCASE_PUSH_ENABLED): Jira dan QAlity di-mock sebagai
// state machine kecil, D1 = SQLite in-memory sungguhan (node:sqlite) supaya
// SQL klaim atomik/idempotency teruji persis. Tidak ada jaringan.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const source = (await readFile(new URL("../worker/worker.js", import.meta.url), "utf8")).replace("../assets/js/work-pattern-report-contract.js", new URL("../assets/js/work-pattern-report-contract.js", import.meta.url).href);
const { default: worker } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));

const TOKEN = "synthetic-qality-token-0123456789abcdef";
const JIRA_TOKENS = ["synthetic-jira-a", "synthetic-jira-b"];
const TICKET = "CD-1234";
const LINK = "QAlity Test";

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
const env = { ...envOff, TESTCASE_PUSH_ENABLED: "on" };

// ---------- Jira + QAlity palsu ----------
const issues = new Map(); // key → { project, issuetype, summary, status, issuelinks, createdMs }
const ringkas = (key) => { const i = issues.get(key); return { summary: i.summary, status: { name: i.status }, issuetype: { name: i.issuetype } }; };
issues.set(TICKET, { project: { key: "CD", id: "10452" }, issuetype: "Task", summary: "Synthetic story", status: "In Progress", issuelinks: [] });
issues.set("CD-1300", { project: { key: "CD", id: "10452" }, issuetype: "Task", summary: "Second story", status: "To Do", issuelinks: [] });
// Test case manual (bukan dari CATET) yang sudah ter-link ke tiket.
issues.set("CD-5962", { project: { key: "CD", id: "10452" }, issuetype: "QAlity Test", summary: "Verify existing manual case", status: "To Do", issuelinks: [] });
issues.get("CD-5962").issuelinks.push({ type: { name: "QAlity Test" }, outwardIssue: { key: TICKET, fields: { summary: "Synthetic story", status: { name: "In Progress" }, issuetype: { name: "Task" } } } });
issues.get(TICKET).issuelinks.push({ type: { name: "QAlity Test" }, inwardIssue: { key: "CD-5962", fields: { summary: "Verify existing manual case", status: { name: "To Do" }, issuetype: { name: "QAlity Test" } } } });
let nextKey = 9001;
const fake = {
  importMode: "ok",      // ok | names | reversed | partial | 429 | 500-created | 500
  linkFail: new Set(),   // key test case yang POST link-nya ditolak Jira
  linkGhost: false,      // POST link 201 tapi link tidak tersimpan
  bulkFail: 0,           // jumlah bulkfetch berikutnya yang gagal
  searchFail: false,
};
let calls = [];
const imports = [], linkPosts = [];
const res = (body, status = 200) => new Response(JSON.stringify(body), { status });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const method = init.method || "GET";
  const auth = (init.headers && init.headers.Authorization) || "";
  calls.push({ method, host: u.host, path: u.pathname, auth });
  if (u.host === "apps-qalityplus.soldevelo.com") {
    if (auth !== "Bearer " + TOKEN) return res({ message: "bad token " + auth }, 401);
    if (method === "GET" && u.pathname === "/api/qalitySettings") {
      return res({ CD: { projectId: "10452", isQalityEnabled: true, isPluginEnabled: true } });
    }
    if (method === "POST" && u.pathname === "/api/testCases/import") {
      const body = JSON.parse(init.body);
      imports.push(body);
      if (fake.importMode === "429") return res({ message: "slow down " + auth }, 429);
      if (fake.importMode === "500") return res({ message: "boom" }, 500);
      const success = [], errors = [];
      body.testCases.forEach((tc, i) => {
        if (fake.importMode === "partial" && i === 0) { errors.push({ name: tc.name, details: "rejected " + auth }); return; }
        const key = "CD-" + nextKey++;
        issues.set(key, { project: { key: "CD", id: "10452" }, issuetype: "QAlity Test", summary: tc.name, status: "To Do", issuelinks: [], createdMs: Date.now() });
        success.push(fake.importMode.startsWith("names") ? { testCaseKey: key, name: tc.name } : { testCaseKey: key });
      });
      if (fake.importMode === "500-created") return res({ message: "gateway" }, 502);
      if (fake.importMode.endsWith("reversed")) success.reverse();
      return res({ success, errors });
    }
  }
  if (u.host === "jira.test") {
    if (!/^Basic /.test(auth) && !(init.headers && init.headers.Authorization)) return res({}, 401);
    if (method === "GET" && u.pathname.startsWith("/rest/api/3/issue/")) {
      const key = decodeURIComponent(u.pathname.slice("/rest/api/3/issue/".length));
      const i = issues.get(key);
      if (!i) return res({ errorMessages: ["nope"] }, 404);
      return res({ key, fields: { project: i.project, issuetype: { name: i.issuetype }, issuelinks: i.issuelinks } });
    }
    if (method === "POST" && u.pathname === "/rest/api/3/issueLink") {
      const body = JSON.parse(init.body);
      linkPosts.push(body);
      const test = body.inwardIssue.key, ticket = body.outwardIssue.key;
      if (fake.linkFail.has(test)) return res({ errorMessages: ["no permission " + auth] }, 403);
      if (!fake.linkGhost) {
        issues.get(test).issuelinks.push({ type: { name: body.type.name }, outwardIssue: { key: ticket, fields: ringkas(ticket) } });
        issues.get(ticket).issuelinks.push({ type: { name: body.type.name }, inwardIssue: { key: test, fields: ringkas(test) } });
      }
      return new Response(null, { status: 201 });
    }
    if (method === "POST" && u.pathname === "/rest/api/3/issue/bulkfetch") {
      if (fake.bulkFail > 0) { fake.bulkFail--; return res({}, 503); }
      const body = JSON.parse(init.body);
      return res({ issues: body.issueIdsOrKeys.filter((k) => issues.has(k)).map((k) => {
        const i = issues.get(k);
        return { key: k, fields: { summary: i.summary, issuetype: { name: i.issuetype }, issuelinks: i.issuelinks } };
      }) });
    }
    if (method === "GET" && u.pathname === "/rest/api/3/search/jql") {
      if (fake.searchFail) return res({}, 500);
      const jql = u.searchParams.get("jql");
      const menit = Number((jql.match(/created >= -(\d+)m/) || [])[1]);
      assert(/project = "CD" AND issuetype = "QAlity Test"/.test(jql) && menit > 0, "JQL pemulihan: " + jql);
      const batas = Date.now() - menit * 60000;
      return res({ issues: [...issues.entries()]
        .filter(([, i]) => i.issuetype === "QAlity Test" && i.createdMs >= batas)
        .map(([key, i]) => ({ key, fields: { summary: i.summary } })) });
    }
  }
  throw new Error("unexpected call: " + method + " " + u);
};

// ---------- helper ----------
const call = async (path, { method = "GET", body, code = "code-a", e = env } = {}) => {
  const headers = { Origin: "https://zackyantoleo.github.io", "Content-Type": "application/json" };
  if (code) headers["X-Catet-Key"] = code;
  const r = await worker.fetch(new Request("https://worker.test" + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), e);
  const text = await r.text();
  for (const secret of [TOKEN, ...JIRA_TOKENS]) assert(!text.includes(secret), path + " membocorkan rahasia");
  return { status: r.status, body: JSON.parse(text) };
};
const preview = (cases, issueKey = TICKET) => call("/testcases/preview", { method: "POST", body: { issueKey, cases } });
const push = async (cases, issueKey = TICKET, hash) => {
  const h = hash || (await preview(cases, issueKey)).body.previewHash;
  return call("/testcases/push", { method: "POST", body: { issueKey, cases, previewHash: h } });
};
const relink = (testKey, issueKey = TICKET, code = "code-a") => call("/testcases/relink", { method: "POST", body: { issueKey, testKey }, code });
const rows = () => db.prepare("SELECT * FROM testcase_pushes ORDER BY created_at, title").all().map((r) => ({ ...r }));
const row = (title) => rows().find((r) => r.title === title);
const keyOf = (title) => [...issues.entries()].find(([, i]) => i.summary === title && i.issuetype === "QAlity Test")?.[0];
const linkedBothWays = (test, ticket = TICKET) =>
  issues.get(test).issuelinks.some((l) => l.type.name === LINK && l.outwardIssue && l.outwardIssue.key === ticket) &&
  issues.get(ticket).issuelinks.some((l) => l.type.name === LINK && l.inwardIssue && l.inwardIssue.key === test);
const tc = (title, steps = ["Send a GET request."], extra = {}) => ({ title, preconditions: [], steps, expected: ["Returns 200 OK."], ...extra });

try {
  // Skema D1 dibuat otomatis (SKEMA Worker), lalu dua user sintetis.
  assert.equal((await call("/me", { code: "nobody" })).status, 401);
  for (const [code, id, jt] of [["code-a", "user-a", JIRA_TOKENS[0]], ["code-b", "user-b", JIRA_TOKENS[1]]]) {
    db.prepare("INSERT INTO users (id, name, token_hash, jira_site, jira_email, jira_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, id, await sha(code), "https://jira.test", id + "@example.invalid", jt, "2026-10-20T00:00:00Z");
  }
  assert.equal((await call("/me/qality", { method: "POST", body: { token: TOKEN, expiresAt: "2099-01-01" } })).status, 200);

  // 1. Flag mati → push/relink tidak ada (404) dan tidak memanggil siapa pun.
  calls = [];
  const multi = { title: "Verify multi step flow", preconditions: ["User is logged in."],
    steps: ["Open the page.", "Fill the form.", "Submit the form."], expected: ["Shows success.", "Data is stored."] };
  const single = tc("Validate single step");
  const offHash = (await preview([multi, single])).body.previewHash;
  calls = [];
  assert.equal((await call("/testcases/push", { method: "POST", body: { issueKey: TICKET, cases: [multi], previewHash: offHash }, e: envOff })).status, 404);
  assert.equal((await call("/testcases/relink", { method: "POST", body: { issueKey: TICKET, testKey: "CD-1" }, e: envOff })).status, 404);
  assert.equal(calls.length, 0);

  // 2. previewHash wajib sama dengan isi yang di-dry-run.
  const wrong = await call("/testcases/push", { method: "POST", body: { issueKey: TICKET, cases: [multi, single], previewHash: "0".repeat(64) } });
  assert.equal(wrong.status, 409);
  assert.match(wrong.body.error, /berubah sejak Dry run/);
  assert.equal(imports.length, 0);
  const changed = await call("/testcases/push", { method: "POST", body: { issueKey: TICKET, cases: [{ ...multi, steps: ["Other."] }, single], previewHash: offHash } });
  assert.equal(changed.status, 409, "isi berubah dengan hash lama ditolak");

  // 3. Push normal. QAlity mengembalikan key terbalik tanpa nama → pemetaan
  //    tetap benar lewat Summary Jira. Payload import & link persis.
  fake.importMode = "reversed";
  calls = [];
  const p1 = await push([multi, single]);
  assert.equal(p1.status, 200, JSON.stringify(p1.body));
  assert.equal(imports.length, 1);
  assert.deepEqual(imports[0], {
    projectId: "10452",
    testCases: [
      { name: "Verify multi step flow", properties: {}, testSteps: [
        { step: "Open the page.", data: "Precondition:\n- User is logged in.", result: "", position: 1 },
        { step: "Fill the form.", data: "", result: "", position: 2 },
        { step: "Submit the form.", data: "", result: "1. Shows success.\n2. Data is stored.", position: 3 },
      ] },
      { name: "Validate single step", properties: {}, testSteps: [{ step: "Send a GET request.", data: "", result: "1. Returns 200 OK.", position: 1 }] },
    ],
  }, "payload import = mapping plan §4");
  assert.equal(calls.find((c) => c.path === "/api/testCases/import").auth, "Bearer " + TOKEN);
  const kMulti = keyOf("Verify multi step flow"), kSingle = keyOf("Validate single step");
  assert.deepEqual(p1.body.results.map((r) => [r.title, r.status, r.testKey]),
    [["Verify multi step flow", "created_linked", kMulti], ["Validate single step", "created_linked", kSingle]]);
  assert.deepEqual(linkPosts.map((l) => l.inwardIssue.key).sort(), [kMulti, kSingle].sort());
  for (const l of linkPosts) {
    assert.deepEqual(l, { type: { name: LINK }, inwardIssue: { key: l.inwardIssue.key }, outwardIssue: { key: TICKET } },
      "payload link = hasil spike: test case inward, tiket outward");
  }
  assert(linkedBothWays(kMulti) && linkedBothWays(kSingle));
  assert.deepEqual(p1.body.counts, { created_linked: 2 });
  assert.deepEqual(row("Verify multi step flow").status, "created_linked");
  assert.equal(row("Verify multi step flow").test_key, kMulti);
  assert.equal(p1.body.history.length, 2);
  assert(calls.filter((c) => c.method !== "GET").every((c) => ["/api/testCases/import", "/rest/api/3/issueLink", "/rest/api/3/issue/bulkfetch"].includes(c.path)));

  // 4. Push ulang isi sama → tidak ada import/link baru (judul sudah ter-link).
  const before = imports.length, linksBefore = linkPosts.length;
  const p2 = await push([multi, single]);
  assert.deepEqual(p2.body.results.map((r) => [r.status, r.testKey]), [["skipped_duplicate", kMulti], ["skipped_duplicate", kSingle]]);
  assert.equal(imports.length, before);
  assert.equal(linkPosts.length, linksBefore);
  const pv = await preview([multi, single]);
  assert.deepEqual(pv.body.counts, { create: 0, skip: 2 });

  // 5. Link ditolak → created_unlinked; D1 mencegah import ulang walau judul
  //    belum ter-link; Retry link → created_linked.
  fake.importMode = "ok";
  fake.linkFail.add("CD-" + nextKey);
  const c5 = tc("Verify link failure");
  const p5 = await push([c5]);
  const k5 = p5.body.results[0].testKey;
  assert.equal(p5.body.results[0].status, "created_unlinked");
  assert.match(p5.body.results[0].error, /Jira menolak link \(HTTP 403\)/);
  assert(!p5.body.results[0].error.includes("no permission"), "body error Jira tidak diteruskan");
  assert.equal(row("Verify link failure").status, "created_unlinked");
  const n5 = imports.length;
  assert.equal((await push([c5])).body.results[0].status, "skipped_duplicate", "D1 created_unlinked = sudah dibuat");
  assert.equal(imports.length, n5);
  fake.linkFail.clear();
  const r5 = await relink(k5);
  assert.equal(r5.status, 200);
  assert.equal(r5.body.status, "created_linked");
  assert(linkedBothWays(k5));
  assert.equal(row("Verify link failure").status, "created_linked");
  assert.equal((await relink(k5)).status, 404, "sudah linked → tidak ada yang perlu di-relink");

  // 6. Link 201 tapi tidak tersimpan → link_unverified; relink POST lagi.
  fake.linkGhost = true;
  const p6 = await push([tc("Verify ghost link")]);
  const k6 = p6.body.results[0].testKey;
  assert.equal(p6.body.results[0].status, "link_unverified");
  fake.linkGhost = false;
  const posts6 = linkPosts.length;
  assert.equal((await relink(k6)).body.status, "created_linked");
  assert.equal(linkPosts.length, posts6 + 1);

  // 7. Link tersimpan tapi baca-balik gagal → link_unverified; relink tidak
  //    POST lagi karena link sudah ada, cukup verifikasi.
  fake.bulkFail = 1;
  const p7 = await push([tc("Verify readback failure")]);
  const k7 = p7.body.results[0].testKey;
  assert.equal(p7.body.results[0].status, "link_unverified");
  const posts7 = linkPosts.length;
  assert.equal((await relink(k7)).body.status, "created_linked");
  assert.equal(linkPosts.length, posts7, "link sudah ada → tidak POST ulang");
  // Relink milik user lain / key asing → 404; key bukan QAlity → 409.
  assert.equal((await relink(k7, TICKET, "code-b")).status, 404);
  assert.equal((await relink("CD-1", TICKET)).status, 404);
  db.prepare("INSERT INTO testcase_pushes (user_id, issue_key, case_hash, title, test_key, status, error, created_at, updated_at) VALUES ('user-a', ?, 'h-story', 'x', 'CD-1300', 'created_unlinked', NULL, ?, ?)")
    .run(TICKET, new Date().toISOString(), new Date().toISOString());
  assert.equal((await relink("CD-1300")).status, 409);
  db.prepare("DELETE FROM testcase_pushes WHERE case_hash = 'h-story'").run();

  // 8. QAlity 429 → failed (tidak ada yang dibuat), aman di-push ulang.
  fake.importMode = "429";
  const c8 = tc("Verify rate limited");
  const p8 = await push([c8]);
  assert.equal(p8.body.results[0].status, "failed");
  assert.match(p8.body.results[0].error, /HTTP 429/);
  assert(!JSON.stringify(rows()).includes(TOKEN), "D1 tidak menyimpan token/isi error QAlity");
  fake.importMode = "ok";
  const p8b = await push([c8]);
  assert.equal(p8b.body.results[0].status, "created_linked", "baris failed bisa diklaim ulang");

  // 9. Import 5xx padahal sudah terbuat → pending (tidak pasti). Push ulang
  //    langsung = Busy tanpa import; setelah >10 menit, Worker mencari judul di
  //    Jira dan cukup me-link test case yang sudah ada (tidak kembar).
  fake.importMode = "500-created";
  const c9 = tc("Verify ambiguous import");
  const p9 = await push([c9]);
  assert.equal(p9.body.results[0].status, "pending");
  assert.equal(row("Verify ambiguous import").status, "pending");
  fake.importMode = "ok";
  const n9 = imports.length;
  assert.equal((await preview([c9])).body.plan[0].action, "skip_busy");
  const p9b = await push([c9]);
  assert.equal(p9b.body.results[0].status, "skipped_busy");
  assert.equal(imports.length, n9);
  const lalu = new Date(Date.now() - 11 * 60000).toISOString();
  db.prepare("UPDATE testcase_pushes SET updated_at = ?, created_at = ? WHERE title = ?").run(lalu, lalu, "Verify ambiguous import");
  issues.get(keyOf("Verify ambiguous import")).createdMs = Date.now() - 11 * 60000;
  assert.equal((await preview([c9])).body.plan[0].action, "create");
  const p9c = await push([c9]);
  assert.equal(imports.length, n9, "pemulihan tidak meng-import ulang");
  assert.deepEqual([p9c.body.results[0].status, p9c.body.results[0].testKey], ["created_linked", keyOf("Verify ambiguous import")]);
  assert.equal([...issues.values()].filter((i) => i.summary === "Verify ambiguous import").length, 1, "tidak ada test case kembar");

  // 10. Pending basi tapi Jira tidak bisa dicek → tetap pending, tidak membuat apa pun.
  fake.importMode = "500";
  const c10 = tc("Verify search failure");
  assert.equal((await push([c10])).body.results[0].status, "pending");
  db.prepare("UPDATE testcase_pushes SET updated_at = ? WHERE title = ?").run(new Date(Date.now() - 11 * 60000).toISOString(), "Verify search failure");
  fake.importMode = "ok"; fake.searchFail = true;
  const n10 = imports.length;
  const p10 = await push([c10]);
  assert.equal(p10.body.results[0].status, "pending");
  assert.equal(imports.length, n10);
  assert.match(row("Verify search failure").error, /Jira belum bisa dicek/);
  // Jira bisa dicek dan judul memang tidak ada → baru dibuat.
  fake.searchFail = false;
  db.prepare("UPDATE testcase_pushes SET updated_at = ? WHERE title = ?").run(new Date(Date.now() - 11 * 60000).toISOString(), "Verify search failure");
  assert.equal((await push([c10])).body.results[0].status, "created_linked");
  assert.equal(imports.length, n10 + 1);

  // 11. Dua push bersamaan (klik ganda / dua tab) → tepat satu import.
  const c11 = tc("Verify double click");
  const h11 = (await preview([c11])).body.previewHash;
  const n11 = imports.length;
  const [a11, b11] = await Promise.all([1, 2].map(() =>
    call("/testcases/push", { method: "POST", body: { issueKey: TICKET, cases: [c11], previewHash: h11 } })));
  assert.equal(imports.length, n11 + 1);
  assert.deepEqual([a11.body.results[0].status, b11.body.results[0].status].sort(), ["created_linked", "skipped_busy"]);
  assert.equal([...issues.values()].filter((i) => i.summary === "Verify double click").length, 1);

  // 12. QAlity menolak satu case (errors by name) → failed; yang lain dibuat.
  fake.importMode = "partial";
  const p12 = await push([tc("Verify partial rejected"), tc("Verify partial accepted")]);
  assert.deepEqual(p12.body.results.map((r) => r.status), ["failed", "created_linked"]);
  assert(!JSON.stringify(p12.body).includes("rejected "), "details error QAlity tidak diteruskan");

  // 13. Respons dengan nama → dipetakan per nama.
  fake.importMode = "names";
  const p13 = await push([tc("Verify named one"), tc("Verify named two")]);
  assert.deepEqual(p13.body.results.map((r) => [r.status, r.testKey]),
    [["created_linked", keyOf("Verify named one")], ["created_linked", keyOf("Verify named two")]]);

  // 13b. Nama ada tapi urutan terbalik dan Summary tak terbaca → tetap per nama.
  fake.importMode = "names-reversed"; fake.bulkFail = 1;
  const p13b = await push([tc("Verify named three"), tc("Verify named four")]);
  assert.deepEqual(p13b.body.results.map((r) => [r.status, r.testKey]),
    [["link_unverified", keyOf("Verify named three")], ["link_unverified", keyOf("Verify named four")]]);

  // 13c. Judul sama dengan test case manual yang sudah ter-link → dilewati.
  const n13c = imports.length;
  const p13c = await push([tc("  verify EXISTING manual case ")]);
  assert.deepEqual([p13c.body.results[0].status, p13c.body.results[0].testKey], ["skipped_duplicate", "CD-5962"]);
  assert.equal(imports.length, n13c);

  // 14. Batas subrequest: 20 case = 2 baca + 1 import + 20 link + 1 bulkfetch.
  fake.importMode = "ok";
  const dua20 = Array.from({ length: 20 }, (_, i) => tc("Verify budget " + i));
  const h14 = (await preview(dua20)).body.previewHash;
  calls = [];
  const p14 = await call("/testcases/push", { method: "POST", body: { issueKey: TICKET, cases: dua20, previewHash: h14 } });
  assert(p14.body.results.every((r) => r.status === "created_linked"));
  assert.equal(calls.length, 24);
  assert(calls.length <= 50, "di bawah batas 50 subrequest Worker gratis");

  // 15. Tiket lain, judul sama → bukan duplikat (case_hash per tiket).
  const p15 = await push([single], "CD-1300");
  assert.equal(p15.body.results[0].status, "created_linked");
  assert(linkedBothWays(p15.body.results[0].testKey, "CD-1300"));
} finally {
  globalThis.fetch = realFetch;
}
console.log("test_testcase_push_worker: PASS");
