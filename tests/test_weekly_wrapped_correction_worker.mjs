import assert from "node:assert/strict";
import { copyFile, readFile, unlink } from "node:fs/promises";

const source = new URL("../worker/worker.js", import.meta.url);
const temp = "/tmp/catet-weekly-wrapped-correction-worker-test.mjs";
await copyFile(source, temp);
const { default: worker } = await import("file://" + temp + "?v=" + Date.now());

const reports = new Map();
const corrections = new Map();
const CATET_USER_ID = "catet-user-id";
const CATET_ACCESS_KEY = "catet-user-key";
const OTHER_USER_ID = "other-user-id";
const OTHER_ACCESS_KEY = "other-user-key";
const encoder = new TextEncoder();
const accessHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(CATET_ACCESS_KEY))))
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");
const otherAccessHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(OTHER_ACCESS_KEY))))
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");

function key(userId, reportId) { return `${userId}:${reportId}`; }

const report = JSON.parse(await readFile(new URL("../assets/data/weekly-wrapped.sample.json", import.meta.url), "utf8"));

const env = {
  REQUIRE_AUTH: "1",
  WEEKLY_WRAPPED_SERVICE_TOKEN: "wrapped-secret",
  CATET_DB: {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes("FROM users WHERE token_hash")) {
                if (args[0] === accessHash) return { id: CATET_USER_ID, name: "Zack" };
                if (args[0] === otherAccessHash) return { id: OTHER_USER_ID, name: "Other" };
                return null;
              }
              if (sql.includes("FROM weekly_wrapped_reports")) {
                const row = reports.get(args[0]);
                return row ? { ...row } : null;
              }
              if (sql.includes("FROM weekly_wrapped_corrections")) {
                const row = corrections.get(key(args[0], args[1]));
                return row ? { blob: row.blob, idempotency_key: row.idempotency_key } : null;
              }
              return null;
            },
            async run() {
              if (sql.includes("INSERT INTO weekly_wrapped_reports")) {
                reports.set(args[0], { report_id: args[1], blob: args[2], updated_at: args[3] });
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes("INSERT INTO weekly_wrapped_corrections")) {
                const [userId, reportId, correctionId, blob, idempotencyKey, updatedAt] = args;
                const existing = corrections.get(key(userId, reportId));
                if (sql.includes("ON CONFLICT") && existing) {
                  if (existing.idempotency_key === idempotencyKey) {
                    return { success: true, meta: { changes: 0 } };
                  }
                  corrections.set(key(userId, reportId), {
                    user_id: userId, report_id: reportId, correction_id: correctionId,
                    blob, idempotency_key: idempotencyKey, updated_at: updatedAt,
                  });
                  return { success: true, meta: { changes: 1 } };
                }
                corrections.set(key(userId, reportId), {
                  user_id: userId, report_id: reportId, correction_id: correctionId,
                  blob, idempotency_key: idempotencyKey, updated_at: updatedAt,
                });
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes("UPDATE weekly_wrapped_reports")) {
                throw new Error("correction path must not rewrite the immutable report");
              }
              return { success: true, meta: { changes: 0 } };
            },
            async all() { return { results: [] }; },
          };
        },
      };
    },
    async exec() { return; },
    async batch() { return []; },
  },
};

const origin = { Origin: "https://zackyantoleo.github.io" };
const accessHeaders = { ...origin, "X-Catet-Key": CATET_ACCESS_KEY, "Content-Type": "application/json" };

function correctionBody(overrides = {}) {
  return {
    schema_version: 1,
    report_id: "2026-W35",
    generated_at: "2026-09-02T13:00:00.000Z",
    verdict: "looks_right",
    note: "",
    ...overrides,
  };
}

try {
  const seeded = await worker.fetch(new Request("https://worker.test/weekly-wrapped", {
    method: "PUT",
    headers: { ...accessHeaders, Authorization: "Bearer wrapped-secret" },
    body: JSON.stringify(report),
  }), env);
  assert.equal(seeded.status, 200, "seed live report");

  const unauth = await worker.fetch(new Request("https://worker.test/weekly-wrapped/corrections", {
    method: "POST", headers: { ...origin, "Content-Type": "application/json" }, body: JSON.stringify(correctionBody()),
  }), env);
  assert.equal(unauth.status, 401, "corrections require the CATET access key");

  const missingReport = await worker.fetch(new Request("https://worker.test/weekly-wrapped/corrections", {
    method: "POST", headers: { ...origin, "X-Catet-Key": OTHER_ACCESS_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(correctionBody()),
  }), env);
  assert.equal(missingReport.status, 404, "cannot correct a report the user does not own");

  const stale = await worker.fetch(new Request("https://worker.test/weekly-wrapped/corrections", {
    method: "POST", headers: accessHeaders,
    body: JSON.stringify(correctionBody({ generated_at: "2026-09-01T00:00:00.000Z" })),
  }), env);
  assert.equal(stale.status, 409, "correction must point at the stored snapshot generated_at");

  const leak = await worker.fetch(new Request("https://worker.test/weekly-wrapped/corrections", {
    method: "POST", headers: accessHeaders,
    body: JSON.stringify(correctionBody({
      verdict: "missed",
      note: "see https://private.example/raw and zack@erajaya.com",
    })),
  }), env);
  assert.equal(leak.status, 400, "email/URL/raw evidence must be rejected");

  const ack = await worker.fetch(new Request("https://worker.test/weekly-wrapped/corrections", {
    method: "POST", headers: accessHeaders, body: JSON.stringify(correctionBody()),
  }), env);
  assert.equal(ack.status, 200);
  const ackBody = await ack.json();
  assert.equal(ackBody.verdict, "looks_right");
  assert.equal(ackBody.report_id, "2026-W35");
  assert.equal(ackBody.generated_at, "2026-09-02T13:00:00.000Z");
  assert.ok(ackBody.correction_id);
  const reportAfterAck = JSON.parse(reports.get(CATET_USER_ID).blob);
  assert.equal(reportAfterAck.report.summary, report.report.summary, "ack must not mutate the published report");

  const ackAgain = await worker.fetch(new Request("https://worker.test/weekly-wrapped/corrections", {
    method: "POST", headers: accessHeaders, body: JSON.stringify(correctionBody()),
  }), env);
  assert.equal(ackAgain.status, 200);
  const ackAgainBody = await ackAgain.json();
  assert.equal(ackAgainBody.correction_id, ackBody.correction_id);
  assert.equal(ackAgainBody.revision, ackBody.revision, "identical submit is idempotent");
  assert.equal(corrections.size, 1, "duplicate ack must not insert another row");

  const missed = await worker.fetch(new Request("https://worker.test/weekly-wrapped/corrections", {
    method: "POST", headers: accessHeaders,
    body: JSON.stringify(correctionBody({ verdict: "missed", note: "Hidden pairing review" })),
  }), env);
  assert.equal(missed.status, 200);
  const missedBody = await missed.json();
  assert.equal(missedBody.correction_id, ackBody.correction_id);
  assert.equal(missedBody.verdict, "missed");
  assert.ok(missedBody.revision > ackBody.revision);
  assert.equal(corrections.size, 1, "changed verdict updates the same record");

  const otherRead = await worker.fetch(new Request("https://worker.test/weekly-wrapped/corrections?report_id=2026-W35", {
    headers: { ...origin, "X-Catet-Key": OTHER_ACCESS_KEY },
  }), env);
  assert.equal(otherRead.status, 200);
  const otherJson = await otherRead.json();
  assert.equal(otherJson.correction, null, "per-user access boundary remains");

  const ownRead = await worker.fetch(new Request("https://worker.test/weekly-wrapped/corrections?report_id=2026-W35", {
    headers: { ...origin, "X-Catet-Key": CATET_ACCESS_KEY },
  }), env);
  assert.equal(ownRead.status, 200);
  const ownJson = await ownRead.json();
  assert.equal(ownJson.correction.verdict, "missed");
  assert.equal(ownJson.correction.note, "Hidden pairing review");
} finally {
  await unlink(temp).catch(() => {});
}

console.log("weekly wrapped correction worker tests: ok");
