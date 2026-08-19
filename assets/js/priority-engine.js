// priority-engine.js — evaluator prioritas murni untuk browser dan Node cron.
// Tidak membaca global state dan tidak memutasi task; semua waktu masuk eksplisit.
"use strict";

(function (root) {
  const BASE_PRIORITY = { urgent: 6, tinggi: 4, sedang: 3, rendah: 1 };
  const TODAY_THRESHOLD = 6;
  const JIRA_RE = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/;
  const ACTIVE = new Set(["aktif", "fokus"]);

  function asDate(value) {
    if (value instanceof Date) return value;
    const d = new Date(value);
    return isNaN(d) ? null : d;
  }
  function localDate(date) {
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" +
      String(date.getDate()).padStart(2, "0");
  }
  function duePoints(task, now) {
    if (!task.due) return 0;
    const due = asDate(task.due);
    if (!due) return 0;
    const hours = (due - now) / 3600000;
    return hours < 0 ? 4 : hours <= 24 ? 3 : hours <= 48 ? 2 : 1;
  }
  function sprintEnd(sprint) {
    if (!sprint || !sprint.selesai) return null;
    const parts = String(sprint.selesai).slice(0, 10).split("-").map(Number);
    if (parts.length !== 3 || parts.some((x) => !Number.isFinite(x))) return null;
    return new Date(parts[0], parts[1] - 1, parts[2], 23, 59, 59);
  }
  function dependency(task, jira) {
    const match = String(task.text || "").match(JIRA_RE);
    return match && jira && jira.deps ? jira.deps[match[1]] || null : null;
  }
  function createEvaluator({ tasks, sprints, jira, now }) {
    now = asDate(now) || new Date();
    tasks = Array.isArray(tasks) ? tasks : [];
    const sprintList = sprints && Array.isArray(sprints.list) ? sprints.list : [];
    const sprintMap = new Map(sprintList.map((s) => [s.id, s]));
    const remaining = new Map();
    for (const task of tasks) {
      if (task.status !== "selesai" && task.sprintId) {
        if (!remaining.has(task.sprintId)) remaining.set(task.sprintId, []);
        remaining.get(task.sprintId).push(task);
      }
    }
    function sprintPoints(task) {
      if (!task.sprintId) return 0;
      const sprint = sprintMap.get(task.sprintId);
      if (!sprint || sprint.status === "selesai") return 0;
      const end = sprintEnd(sprint);
      if (!end) return 0;
      const hours = (end - now) / 3600000;
      if (hours < 0) return 4;
      let points = hours <= 24 ? 4 : hours <= 72 ? 3 : hours <= 168 ? 2 : 1;
      const perDay = (remaining.get(sprint.id) || []).length / Math.max(hours / 24, 0.5);
      if (perDay >= 1.5) points = Math.min(4, points + 1);
      return points;
    }
    function score(task) {
      const base = task.dampak ? task.dampak * 2 : (BASE_PRIORITY[task.priority] || 3);
      const effort = task.usaha === "L" ? 2 : task.usaha === "M" ? 1 : 0;
      const wip = (task.focusMins || 0) > 0 || task.ditumpuk ? 1 : 0;
      const created = asDate(task.createdAt);
      const aging = created && now - created >= 3 * 86400000 ? 1 : 0;
      const raw = Math.min(12, base + Math.max(duePoints(task, now), sprintPoints(task)) + effort + wip + aging);
      return Math.min(10, Math.round((raw / 12) * 10));
    }
    function compare(a, b) {
      const diff = score(b) - score(a);
      if (diff) return diff;
      const ad = asDate(a.due), bd = asDate(b.due);
      if (ad && bd) return ad - bd;
      if (ad) return -1;
      if (bd) return 1;
      return (asDate(a.createdAt) || now) - (asDate(b.createdAt) || now);
    }
    function quota() {
      const selected = new Set();
      for (const sprint of sprintList.filter((s) => s.status !== "selesai")) {
        const members = (remaining.get(sprint.id) || []).slice();
        if (!members.length) continue;
        const end = sprintEnd(sprint);
        if (!end) continue;
        const days = Math.max((end - now) / 86400000, 0.5);
        const count = Math.ceil(members.length / days);
        const blocked = (task) => {
          const dep = dependency(task, jira || {});
          return dep && !dep.ready ? 1 : 0;
        };
        members.sort((a, b) => blocked(a) - blocked(b) || compare(a, b))
          .slice(0, count).forEach((task) => selected.add(task.id));
      }
      return selected;
    }
    function isToday(task, quotaSet) {
      if (task.priority === "urgent" || task.dampak === 3) return true;
      if (duePoints(task, now) >= 3) return true;
      const dep = dependency(task, jira || {});
      if (dep && dep.ready) return true;
      const sprint = task.sprintId && sprintMap.get(task.sprintId);
      if (sprint && sprint.status !== "selesai") return (quotaSet || quota()).has(task.id);
      return score(task) >= TODAY_THRESHOLD;
    }
    return { now, score, compare, quota, isToday, sprintPoints };
  }
  function snapshot({ tasks, sprints, jira, now }) {
    now = asDate(now) || new Date();
    const evaluator = createEvaluator({ tasks, sprints, jira, now });
    const quotaSet = evaluator.quota();
    const active = (Array.isArray(tasks) ? tasks : [])
      .filter((task) => ACTIVE.has(task.status) && !task.ditumpuk);
    const selected = active.filter((task) => evaluator.isToday(task, quotaSet)).sort(evaluator.compare);
    return {
      date: localDate(now),
      generatedAt: now.toISOString(),
      active: active.length,
      today: selected.length,
      items: selected.map((task, index) => ({ taskId: task.id, text: task.text, score: evaluator.score(task), rank: index + 1 })),
    };
  }
  root.CatetPriorityEngine = { createEvaluator, snapshot, duePoints };
})(typeof globalThis !== "undefined" ? globalThis : this);
