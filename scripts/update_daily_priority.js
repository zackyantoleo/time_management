#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ENGINE = path.resolve(__dirname, "../assets/js/priority-engine.js");
const context = {};
vm.createContext(context);
vm.runInContext(fs.readFileSync(ENGINE, "utf8"), context);
const engine = context.CatetPriorityEngine;
if (!engine) throw new Error("CatetPriorityEngine tidak termuat");

function args() {
  const out = { dryRun: false, worker: process.env.CATET_WORKER_URL || "https://catet-jira-proxy.zackyanto-leo.workers.dev" };
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--dry-run") out.dryRun = true;
    else if (process.argv[i] === "--worker-url") out.worker = process.argv[++i];
    else throw new Error("Argumen tidak dikenal: " + process.argv[i]);
  }
  return out;
}
async function jsonRequest(url, options = {}) {
  const headers = { "User-Agent": "Catet-Daily-Priority/2.0", Origin: "https://zackyantoleo.github.io", ...(options.headers || {}) };
  const key = (process.env.CATET_ACCESS_KEY || "").trim();
  if (key) headers["X-Catet-Key"] = key;
  const response = await fetch(url, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.error || "request failed"}`);
  return body;
}
(async () => {
  const config = args();
  const base = config.worker.replace(/\/+$/, "");
  const state = await jsonRequest(base + "/state");
  if (!state.stores) throw new Error("Worker state kosong");
  const snapshot = engine.snapshot({
    tasks: state.stores.tasks || [],
    sprints: state.stores.sprints || { list: [] },
    jira: state.stores.jira || {},
    now: new Date(),
  });
  if (!config.dryRun) {
    const serviceToken = (process.env.CATET_PRIORITY_SERVICE_TOKEN || "").trim();
    if (!serviceToken && !process.env.CATET_ACCESS_KEY) {
      throw new Error("CATET_PRIORITY_SERVICE_TOKEN atau CATET_ACCESS_KEY wajib untuk write");
    }
    await jsonRequest(base + "/priority-snapshot", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(serviceToken ? { Authorization: "Bearer " + serviceToken } : {}),
      },
      body: JSON.stringify(snapshot),
    });
  }
  console.log(JSON.stringify(snapshot));
})().catch((error) => { console.error("daily priority update failed:", error.message); process.exit(1); });
