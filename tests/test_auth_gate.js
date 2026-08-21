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
for (const key of ["catet.tasks.v1", "catet.worklog.v1", "catet.routines.v1", "catet.routineday.v1", "catet.sprints.v1", "catet.dirty.v1", "catet.synced.v1"]) {
  assert.strictEqual(localStorage.getItem(key), null, key + " must be cleared on signed-out startup");
}

const signedInProxy = vm.runInContext("jira.key='access-code'; jiraProxy()", context);
assert.strictEqual(signedInProxy, "https://worker.example", "access code must enable the data endpoint");

assert(jiraSource.includes('fetch(workerUrl() + "/signup"'), "signup must use the unauthenticated Worker URL");
assert(!jiraSource.includes('fetch(jiraProxy() + "/signup"'), "signup must not depend on an authenticated data URL");
assert(syncSource.includes("!!jiraProxy()"), "state sync must use the authenticated data URL gate");
assert(appSource.includes('document.body.classList.toggle("signed-out", !signedIn)'), "UI must enter signed-out mode");

console.log(JSON.stringify({ ok: true, signedOut: true, cloudSyncBlocked: true }));
