import assert from "node:assert/strict";
import { copyFile, unlink } from "node:fs/promises";

const source = new URL("../worker/worker.js", import.meta.url);
const temp = "/tmp/catet-state-v2-worker-test.mjs";
await copyFile(source, temp);
const { default: worker } = await import("file://" + temp + "?v=" + Date.now());

const origin = "https://zackyantoleo.github.io";
const user = { id: "user-1", name: "Zack", jira_site: null, jira_email: null, jira_token: null, cal_ics_url: null };
const documents = new Map();
const worklogs = new Map();
const migrations = [];
let legacyReads = 0;
let stateDocumentReads = 0;
let schemaReady = false;

function key(userId, kind) { return `${userId}:${kind}`; }
function statement(sql) {
  return {
    bind(...params) { this.params = params; return this; },
    async first() {
      if (sql.includes("FROM users WHERE token_hash")) return user;
      if (sql.includes("FROM state_documents")) {
        stateDocumentReads++;
        const row = documents.get(key(this.params[0], this.params[1]));
        return row ? { ...row } : null;
      }
      if (sql.includes("SELECT blob FROM states")) {
        legacyReads++;
        return null;
      }
      if (sql.includes("SELECT revision FROM state_documents")) {
        const row = documents.get(key(this.params[0], this.params[1]));
        return row ? { revision: row.revision } : null;
      }
      return null;
    },
    async run() {
      if ((sql.includes("state_documents") || sql.includes("worklog_entries")) && !schemaReady) {
        throw new Error("no such table: state_documents");
      }
      if (sql.includes("INSERT INTO state_documents")) {
        const [userId, kind, schemaVersion, revision, blob, updatedAt] = this.params;
        const k = key(userId, kind);
        if (documents.has(k)) return { success: true, meta: { changes: 0 } };
        documents.set(k, { kind, schema_version: schemaVersion, revision, blob, updated_at: updatedAt });
        return { success: true, meta: { changes: 1 } };
      }
      if (sql.includes("UPDATE state_documents")) {
        const [blob, schemaVersion, updatedAt, userId, kind, expectedRevision] = this.params;
        const k = key(userId, kind);
        const row = documents.get(k);
        if (!row || row.revision !== expectedRevision) return { success: true, meta: { changes: 0 } };
        documents.set(k, { ...row, blob, schema_version: schemaVersion, revision: row.revision + 1, updated_at: updatedAt });
        return { success: true, meta: { changes: 1 } };
      }
      if (sql.includes("INSERT INTO worklog_entries")) {
        const [userId, id, taskId, occurredAt, localDate, text, priority, minutes, metadata, deletedAt] = this.params;
        const k = key(userId, id);
        if (worklogs.has(k)) return { success: true, meta: { changes: 0 } };
        worklogs.set(k, { id, task_id: taskId, occurred_at: occurredAt, local_date: localDate, text, priority, minutes, metadata, deleted_at: deletedAt });
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 0 } };
    },
    async all() {
      if (sql.includes("FROM state_documents")) {
        return { results: [...documents.values()].map((x) => ({ ...x })) };
      }
      if (sql.includes("FROM worklog_entries")) {
        return { results: [...worklogs.values()].map((x) => ({ ...x })) };
      }
      return { results: [] };
    },
  };
}
const env = {
  REQUIRE_AUTH: "1",
  CATET_DB: { prepare: statement, async exec(sql) { migrations.push(sql); schemaReady = true; } },
};
const headers = { Origin: origin, "X-Catet-Key": "valid-code", "Content-Type": "application/json" };
const request = (path, method = "GET", body) => new Request("https://worker.test" + path, {
  method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const created = await worker.fetch(request("/v2/state/tasks", "PUT", {
  schemaVersion: 2, revision: 0, data: [{ id: "task-1", text: "Design schema v2" }],
}), env);
assert.equal(created.status, 201);
assert.deepEqual(await created.json(), { ok: true, kind: "tasks", schemaVersion: 2, revision: 1 });
assert(migrations.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS state_documents")));
assert(migrations.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS worklog_entries")));

const fetched = await worker.fetch(request("/v2/state/tasks"), env);
assert.equal(fetched.status, 200);
assert.deepEqual(await fetched.json(), {
  kind: "tasks", schemaVersion: 2, revision: 1, data: [{ id: "task-1", text: "Design schema v2" }],
});

const updated = await worker.fetch(request("/v2/state/tasks", "PUT", {
  schemaVersion: 2, revision: 1, data: [{ id: "task-1", text: "Implement schema v2" }],
}), env);
assert.equal(updated.status, 200);
assert.equal((await updated.json()).revision, 2);

const conflict = await worker.fetch(request("/v2/state/tasks", "PUT", {
  schemaVersion: 2, revision: 1, data: [{ id: "task-1", text: "Stale writer" }],
}), env);
assert.equal(conflict.status, 409);
assert.deepEqual(await conflict.json(), { error: "State berubah di perangkat lain.", currentRevision: 2 });

const invalidKind = await worker.fetch(request("/v2/state/jira-cache"), env);
assert.equal(invalidKind.status, 404);
const invalidDocument = await worker.fetch(request("/v2/state/tasks", "PUT", {
  schemaVersion: 2, revision: 2, data: { id: "not-an-array" },
}), env);
assert.equal(invalidDocument.status, 400);
const missingDocument = await worker.fetch(request("/v2/state/sprints", "PUT", {
  schemaVersion: 2, revision: 1, data: { list: [], aktif: null },
}), env);
assert.equal(missingDocument.status, 404);

const createdLog = await worker.fetch(request("/v2/worklogs", "POST", {
  id: "log-1", taskId: "task-1", occurredAt: "2026-08-22T04:00:00.000Z",
  localDate: "2026-08-22", text: "Implement schema", priority: "tinggi", minutes: 45,
}), env);
assert.equal(createdLog.status, 201);
const duplicateLog = await worker.fetch(request("/v2/worklogs", "POST", {
  id: "log-1", taskId: "task-1", occurredAt: "2026-08-22T04:00:00.000Z",
  localDate: "2026-08-22", text: "Duplicate", priority: "tinggi", minutes: 45,
}), env);
assert.equal(duplicateLog.status, 409);
const listedLogs = await worker.fetch(request("/v2/worklogs?since=2026-08-01&limit=20"), env);
assert.equal(listedLogs.status, 200);
assert.equal((await listedLogs.json()).items.length, 1);

const legacy = await worker.fetch(request("/state"), env);
assert.equal(legacy.status, 200);
assert.deepEqual(await legacy.json(), { updatedAt: null, stores: null });
assert(stateDocumentReads > 0);
assert(legacyReads > 0, "legacy /state endpoint must remain available during migration");

console.log(JSON.stringify({ created: created.status, updated: updated.status, conflict: conflict.status,
  documentReads: stateDocumentReads, legacyReads, worklogs: worklogs.size, migrations: migrations.length }));
await unlink(temp).catch(() => {});
