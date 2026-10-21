// K5: test case QAlity tidak boleh masuk inbox /tickets, dependensi tiket,
// atau kandidat pairing — lalu hasil Worker dijalankan lewat kode badge asli
// di jira.js (jalur irisan link+description dan jalur fallback feed.deps).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = (await readFile(new URL("../worker/worker.js", import.meta.url), "utf8")).replace("../assets/js/work-pattern-report-contract.js", new URL("../assets/js/work-pattern-report-contract.js", import.meta.url).href);
const { default: worker } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));

const sprint = { id: 77, state: "active", name: "Sprint 77", endDate: "2026-11-01T00:00:00Z" };
const status = (name, key) => ({ name, statusCategory: { key } });
const linked = (key, issuetype, st, typeName = "Relates", side = "outwardIssue") => ({
  type: { name: typeName }, [side]: { key, fields: { issuetype: { name: issuetype }, status: st } },
});
const doc = (...keys) => ({ type: "doc", content: [{ type: "paragraph", content: keys.map((k) => ({ type: "text", text: k + " " })) }] });
const issue = (key, issuetype, summary, extra = {}) => ({
  key,
  fields: {
    summary, status: extra.status || status("To Do", "new"), created: "2026-10-20T00:00:00Z",
    issuetype: { name: issuetype }, parent: null, components: [], labels: extra.labels || [],
    issuelinks: extra.links || [], description: extra.description || null,
    customfield_10020: extra.noSprint ? null : [sprint],
  },
});

// QA-301: link dev + chip dev di description (jalur irisan), plus test case
// ter-link dan test case yang hanya disebut di description.
const qa301 = issue("QA-301", "Task", "Test voucher expiry", {
  labels: ["qa"],
  links: [linked("DEV-401", "Story", status("Done", "done")),
    linked("CD-5962", "QAlity Test", status("To Do", "new"), "QAlity Test", "inwardIssue")],
  description: doc("DEV-401", "CD-5970"),
});
// QA-302: tanpa chip di description → jalur fallback feed.deps. Sebelum K5
// test case CD-5963 ikut deps dan badge jadi "⏳ dev: CD-5963".
const qa302 = issue("QA-302", "Task", "Test checkout", {
  labels: ["qa"],
  links: [linked("CD-5963", "QAlity Test", status("To Do", "new"), "QAlity Test", "inwardIssue"),
    // Test case milik orang lain: tidak di-assign ke user, hanya terlihat
    // lewat link — tetap bukan dependensi.
    linked("CD-5980", "QAlity Test", status("To Do", "new"), "Relates", "inwardIssue"),
    linked("DEV-402", "Story", status("Done", "done"))],
});
// Tiket QA rekan satu sprint (bukan milik user): link test case-nya hanya
// terlihat di pool pairing.
const qa303 = issue("QA-303", "Task", "Test refund", {
  labels: ["qa"],
  links: [linked("CD-5981", "QAlity Test", status("To Do", "new"), "QAlity Test", "inwardIssue")],
});
const tc5962 = issue("CD-5962", "QAlity Test", "Verify voucher expiry", {
  links: [linked("QA-301", "Task", status("To Do", "new"), "QAlity Test")],
});
const tc5963 = issue("CD-5963", "QAlity Test", "Verify checkout", { noSprint: true });
const dev401 = issue("DEV-401", "Story", "Implement voucher expiry", { status: status("Done", "done") });
const dev402 = issue("DEV-402", "Story", "Implement checkout", { status: status("Done", "done") });

let bulkBodies = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.endsWith("/rest/api/3/field")) {
    return new Response(JSON.stringify([{ id: "customfield_10020", schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint" } }]), { status: 200 });
  }
  if (u.includes("/rest/api/3/search/jql")) {
    const decoded = decodeURIComponent(u);
    if (decoded.includes("assignee = currentUser()")) {
      return new Response(JSON.stringify({ issues: [tc5962, qa301, tc5963, qa302], isLast: true }), { status: 200 });
    }
    if (decoded.includes("sprint in (77)")) {
      return new Response(JSON.stringify({ issues: [qa301, qa302, qa303, tc5962, dev401, dev402], isLast: true }), { status: 200 });
    }
  }
  if (u.endsWith("/rest/api/3/issue/bulkfetch") && init.method === "POST") {
    const body = JSON.parse(init.body);
    bulkBodies.push(body);
    const types = { "CD-5970": "QAlity Test", "CD-5962": "QAlity Test", "DEV-401": "Story", "DEV-402": "Story" };
    return new Response(JSON.stringify({ issues: body.issueIdsOrKeys.filter((k) => types[k]).map((k) => ({
      key: k,
      fields: {
        issuetype: { name: types[k] },
        status: k.startsWith("DEV") ? status("Done", "done") : status("To Do", "new"),
        resolutiondate: k.startsWith("DEV") ? "2026-10-19T03:00:00.000+0000" : null,
      },
    })) }), { status: 200 });
  }
  throw new Error("unexpected Jira call: " + u + " " + JSON.stringify(init));
};

let body;
try {
  const response = await worker.fetch(new Request("https://worker.test/tickets?keys=CD-5962", {
    headers: { Origin: "https://zackyantoleo.github.io", "X-Catet-Key": "synthetic-code" },
  }), { CATET_DB: { async exec() {}, prepare() { return { bind() { return this; }, async first() {
    return { id: "synthetic-user", jira_site: "https://jira.test", jira_email: "qa@example.test", jira_token: "secret" };
  } }; } } });
  assert.equal(response.status, 200);
  body = await response.json();
} finally {
  globalThis.fetch = realFetch;
}

// 1. Inbox: test case yang di-assign ke user tidak ikut.
assert.deepStrictEqual(body.items.map((x) => x.key), ["QA-301", "QA-302"], "QAlity test cases must leave the inbox feed");
assert.equal(body.excludedQality, 2);

// 2. Dependensi: hanya tiket dev, bukan test case ter-link / disebut.
const depsOf = (key) => body.items.find((x) => x.key === key).deps.map((d) => d.key);
assert.deepStrictEqual(depsOf("QA-301"), ["DEV-401"], "linked or mentioned QAlity tests are not dependencies");
assert.deepStrictEqual(depsOf("QA-302"), ["DEV-402"], "fallback deps must not wait on the ticket's own test case");
assert.equal(bulkBodies.length, 1);
assert(bulkBodies[0].fields.includes("issuetype"), "bulkfetch must reveal the type of description-only keys");
assert(!bulkBodies[0].issueIdsOrKeys.includes("CD-5963"), "known QAlity dependency keys need no status lookup");

// 3. Status tugas papan tetap dilaporkan walau tiketnya test case.
assert.equal(body.keyStatus["CD-5962"].status, "To Do", "board tasks for test cases still get Jira status");

// 4. Kandidat pairing: test case keluar dari pool dan dari linked/mentioned.
assert.deepStrictEqual(body.pairingIssues.map((x) => x.key).sort(), ["DEV-401", "DEV-402", "QA-301", "QA-302", "QA-303"]);
const pool = (key) => body.pairingIssues.find((x) => x.key === key);
assert.deepStrictEqual(pool("QA-301").linkedKeys, ["DEV-401"]);
assert.deepStrictEqual(pool("QA-301").mentionedKeys, ["DEV-401"]);
assert.deepStrictEqual(pool("QA-302").linkedKeys, ["DEV-402"]);
assert.deepStrictEqual(pool("QA-303").linkedKeys, [], "teammate QA links to test cases are dropped too");

// 5. Replay kode asli browser: nativeDeps (irisan → fallback) + depBadge.
const root = new URL("../", import.meta.url);
const jiraJs = await readFile(new URL("assets/js/jira.js", root), "utf8");
const matcherJs = await readFile(new URL("assets/js/dependency-matcher.js", root), "utf8");
function between(src, start, end) {
  const a = src.indexOf(start), b = src.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, "jira.js markers moved: update this test (" + start.trim() + ")");
  return src.slice(a, b);
}
const ctx = { feed: body.items, jira: { pairingIssues: body.pairingIssues }, el: (tag, css, label) => ({ tag, css, label }), jiraSite: () => "" };
vm.createContext(ctx);
vm.runInContext(matcherJs, ctx);
const result = vm.runInContext(
  between(jiraJs, "    const feedByKey = ", "    hitungPasangan(nativeDeps);") + "\n" +
  between(jiraJs, "function depBadge(dep) {", "\n/* ---------- sinkronisasi otomatis") + "\n" +
  "({ a: nativeDeps['QA-301'], b: nativeDeps['QA-302'], la: depBadge(nativeDeps['QA-301']).label, lb: depBadge(nativeDeps['QA-302']).label })",
  ctx);
assert.deepStrictEqual([...result.a.keys], ["DEV-401"], "link+description intersection still wins");
assert.equal(result.la, "✅ ready to test");
assert.deepStrictEqual([...result.b.keys], ["DEV-402"], "fallback deps no longer include the test case");
assert.equal(result.b.ready, true);
assert.equal(result.lb, "✅ ready to test");
assert(!vm.runInContext("'CD-5962' in nativeDeps", ctx), "a test case never becomes a QA pairing entry");

console.log(JSON.stringify({ ok: true, items: body.items.length, excludedQality: body.excludedQality }));
