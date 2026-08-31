import assert from "node:assert/strict";
import { copyFile, unlink } from "node:fs/promises";

const source = new URL("../worker/worker.js", import.meta.url);
const temp = "/tmp/catet-dependency-worker-test.mjs";
await copyFile(source, temp);
const { default: worker } = await import("file://" + temp + "?v=" + Date.now());

const sprint = { id: 77, state: "active", name: "Sprint 77", endDate: "2026-09-01T00:00:00Z" };
const status = (name, key) => ({ name, statusCategory: { key } });
const qa = {
  key: "QA-101",
  fields: {
    summary: "Test member cannot redeem expired voucher",
    status: status("To Do", "new"),
    created: "2026-08-20T00:00:00Z",
    issuetype: { name: "Test" }, parent: { key: "EPIC-9" },
    components: [{ name: "Loyalty" }], labels: ["qa"], issuelinks: [],
    description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "internal details" }] }] },
    customfield_10020: [sprint],
  },
};
const dev = {
  key: "DEV-201",
  fields: {
    summary: "Correct loyalty_valid_till_date comparison during redemption",
    status: status("Done", "done"),
    created: "2026-08-19T00:00:00Z",
    issuetype: { name: "Story" }, parent: { key: "EPIC-9" },
    components: [{ name: "Loyalty" }], labels: ["backend"], issuelinks: [],
    description: null, customfield_10020: [sprint],
  },
};
let calls = [];
let assignedPage = 0;
let sprintPage = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  calls.push(String(url));
  if (String(url).endsWith("/rest/api/3/field")) {
    return new Response(JSON.stringify([{ id: "customfield_10020", schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint" } }]), { status: 200 });
  }
  if (String(url).includes("/rest/api/3/search/jql")) {
    const decoded = decodeURIComponent(String(url));
    if (decoded.includes("assignee = currentUser()")) {
      assignedPage++;
      return new Response(JSON.stringify(assignedPage === 1
        ? { issues: [qa], nextPageToken: "assigned-2" }
        : { issues: [], isLast: true }), { status: 200 });
    }
    if (decoded.includes("sprint in (77)")) {
      sprintPage++;
      return new Response(JSON.stringify(sprintPage === 1
        ? { issues: [qa], nextPageToken: "sprint-2" }
        : { issues: [dev], isLast: true }), { status: 200 });
    }
  }
  throw new Error("unexpected Jira call: " + url + " " + JSON.stringify(init));
};

try {
  const response = await worker.fetch(new Request("https://worker.test/tickets", {
    headers: { Origin: "https://zackyantoleo.github.io" },
  }), {
    JIRA_SITE: "https://jira.test",
    JIRA_EMAIL: "qa@example.test",
    JIRA_API_TOKEN: "secret",
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.items.length, 1, "normal inbox feed remains assigned-user only");
  assert.equal(body.pairingIssues.length, 2, "active sprint metadata includes QA and dev candidates, including Done");
  assert.deepStrictEqual(body.pairingIssues.map((x) => x.key).sort(), ["DEV-201", "QA-101"]);
  const q = body.pairingIssues.find((x) => x.key === "QA-101");
  assert.equal(q.issueType, "Test");
  assert.equal(q.parentKey, "EPIC-9");
  assert.deepStrictEqual(q.components, ["Loyalty"]);
  assert.equal(q.sprintId, "77");
  assert.equal(q.assignedToMe, true, "assigned open tickets must be flagged for pairing review");
  assert.equal(body.pairingIssues.find((x) => x.key === "DEV-201").assignedToMe, false,
    "sprint teammates stay in the candidate pool but are not assigned-to-me");
  assert(!("description" in q), "raw Jira descriptions must not be returned to the browser matcher");
  assert(calls.some((x) => decodeURIComponent(x).includes("sprint in (77)")), "worker must query all issues in the active sprint");
  assert.equal(assignedPage, 2, "assigned ticket seed search must follow Jira nextPageToken");
  assert.equal(sprintPage, 2, "active sprint candidate search must follow Jira nextPageToken");
  console.log(JSON.stringify({ ok: true, pairingIssues: body.pairingIssues.length }));
} finally {
  globalThis.fetch = realFetch;
  await unlink(temp).catch(() => {});
}
