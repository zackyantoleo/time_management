// ready-notifications.js — state machine notifikasi tiket QA yang baru siap dites.
// Murni/deterministik supaya bisa diuji di Node dan dipakai browser tanpa build.
"use strict";

(function (root) {
  const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalize(value) {
    const state = value && typeof value === "object" ? clone(value) : {};
    state.initialized = !!state.initialized;
    state.readiness = state.readiness && typeof state.readiness === "object" ? state.readiness : {};
    state.items = state.items && typeof state.items === "object" ? state.items : {};
    return state;
  }

  function depReady(dep) {
    return !!(dep && dep.ready === true);
  }

  function reconcile(value, deps, metadata, nowMs) {
    const state = normalize(value);
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const currentDeps = deps && typeof deps === "object" ? deps : {};
    const meta = metadata && typeof metadata === "object" ? metadata : {};
    const baseline = !state.initialized;
    const previous = state.readiness;
    const current = {};
    const added = [];

    for (const [key, dep] of Object.entries(currentDeps)) {
      const isReady = depReady(dep);
      const wasReady = previous[key] === true;
      current[key] = isReady;
      const sourceReadyAt = dep && dep.readyAt ? Date.parse(dep.readyAt) : NaN;
      const recentSourceEvent = isReady && Number.isFinite(sourceReadyAt) &&
        sourceReadyAt <= now && sourceReadyAt + RETENTION_MS > now;
      if (isReady && !wasReady && (!baseline || recentSourceEvent)) {
        const eventAt = recentSourceEvent ? sourceReadyAt : now;
        const info = meta[key] || {};
        state.items[key] = {
          key,
          summary: String(info.summary || ""),
          status: String(info.status || ""),
          sprintId: info.sprintId == null ? null : String(info.sprintId),
          sprintName: info.sprintName == null ? null : String(info.sprintName),
          devKeys: Array.isArray(dep.keys) ? dep.keys.map(String) : [],
          readyAt: eventAt,
          expiresAt: eventAt + RETENTION_MS,
        };
        added.push(key);
      }
    }

    for (const key of Object.keys(state.items)) {
      const item = state.items[key];
      if (!item || !Number.isFinite(Number(item.expiresAt)) || Number(item.expiresAt) <= now) {
        delete state.items[key];
      }
    }
    state.initialized = true;
    // Missing from the latest feed is unknown, not false. Keep the last known
    // readiness so a temporary partial Jira response cannot create a fake edge.
    state.readiness = { ...previous, ...current };
    state.lastObservedAt = now;
    return { state, added };
  }

  function visible(value, nowMs) {
    const state = normalize(value);
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    return Object.values(state.items)
      .filter((item) => item && Number(item.expiresAt) > now)
      .sort((a, b) => Number(b.readyAt) - Number(a.readyAt));
  }

  root.CatetReadyNotifications = { RETENTION_MS, normalize, reconcile, visible };
})(typeof globalThis !== "undefined" ? globalThis : this);
