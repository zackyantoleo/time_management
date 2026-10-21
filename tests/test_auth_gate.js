const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const jiraSource = fs.readFileSync(path.join(root, "assets/js/jira.js"), "utf8");
const appSource = fs.readFileSync(path.join(root, "assets/js/app.js"), "utf8");
const syncSource = fs.readFileSync(path.join(root, "assets/js/sync.js"), "utf8");

const values = new Map([
  ["catet.tasks.v1", JSON.stringify([{ id: "private-task" }])],
  ["catet.worklog.v1", JSON.stringify([{ id: "private-log" }])],
  ["catet.routines.v1", JSON.stringify([{ id: "private-routine" }])],
  ["catet.routineday.v1", JSON.stringify({ date: "2026-08-21" })],
  ["catet.sprints.v1", JSON.stringify({ list: [{ id: "private-sprint" }], aktif: null })],
  ["catet.dirty.v1", "1"],
  ["catet.synced.v1", "1"],
  ["catet.weekly.v1", JSON.stringify({weeks:{'2026-W40':{private:true}}})],
  ["catet.weekly.corrections.demo.v1", JSON.stringify({note:'private draft'})],
  ["catet.jira.v1", JSON.stringify({
    key: "", proxy: "https://worker.example", site: "https://private.atlassian.net",
    items: [{ key: "SECRET-1", summary: "private ticket" }],
  })],
]);
const localStorage = {
  getItem(key) { return values.has(key) ? values.get(key) : null; },
  setItem(key, value) { values.set(key, String(value)); },
  removeItem(key) { values.delete(key); },
};
const context = vm.createContext({ localStorage });
vm.runInContext(
  "let tasks=[{id:'private-task'}], worklog=[{id:'private-log'}], " +
  "routines=[{id:'private-routine'}], rday={date:'2026-08-21'}, " +
  "sprints={list:[{id:'private-sprint'}],aktif:null};",
  context
);
vm.runInContext(jiraSource, context);

const signedOut = vm.runInContext("({tasks, worklog, routines, rday, sprints, jira, proxy:jiraProxy(), worker:workerUrl()})", context);
assert.deepStrictEqual(Array.from(signedOut.tasks), [], "signed-out tasks must be empty");
assert.deepStrictEqual(Array.from(signedOut.worklog), [], "signed-out worklog must be empty");
assert.deepStrictEqual(Array.from(signedOut.routines), [], "signed-out routines must be empty");
assert.strictEqual(signedOut.rday, null, "signed-out routine day must be empty");
assert.strictEqual(signedOut.sprints.list.length, 0, "signed-out sprints must be empty");
assert.strictEqual(signedOut.jira.items.length, 0, "signed-out Jira cache must be empty");
assert.strictEqual(signedOut.proxy, "", "data endpoint must be disabled without an access code");
assert.strictEqual(signedOut.worker, "https://worker.example", "raw Worker URL remains available for signup");
for (const key of ["catet.tasks.v1", "catet.worklog.v1", "catet.routines.v1", "catet.routineday.v1", "catet.sprints.v1", "catet.dirty.v1", "catet.synced.v1", "catet.weekly.v1", "catet.weekly.corrections.demo.v1"]) {
  assert.strictEqual(localStorage.getItem(key), null, key + " must be cleared on signed-out startup");
}

const signedInProxy = vm.runInContext("jira.key='access-code'; jiraProxy()", context);
assert.strictEqual(signedInProxy, "https://worker.example", "access code must enable the data endpoint");

assert(jiraSource.includes('fetch(workerUrl() + "/signup"'), "signup must use the unauthenticated Worker URL");
assert(!jiraSource.includes('fetch(jiraProxy() + "/signup"'), "signup must not depend on an authenticated data URL");
assert(syncSource.includes("!!jiraProxy()"), "state sync must use the authenticated data URL gate");
assert(appSource.includes('document.body.classList.toggle("signed-out", !signedIn)'), "UI must enter signed-out mode");

// Worker: tanpa kode atau kode salah → 401 di setiap rute data, tanpa panggilan
// keluar dan tanpa sentuh storage, walau secret global & service token ada.
// Kode valid tidak pernah memakai kredensial Jira global milik pemilik.
const crypto = require("crypto");
const { pathToFileURL } = require("url");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const OWNER = { site: "https://owner.invalid", email: "owner@example.invalid", token: "owner-secret" };
const ownerBasic = "Basic " + Buffer.from(OWNER.email + ":" + OWNER.token).toString("base64");
const USERS = {
  [sha("valid-code")]: { id: "user-a", name: "A", jira_site: "https://user.invalid", jira_email: "a@example.invalid", jira_token: "a-secret", cal_ics_url: null },
  [sha("nocreds-code")]: { id: "user-b", name: "B", jira_site: null, jira_email: null, jira_token: null, cal_ics_url: null },
};
const gcal = "https://calendar.google.com/calendar/ical/x%40group.calendar.google.com/private-x/basic.ics";
const goodState = { updatedAt: "2026-10-21T02:00:00Z", stores: { tasks: [], worklog: [], routines: [], routineday: {}, jira: { items: [] }, sprints: { list: [], aktif: null }, weekly: { weeks: {} } } };
const ROUTES = [
  ["GET", "/state"], ["PUT", "/state", goodState],
  ["GET", "/v2/state/tasks"], ["PUT", "/v2/state/tasks", { schemaVersion: 2, revision: 0, data: [] }],
  ["GET", "/v2/worklogs"], ["POST", "/v2/worklogs", { id: "w1", text: "x", occurredAt: "2026-10-21T02:00:00Z", localDate: "2026-10-21", minutes: 5 }],
  ["GET", "/weekly-wrapped"], ["PUT", "/weekly-wrapped", { schema_version: 1 }],
  ["GET", "/weekly-wrapped/corrections?report_id=2026-W43"], ["POST", "/weekly-wrapped/corrections", {}],
  ["GET", "/priority-snapshot"], ["PUT", "/priority-snapshot", { date: "2026-10-21", generatedAt: "2026-10-21T00:00:00Z", active: 0, today: 0, items: [] }],
  ["GET", "/pr-merge-snapshot"], ["PUT", "/pr-merge-snapshot", { generatedAt: "2026-10-21T00:00:00Z", items: [] }],
  ["POST", "/pr-merge-snapshot/ack", { eventKey: "QA-1|DEV-2|3" }],
  ["GET", "/me"], ["POST", "/me/jira", { site: "https://x.atlassian.net", email: "e", token: "t" }],
  ["POST", "/me/calendar", { url: gcal }], ["POST", "/me/qality", { token: "" }],
  ["GET", "/calendar?from=2026-10-21&to=2026-10-21&ics=" + encodeURIComponent(gcal)],
  ["GET", "/missing-worklog", null, true], ["POST", "/pairing-link", { qaKey: "QA-1", devKey: "DEV-2" }, true],
  ["GET", "/testcases?issue=CD-1", null, true], ["POST", "/testcases/preview", { issueKey: "CD-1", cases: [] }, true],
  ["POST", "/testcases/push", { issueKey: "CD-1", cases: [], previewHash: "x" }, true],
  ["POST", "/testcases/relink", { issueKey: "CD-1", testKey: "CD-2" }, true],
  ["GET", "/tickets", null, true], ["GET", "/bau?project=TDBU", null, true],
  ["GET", "/worklog-report?from=2026-10-20&to=2026-10-21", null, true],
  ["POST", "/worklog", { key: "CD-1", started: "2026-10-21T02:00:00Z", timeSpentSeconds: 600, comment: "x" }, true],
  ["POST", "/transition", { key: "CD-1", target: "done" }, true],
  ["GET", "/unknown-route"],
];

async function workerGate() {
  const source = fs.readFileSync(path.join(root, "worker/worker.js"), "utf8").replace("../assets/js/work-pattern-report-contract.js",
    pathToFileURL(path.join(root, "assets/js/work-pattern-report-contract.js")).href);
  const { default: worker } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
  let sql = [], kv = [], outbound = [];
  const env = {
    JIRA_SITE: OWNER.site, JIRA_EMAIL: OWNER.email, JIRA_API_TOKEN: OWNER.token, CAL_ICS_URL: gcal,
    PRIORITY_SERVICE_TOKEN: "svc", WEEKLY_WRAPPED_SERVICE_TOKEN: "svc-ww", TESTCASE_PUSH_ENABLED: "on",
    CATET_KV: { async get(k) { kv.push("get " + k); return null; }, async put(k) { kv.push("put " + k); } },
    CATET_DB: {
      async exec(s) { sql.push(s); },
      prepare(s) { return { bind(...p) { return {
        async first() { sql.push(s); return /FROM users WHERE token_hash/.test(s) ? USERS[p[0]] || null : null; },
        async run() { sql.push(s); return { success: true, meta: { changes: 1 } }; },
        async all() { sql.push(s); return { results: [] }; },
      }; } }; },
    },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const h = new Headers(init.headers || {});
    outbound.push({ url: String(url), auth: h.get("Authorization") });
    return new Response("{}", { status: 503 });
  };
  const call = (method, route, body, key) => worker.fetch(new Request("https://worker.test" + route, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { Origin: "https://zackyantoleo.github.io", "Content-Type": "application/json",
      Authorization: "Bearer " + (route.startsWith("/weekly-wrapped") ? "svc-ww" : "svc"),
      ...(key ? { "X-Catet-Key": key } : {}) },
  }), env);
  try {
    for (const [method, route, body] of ROUTES) {
      for (const key of ["", "wrong-code"]) {
        sql = []; kv = []; outbound = [];
        const r = await call(method, route, body, key);
        const label = method + " " + route + (key ? " (wrong code)" : " (no code)");
        assert.strictEqual(r.status, 401, label + " must be 401, got " + r.status);
        assert.deepStrictEqual(outbound, [], label + " must not call Jira/QAlity/Google");
        assert.deepStrictEqual(kv, [], label + " must not touch KV");
        assert(sql.every((s) => /^SELECT id, name, jira_site.* FROM users WHERE token_hash/.test(s)), label + " may only look up the code: " + sql.join(" | "));
      }
      sql = []; kv = []; outbound = [];
      const ok = await call(method, route, body, "valid-code");
      assert.notStrictEqual(ok.status, 401, method + " " + route + " with a valid code must pass the gate");
      assert(sql.every((s) => !/user_id\s*=\s*'default'/.test(s)), "no legacy default row");
      for (const o of outbound) {
        assert(!o.url.startsWith(OWNER.site), method + " " + route + " must never call the owner's global Jira site");
        assert.notStrictEqual(o.auth, ownerBasic, method + " " + route + " must never use global Jira credentials");
      }
      if (route === "/calendar?from=2026-10-21&to=2026-10-21&ics=" + encodeURIComponent(gcal)) {
        assert.deepStrictEqual(outbound.map((o) => o.url), [gcal], "calendar uses the caller's URL, not a global one");
      }
    }
    for (const [method, route, body, jira] of ROUTES) {
      if (!jira || route.startsWith("/testcases")) continue;
      outbound = [];
      const r = await call(method, route, body, "nocreds-code");
      assert.strictEqual(r.status, 400, method + " " + route + " without own Jira credentials must be 400, got " + r.status);
      assert.deepStrictEqual(outbound, [], method + " " + route + " must not fall back to global Jira credentials");
    }
    outbound = [];
    const cal = await call("GET", "/calendar?from=2026-10-21&to=2026-10-21", null, "nocreds-code");
    assert.strictEqual(cal.status, 400, "no global calendar fallback");
    assert.deepStrictEqual(outbound, [], "no global calendar fetch");
    assert.strictEqual((await call("GET", "/state", null, "nocreds-code")).status, 200, "sync still works before Jira credentials are saved");
    assert.strictEqual((await worker.fetch(new Request("https://worker.test/tickets", { method: "OPTIONS" }), env)).status, 204, "CORS preflight stays open");
  } finally { globalThis.fetch = realFetch; }
  return ROUTES.length;
}

workerGate().then((routes) => {
  console.log(JSON.stringify({ ok: true, signedOut: true, cloudSyncBlocked: true, workerRoutesGated: routes }));
}).catch((error) => { console.error(error); process.exit(1); });
