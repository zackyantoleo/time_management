import assert from "node:assert/strict";
import { copyFile, unlink } from "node:fs/promises";

const source = new URL("../worker/worker.js", import.meta.url);
const temp = "/tmp/catet-priority-worker-test.mjs";
await copyFile(source, temp);
const { default: worker } = await import("file://" + temp + "?v=" + Date.now());

let stateWrites = 0;
let snapshotWrites = 0;
let storedSnapshot = null;
function statement(sql) {
  return {
    bind(...params) { this.params = params; return this; },
    async first() {
      if (sql.includes("SELECT id, name")) return null;
      if (sql.includes("SELECT blob FROM priority_snapshots")) return storedSnapshot ? { blob: JSON.stringify(storedSnapshot) } : null;
      return null;
    },
    async run() {
      if (sql.includes("priority_snapshots")) { snapshotWrites++; storedSnapshot = JSON.parse(this.params[1]); }
      if (sql.includes("states")) stateWrites++;
      return { success: true };
    },
    async all() { return { results: [] }; },
  };
}
const env = {
  PRIORITY_SERVICE_TOKEN: "service-secret",
  CATET_DB: { prepare: statement, async exec() {} },
};
const origin = "https://zackyantoleo.github.io";
const snapshot = { date: "2026-08-20", generatedAt: "2026-08-20T01:00:00Z", active: 2, today: 1, items: [{ taskId: "a", score: 8, rank: 1 }] };
function put(token) {
  return new Request("https://worker.test/priority-snapshot", {
    method: "PUT",
    headers: { Origin: origin, "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: JSON.stringify(snapshot),
  });
}
const denied = await worker.fetch(put(""), env);
assert.equal(denied.status, 401);
const accepted = await worker.fetch(put("service-secret"), env);
assert.equal(accepted.status, 200);
assert.equal(snapshotWrites, 1);
assert.equal(stateWrites, 0, "priority endpoint must never mutate states");
const fetched = await worker.fetch(new Request("https://worker.test/priority-snapshot", { headers: { Origin: origin } }), env);
assert.deepEqual(await fetched.json(), snapshot);
console.log(JSON.stringify({ denied: denied.status, accepted: accepted.status, snapshotWrites, stateWrites }));
await unlink(temp).catch(() => {});
