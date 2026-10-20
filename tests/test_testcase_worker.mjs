// Synthetic fixtures only. Worker import test case QAlity Fase 2 (token + dry
// run): Jira, QAlity, dan D1 di-mock; tidak ada jaringan dan tidak ada write.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = (await readFile(new URL("../worker/worker.js", import.meta.url), "utf8")).replace("../assets/js/work-pattern-report-contract.js", new URL("../assets/js/work-pattern-report-contract.js", import.meta.url).href);
const { default: worker } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));

// Validator browser (Fase 1) untuk uji kesetaraan dengan validasi Worker.
const ctx = vm.createContext({ localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, tasks: [] });
vm.runInContext(await readFile(new URL("../assets/js/testcases.js", import.meta.url), "utf8"), ctx);
const parseTestCases = vm.runInContext("parseTestCases", ctx);
const validateTestCases = vm.runInContext("validateTestCases", ctx);

const TOKEN = "synthetic-qality-token-0123456789abcdef";
const REVOKED = "synthetic-revoked-token-0123456789abcdef";
const hash = async (text) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).toString("hex");
const users = {
  "code-a": { id: "user-a", name: "A", jira_site: "https://jira.test", jira_email: "a@example.invalid", jira_token: "synthetic-jira-a" },
  "code-b": { id: "user-b", name: "B", jira_site: "https://jira.test", jira_email: "b@example.invalid", jira_token: "synthetic-jira-b" },
};
const usersByHash = new Map(await Promise.all(Object.entries(users).map(async ([code, u]) => [await hash(code), u])));
const creds = new Map();   // user_id → { token, expires_at, updated_at }
const pushes = [];         // baris testcase_pushes
const env = {
  REQUIRE_AUTH: "1",
  ADMIN_KEY: "synthetic-admin",
  CATET_DB: {
    async exec() {},
    prepare(sql) {
      return {
        bind(...args) { this.args = args; return this; },
        async first() {
          if (sql.includes("FROM users")) return usersByHash.get(this.args[0]) || null;
          if (sql.includes("FROM qality_credentials")) return creds.get(this.args[0]) || null;
          return null;
        },
        async all() {
          if (sql.includes("FROM testcase_pushes")) {
            return { results: pushes.filter((r) => r.user_id === this.args[0] && r.issue_key === this.args[1]) };
          }
          return { results: [] };
        },
        async run() {
          const a = this.args;
          if (sql.includes("INSERT INTO qality_credentials")) creds.set(a[0], { token: a[1], expires_at: a[2], updated_at: a[3] });
          else if (sql.includes("DELETE FROM qality_credentials")) creds.delete(a[0]);
          return { meta: { changes: 1 } };
        },
      };
    },
  },
};

const link = (type, side, key, summary, issuetype, status = "To Do") =>
  ({ type: { name: type }, [side]: { key, fields: { summary, status: { name: status }, issuetype: { name: issuetype } } } });
const issues = {
  "CD-1234": { project: { key: "CD", id: "10452" }, issuetype: { name: "Task" }, issuelinks: [
    link("QAlity Test", "inwardIssue", "CD-5962", "Verify Existing Case", "QAlity Test"),
    link("Blocks", "outwardIssue", "CD-1000", "Synthetic dev story", "Story", "Done"),
  ] },
  "CD-5962": { project: { key: "CD", id: "10452" }, issuetype: { name: "QAlity Test" }, issuelinks: [] },
  "PROD-77": { project: { key: "PROD", id: "10001" }, issuetype: { name: "Task" }, issuelinks: [] },
  "MIS-1": { project: { key: "MIS", id: "1" }, issuetype: { name: "Task" }, issuelinks: [] },
};
const settings = {
  AB: { projectId: "10100", isQalityEnabled: true, isPluginEnabled: true },
  CD: { projectId: "10452", isQalityEnabled: true, isPluginEnabled: true },
  MIS: { projectId: "2", isQalityEnabled: true, isPluginEnabled: true },
  OFF: { projectId: "5", isQalityEnabled: false, isPluginEnabled: true },
};
let calls = [];
const methods = new Set(); // seluruh method keluar sepanjang tes (tidak di-reset)
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const auth = (init.headers && init.headers.Authorization) || "";
  methods.add(init.method || "GET");
  calls.push({ method: init.method || "GET", host: u.host, path: u.pathname, search: u.search, auth });
  if (u.host === "jira.test" && u.pathname.startsWith("/rest/api/3/issue/")) {
    const key = decodeURIComponent(u.pathname.slice("/rest/api/3/issue/".length));
    if (!issues[key]) return new Response(JSON.stringify({ errorMessages: ["not found"] }), { status: 404 });
    return new Response(JSON.stringify({ key, fields: issues[key] }), { status: 200 });
  }
  if (u.host === "apps-qalityplus.soldevelo.com" && u.pathname === "/api/qalitySettings") {
    if (auth !== "Bearer " + TOKEN) return new Response(JSON.stringify({ message: "invalid token " + auth }), { status: 401 });
    return new Response(JSON.stringify(settings), { status: 200 });
  }
  throw new Error("unexpected call: " + (init.method || "GET") + " " + u);
};

const call = async (path, { method = "GET", body, code = "code-a" } = {}) => {
  const headers = { Origin: "https://zackyantoleo.github.io", "Content-Type": "application/json" };
  if (code) headers["X-Catet-Key"] = code;
  const res = await worker.fetch(new Request("https://worker.test" + path, {
    method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  }), env);
  const text = await res.text();
  for (const secret of [TOKEN, REVOKED, "synthetic-jira-a", "synthetic-jira-b"]) {
    assert(!text.includes(secret), path + " membocorkan rahasia di response");
  }
  return { status: res.status, body: JSON.parse(text) };
};
const preview = (cases, issueKey = "CD-1234", code = "code-a") =>
  call("/testcases/preview", { method: "POST", body: { issueKey, cases }, code });

const multi = { title: "Verify  multi   step flow", preconditions: ["Precondition A.", "Precondition B."],
  steps: ["Open the synthetic page.", "Fill the synthetic form.", "Submit the form."],
  expected: ["Page shows success.", "Data is stored."] };
const dupLinked = { title: "  verify existing   CASE ", preconditions: [], steps: ["Send a request."], expected: ["Returns 200."] };
const single = { title: "Validate single step", preconditions: [], steps: ["Send a GET request."], expected: ["Returns 200 OK."] };

try {
  // Tanpa kode akses → ditolak, tanpa panggilan keluar.
  assert.equal((await call("/me", { code: "" })).status, 401);
  assert.equal((await preview([single], "CD-1234", "")).status, 401);
  assert.equal(calls.length, 0);

  // Token: validasi, simpan, status di /me, per user, tidak pernah dikembalikan.
  assert.equal((await call("/me")).body.qality_tersimpan, false);
  assert.equal((await call("/me/qality", { method: "POST", body: {} })).status, 400, "field token wajib");
  assert.equal((await call("/me/qality", { method: "POST", body: { token: "short" } })).status, 400);
  assert.equal((await call("/me/qality", { method: "POST", body: { token: "has space inside token 123456" } })).status, 400);
  assert.equal((await call("/me/qality", { method: "POST", body: { token: TOKEN, expiresAt: "2027-02-30" } })).status, 400);
  assert.equal(creds.size, 0, "input tidak valid tidak menyimpan apa pun");
  const saved = await call("/me/qality", { method: "POST", body: { token: "  " + TOKEN + "  ", expiresAt: "2099-10-20" } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, { ok: true, qality_tersimpan: true, qality_expires_at: "2099-10-20" });
  assert.equal(creds.get("user-a").token, TOKEN, "token disimpan sudah di-trim");
  const me = (await call("/me")).body;
  assert.equal(me.qality_tersimpan, true);
  assert.equal(me.qality_expires_at, "2099-10-20");
  assert.equal((await call("/me", { code: "code-b" })).body.qality_tersimpan, false, "token per user");

  // Dry run: rencana persis, kontrak multi-step, duplikat ter-link dilewati.
  calls = [];
  const ok = await preview([multi, dupLinked, single]);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.issueKey, "CD-1234");
  assert.deepEqual(ok.body.project, { key: "CD", id: "10452" });
  assert.equal(ok.body.linkType, "QAlity Test");
  assert.deepEqual(ok.body.counts, { create: 2, skip: 1 });
  assert.deepEqual(ok.body.existing.map((x) => x.key), ["CD-5962"], "hanya issue bertipe QAlity yang dihitung test case");
  const [p0, p1, p2] = ok.body.plan;
  assert.equal(p0.action, "create");
  assert.equal(p0.title, "Verify multi step flow", "spasi judul dinormalisasi");
  assert.deepEqual(p0.testCase, {
    name: "Verify multi step flow",
    testSteps: [
      { step: "Open the synthetic page.", data: "Precondition:\n- Precondition A.\n- Precondition B.", result: "", position: 1 },
      { step: "Fill the synthetic form.", data: "", result: "", position: 2 },
      { step: "Submit the form.", data: "", result: "1. Page shows success.\n2. Data is stored.", position: 3 },
    ],
    properties: {},
  }, "kontrak multi-step: data di step 1, result di step terakhir, position 1..N");
  assert.equal(p1.action, "skip_duplicate");
  assert.equal(p1.duplicateOf, "CD-5962");
  assert.match(p1.reason, /sudah ter-link: CD-5962/);
  assert.equal(p2.action, "create");
  assert.deepEqual(p2.testCase.testSteps, [{ step: "Send a GET request.", data: "", result: "1. Returns 200 OK.", position: 1 }]);
  assert.match(ok.body.previewHash, /^[0-9a-f]{64}$/);
  assert.match(p2.caseHash, /^[0-9a-f]{64}$/);
  // Read-only: dua GET saja (tiket + settings), tanpa description, token di header QAlity.
  assert.deepEqual(calls.map((c) => c.method + " " + c.host + c.path).sort(),
    ["GET apps-qalityplus.soldevelo.com/api/qalitySettings", "GET jira.test/rest/api/3/issue/CD-1234"]);
  assert.equal(new URLSearchParams(calls.find((c) => c.host === "jira.test").search).get("fields"), "project,issuetype,issuelinks");
  assert.equal(calls.find((c) => c.host !== "jira.test").auth, "Bearer " + TOKEN);

  // previewHash stabil terhadap spasi/urutan kunci, berubah bila isi berubah.
  const again = await preview([
    { expected: [" Page shows success. ", "Data is stored."], steps: multi.steps, preconditions: multi.preconditions, title: "Verify multi step flow" },
    dupLinked, single]);
  assert.equal(again.body.previewHash, ok.body.previewHash);
  const changed = await preview([{ ...multi, expected: ["Page shows success.", "Data is saved."] }, dupLinked, single]);
  assert.notEqual(changed.body.previewHash, ok.body.previewHash);
  const reordered = await preview([single, multi, dupLinked]);
  assert.notEqual(reordered.body.previewHash, ok.body.previewHash, "urutan case bagian dari isi");
  assert.equal(reordered.body.plan[0].caseHash, p2.caseHash, "case_hash tidak bergantung urutan");

  // Idempotency D1: case yang pernah dibuat dari CATET dilewati; status failed tidak.
  pushes.push({ user_id: "user-a", issue_key: "CD-1234", case_hash: p2.caseHash, title: single.title, test_key: "CD-7000", status: "created_linked" });
  pushes.push({ user_id: "user-a", issue_key: "CD-1234", case_hash: p0.caseHash, title: "x", test_key: null, status: "failed" });
  const idem = await preview([multi, dupLinked, single]);
  assert.deepEqual(idem.body.plan.map((p) => [p.action, p.duplicateOf]), [["create", null], ["skip_duplicate", "CD-5962"], ["skip_duplicate", "CD-7000"]]);
  assert.match(idem.body.plan[2].reason, /pernah dibuat dari CATET: CD-7000/);
  assert.equal((await preview([single], "CD-1234", "code-b")).status, 400, "user lain tanpa token");
  const hist = await call("/testcases?issue=cd-1234");
  assert.equal(hist.status, 200);
  assert.deepEqual(hist.body.existing.map((x) => x.key), ["CD-5962"]);
  assert.deepEqual(hist.body.history.map((r) => r.test_key), ["CD-7000", null]);
  assert.equal((await call("/testcases?issue=nope")).status, 400);

  // Keputusan Zack opsi A: project tanpa entri aktif di qalitySettings ditolak.
  const prod = await preview([single], "PROD-77");
  assert.equal(prod.status, 400);
  assert.match(prod.body.error, /Project PROD belum aktif di QAlity/);
  assert.deepEqual(prod.body.eligibleProjects, ["AB", "CD", "MIS"], "project nonaktif tidak dihitung");
  assert.equal((await preview([single], "MIS-1")).status, 409, "id project QAlity ≠ Jira → berhenti");
  assert.match((await preview([single], "CD-5962")).body.error, /sendiri adalah test case QAlity/);
  assert.equal((await preview([single], "NOPE-1")).status, 404);

  // Token ditolak QAlity: pesan buatan Worker, body QAlity (berisi token) tidak diteruskan.
  creds.set("user-a", { token: REVOKED, expires_at: null, updated_at: "2026-10-20T00:00:00Z" });
  const revoked = await preview([single]);
  assert.equal(revoked.status, 400);
  assert.match(revoked.body.error, /Token QAlity ditolak \(HTTP 401\)/);
  // Kedaluwarsa → ditolak sebelum memanggil siapa pun.
  creds.set("user-a", { token: TOKEN, expires_at: "2020-01-01", updated_at: "2026-10-20T00:00:00Z" });
  calls = [];
  assert.match((await preview([single])).body.error, /kedaluwarsa sejak 2020-01-01/);
  assert.equal(calls.length, 0);
  // Hapus token ("" ) → /me false, dry run minta isi token.
  assert.deepEqual((await call("/me/qality", { method: "POST", body: { token: "" } })).body, { ok: true, qality_tersimpan: false, qality_expires_at: null });
  assert.equal((await call("/me")).body.qality_tersimpan, false);
  assert.match((await preview([single])).body.error, /Token QAlity belum disimpan/);
  await call("/me/qality", { method: "POST", body: { token: TOKEN } });

  // Validasi hard di Worker (tanpa panggilan keluar) setara validator browser.
  calls = [];
  const bad = await preview([{ ...single, title: "" }, { ...single, title: "GAP: missing error code" }, { ...single, steps: [] }, { ...single, expected: ["  "] }]);
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.cases.map((c) => c.errors.length > 0), [true, true, true, true]);
  assert.match((await preview(Array.from({ length: 21 }, (_, i) => ({ ...single, title: "Verify " + i })))).body.errors[0], /21 case; maksimal 20/);
  assert.equal((await preview("not-a-list")).status, 400);
  assert.equal((await preview([single], "bad key")).status, 400);
  assert.equal((await call("/testcases/preview", { method: "POST", body: "{" })).status, 400);
  assert.equal((await call("/testcases/preview", { method: "POST", body: JSON.stringify({ issueKey: "CD-1234", cases: [], pad: "x".repeat(300 * 1024) }) })).status, 413);
  assert.equal(calls.length, 0, "body tidak valid tidak memanggil Jira/QAlity");

  const fixtures = [
    [multi, single],
    [multi, { ...multi, title: "VERIFY multi step flow" }],
    [{ ...single, title: "x".repeat(256) }, single],
    [{ ...single, title: "Check without prefix", preconditions: [] }],
    [{ ...single, steps: ["Verify the response."] }],
    [{ ...single, title: "GAP: requirement missing" }],
    [{ ...single, expected: [] }, { ...multi, steps: [] }],
    parseTestCases("**Title:** Verify A\n\n**Test Step(s):**\n1. Open A.\n\n**Expected Result:**\n1. A opens.\n\n---\n\n**Title:** Validate B\n\n**Precondition:**\n- B exists.\n\n**Test Step(s):**\n1. Open B.\n2. Close B.\n\n**Expected Result:**\n1. B closes.\n").cases
      .map(({ title, preconditions, steps, expected }) => ({ title, preconditions, steps, expected })),
  ];
  for (const cases of fixtures) {
    const browser = validateTestCases(cases);
    const res = await preview(cases);
    assert.equal(res.status === 200, browser.ok, "status setara untuk " + JSON.stringify(cases).slice(0, 80));
    if (!browser.ok) {
      assert.deepEqual(res.body.cases.map((c) => c.errors.length > 0), browser.cases.map((c) => c.errors.length > 0));
      assert.equal(res.body.errors.length > 0, browser.errors.length > 0);
    }
  }

  // Fase 2 tidak punya push/relink; seluruh pengujian hanya GET ke luar.
  calls = [];
  assert.equal((await call("/testcases/push", { method: "POST", body: { issueKey: "CD-1234", cases: [single], previewHash: "x" } })).status, 404);
  assert.equal((await call("/testcases/relink", { method: "POST", body: { issueKey: "CD-1234", testKey: "CD-1" } })).status, 404);
  assert.equal(calls.length, 0);

  // Hapus user lewat admin ikut menghapus token QAlity-nya.
  const del = await worker.fetch(new Request("https://worker.test/admin/users/user-a", { method: "DELETE", headers: { "X-Admin-Key": "synthetic-admin" } }), env);
  assert.equal(del.status, 200);
  assert.equal(creds.has("user-a"), false);
  assert.deepEqual([...methods], ["GET"], "tidak ada POST/PUT/DELETE ke Jira/QAlity");
} finally {
  globalThis.fetch = realFetch;
}
console.log("test_testcase_worker: PASS");
