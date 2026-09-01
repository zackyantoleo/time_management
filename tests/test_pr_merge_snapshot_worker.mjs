import assert from "node:assert/strict";
import { copyFile, unlink } from "node:fs/promises";

const source = new URL("../worker/worker.js", import.meta.url);
const temp = "/tmp/catet-pr-merge-snapshot-worker-test.mjs";
await copyFile(source, temp);
const { default: worker } = await import("file://" + temp + "?v=" + Date.now());

const rows = new Map();
const CATET_USER_ID = "catet-user-id";
const CATET_ACCESS_KEY = "catet-user-key";
const OTHER_USER_ID = "other-user-id";
const OTHER_ACCESS_KEY = "other-user-key";
const encoder = new TextEncoder();
const accessHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(CATET_ACCESS_KEY))))
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");
const otherAccessHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(OTHER_ACCESS_KEY))))
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");
const env = {
  REQUIRE_AUTH: "1",
  PRIORITY_SERVICE_TOKEN: "service-secret",
  CATET_DB: {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes("SELECT blob FROM pr_merge_snapshots")) {
                const row = rows.get(args[0]);
                return row ? { blob: row.blob } : null;
              }
              if (sql.includes("SELECT id, name") && sql.includes("FROM users")) {
                if (args[0] === accessHash) return { id: CATET_USER_ID, name: "Zack" };
                if (args[0] === otherAccessHash) return { id: OTHER_USER_ID, name: "Other" };
                return null;
              }
              return null;
            },
            async run() {
              if (sql.includes("INSERT INTO pr_merge_snapshots")) {
                rows.set(args[0], { blob: args[1], updatedAt: args[2] });
                return { success: true, meta: { changes: 1 } };
              }
              return { success: true, meta: { changes: 0 } };
            },
            async all() { return { results: [] }; },
          };
        },
      };
    },
    async batch() { return []; },
  },
};

const baseHeaders = { Origin: "https://zackyantoleo.github.io" };
const payload = {
  generatedAt: "2026-09-01T09:45:00.000Z",
  items: [{
    qaKey: "CD-5612",
    qaSummary: "Test Create API Validate",
    qaStatus: "To Do",
    devKey: "CD-5611",
    devSummary: "Create API Validate",
    prId: "718",
    prName: "Create API Validate Voucher",
    prUrl: "https://bitbucket.org/erafone/go-promo/pull-requests/718",
    status: "MERGED",
    mergedAt: "2026-08-31T06:42:33.156Z",
  }],
};

try {
  const accessHeaders = { ...baseHeaders, "X-Catet-Key": CATET_ACCESS_KEY };
  const unauthorized = await worker.fetch(new Request("https://worker.test/pr-merge-snapshot", {
    method: "PUT", headers: { ...baseHeaders, "Content-Type": "application/json" }, body: JSON.stringify(payload),
  }), env);
  assert.equal(unauthorized.status, 401, "service token must be required for writes");

  const missingTarget = await worker.fetch(new Request("https://worker.test/pr-merge-snapshot", {
    method: "PUT",
    headers: { ...baseHeaders, Authorization: "Bearer service-secret", "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }), env);
  assert.equal(missingTarget.status, 401, "service writer must include a valid CATET destination key");

  const invalid = await worker.fetch(new Request("https://worker.test/pr-merge-snapshot", {
    method: "PUT",
    headers: { ...accessHeaders, Authorization: "Bearer service-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ generatedAt: payload.generatedAt, items: [{ qaKey: "bad" }] }),
  }), env);
  assert.equal(invalid.status, 400, "malformed merge items must be rejected");

  const written = await worker.fetch(new Request("https://worker.test/pr-merge-snapshot", {
    method: "PUT",
    headers: { ...accessHeaders, Authorization: "Bearer service-secret", "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }), env);
  assert.equal(written.status, 200);
  assert.equal((await written.json()).ok, true);

  const read = await worker.fetch(new Request("https://worker.test/pr-merge-snapshot", {
    headers: { ...accessHeaders, Authorization: "Bearer service-secret" },
  }), env);
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), payload, "GET must read back the exact written snapshot");

  const otherRead = await worker.fetch(new Request("https://worker.test/pr-merge-snapshot", {
    headers: { ...baseHeaders, Authorization: "Bearer service-secret", "X-Catet-Key": OTHER_ACCESS_KEY },
  }), env);
  assert.equal(otherRead.status, 200);
  assert.deepEqual(await otherRead.json(), { generatedAt: null, items: [] }, "snapshot must be isolated per CATET user");

  const empty = await worker.fetch(new Request("https://worker.test/pr-merge-snapshot", {
    headers: baseHeaders,
  }), env);
  assert.equal(empty.status, 401, "private list must not be readable without auth");
} finally {
  await unlink(temp).catch(() => {});
}

console.log("pr merge snapshot worker tests: ok");
