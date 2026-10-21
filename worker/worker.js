// Catet ⇄ Jira proxy — Cloudflare Worker.
//
// Jira Cloud memblokir panggilan API langsung dari browser (CORS), jadi Worker
// ini jadi perantara: Catet memanggil Worker, Worker memanggil Jira memakai
// API token yang tersimpan sebagai secret di Cloudflare (tidak pernah sampai
// ke browser atau repo).
//
// Setiap endpoint data wajib kode akses valid (header X-Catet-Key → user di
// D1). Kredensial Jira/QAlity/kalender disimpan per user; tidak ada user
// "default" anonim dan tidak ada secret Jira global. Allowlist Origin hanya
// batas CORS browser, bukan autentikasi. Lihat worker/README.md.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  // PUT wajib ada di sini — sinkronisasi state pakai PUT /state; tanpa PUT,
  // preflight CORS gagal dan browser memblokir permintaannya.
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Catet-Key, X-Admin-Key",
  "Access-Control-Max-Age": "86400",
};

// Origin yang boleh memakai proxy ini. Tambahan bisa diset lewat variabel
// ALLOWED_ORIGINS (dipisah koma) tanpa mengubah kode — mis. kalau dipasang di
// domain lain. localhost & file:// diizinkan untuk pengembangan.
const DEFAULT_ORIGINS = [
  "https://zackyantoleo.github.io", // GitHub Pages (produksi)
  "null",                            // dibuka langsung dari file:// → Origin: null
];
function originOk(origin, env) {
  if (!origin) return false; // permintaan non-browser (mis. curl polos) ditolak
  const extra = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (DEFAULT_ORIGINS.includes(origin) || extra.includes(origin)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin); // dev lokal
}

// Validate known storage shapes without stripping unknown legacy fields.
function validCatetStores(stores) {
  const object = v => !!v && typeof v === "object" && !Array.isArray(v);
  const string = v => typeof v === "string" && v.length > 0;
  const date = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
  const timestamp = v => typeof v === "string" && Number.isFinite(Date.parse(v));
  const rows = (v, valid) => Array.isArray(v) && v.every(x => object(x) && valid(x));
  const entries = (v, valid) => rows(v, x => string(x.id) && typeof x.text === "string" && valid(x)) &&
    new Set(v.map(x => x.id)).size === v.length;
  if (!object(stores)) return false;
  if (stores.tasks != null && !entries(stores.tasks, x =>
      (x.status == null || ["aktif", "fokus", "selesai"].includes(x.status)) &&
      ["due", "createdAt", "doneAt", "focusedAt", "ditumpuk"].every(k => x[k] == null || timestamp(x[k])))) return false;
  if (stores.worklog != null && !entries(stores.worklog, x => date(x.date) && timestamp(x.ts) &&
      (x.mins == null || (typeof x.mins === "number" && Number.isFinite(x.mins) && x.mins >= 0)))) return false;
  if (stores.routines != null && !entries(stores.routines, x => Array.isArray(x.days) &&
      x.days.every(d => Number.isInteger(d) && d >= 0 && d <= 6))) return false;
  if (stores.sprints != null && (!object(stores.sprints) || !rows(stores.sprints.list,
      x => string(x.id) && typeof x.nama === "string" && date(x.selesai)))) return false;
  if (stores.routineday != null && (!object(stores.routineday) ||
      (stores.routineday.date != null && !date(stores.routineday.date)) ||
      ["doneIds", "notifiedIds"].some(k => stores.routineday.date != null
        ? !Array.isArray(stores.routineday[k]) || !stores.routineday[k].every(string)
        : stores.routineday[k] != null && !Array.isArray(stores.routineday[k])))) return false;
  if (stores.weekly != null && (!object(stores.weekly) ||
      (stores.weekly.weeks != null && (!object(stores.weekly.weeks) ||
        !Object.values(stores.weekly.weeks).every(w => object(w) &&
          (w.start == null || object(w.start) && (w.start.outcomes == null || rows(w.start.outcomes, object))) &&
          (w.end == null || object(w.end))))))) return false;
  const j = stores.jira;
  if (j != null && (!object(j) || (j.items != null && !rows(j.items, x => string(x.key) && typeof x.summary === "string")) ||
      ["key", "proxy", "site", "calIcs"].some(k => j[k] != null && typeof j[k] !== "string") ||
      ["deps", "depOverrides", "depSuggestions"].some(k => j[k] != null && !object(j[k])) ||
      ["dismissed", "pairingIssues", "depWarnings"].some(k => j[k] != null && !Array.isArray(j[k])) ||
      (j.bau != null && (!object(j.bau) || (j.bau.items != null && !rows(j.bau.items, x => string(x.key) && typeof x.summary === "string")) ||
        (j.bau.alias != null && !object(j.bau.alias)))))) return false;
  return true;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    // no-store: respons /state & /tickets tidak boleh diambil dari cache
    // browser — data sinkronisasi harus selalu segar.
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
  });
}

// Jira menuntut format started "2026-07-14T09:00:00.000+0000" — ISO 8601
// tanpa huruf Z dan tanpa titik dua di offset.
function toJiraDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return d.toISOString().replace("Z", "+0000");
}

// Query D1 dengan auto-buat tabel & auto-tambah kolom baru saat pertama
// dipakai (tanpa langkah migrasi manual). mode: first|run|all.
const SKEMA = [
  "CREATE TABLE IF NOT EXISTS states (user_id TEXT PRIMARY KEY, blob TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS priority_snapshots (user_id TEXT PRIMARY KEY, blob TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS pr_merge_snapshots (user_id TEXT PRIMARY KEY, blob TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS weekly_wrapped_reports (user_id TEXT PRIMARY KEY, report_id TEXT NOT NULL, blob TEXT NOT NULL CHECK (json_valid(blob)), updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS weekly_wrapped_corrections (user_id TEXT NOT NULL, report_id TEXT NOT NULL, correction_id TEXT NOT NULL, blob TEXT NOT NULL CHECK (json_valid(blob)), idempotency_key TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, report_id))",
  "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, jira_site TEXT, jira_email TEXT, jira_token TEXT, cal_ics_url TEXT, created_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS worklog_requests (user_id TEXT NOT NULL, entry_id TEXT NOT NULL, payload_hash TEXT NOT NULL, worklog_id TEXT, PRIMARY KEY (user_id, entry_id))",
  "CREATE TABLE IF NOT EXISTS state_documents (user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('tasks', 'routines', 'sprints', 'jira_overrides')), schema_version INTEGER NOT NULL CHECK (schema_version >= 2), revision INTEGER NOT NULL CHECK (revision >= 1), blob TEXT NOT NULL CHECK (json_valid(blob)), updated_at TEXT NOT NULL, PRIMARY KEY (user_id, kind))",
  "CREATE TABLE IF NOT EXISTS worklog_entries (user_id TEXT NOT NULL, id TEXT NOT NULL, task_id TEXT, occurred_at TEXT NOT NULL, local_date TEXT NOT NULL, text TEXT NOT NULL, priority TEXT, minutes INTEGER NOT NULL DEFAULT 0 CHECK (minutes >= 0), metadata TEXT CHECK (metadata IS NULL OR json_valid(metadata)), deleted_at TEXT, PRIMARY KEY (user_id, id))",
  "CREATE INDEX IF NOT EXISTS idx_worklog_user_date ON worklog_entries (user_id, local_date DESC, occurred_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_worklog_user_task ON worklog_entries (user_id, task_id)",
  // Import test case QAlity (migrasi 0003). Token di tabel sendiri, bukan kolom
  // users: CREATE IF NOT EXISTS aman diulang di sini maupun lewat wrangler.
  "CREATE TABLE IF NOT EXISTS qality_credentials (user_id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at TEXT, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS testcase_pushes (user_id TEXT NOT NULL, issue_key TEXT NOT NULL, case_hash TEXT NOT NULL, title TEXT NOT NULL, test_key TEXT, status TEXT NOT NULL CHECK (status IN ('pending','created_linked','created_unlinked','link_unverified','failed')), error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, issue_key, case_hash))",
];
// Kolom yang ditambahkan setelah tabel pertama dibuat (instalasi lama).
const MIGRASI = ["ALTER TABLE users ADD COLUMN cal_ics_url TEXT"];

// Id custom field "Sprint" (gh-sprint) — beda-beda per instance Jira, jadi
// ditemukan sekali lalu di-cache per site (multi-user bisa beda site).
const SPRINT_FIELD = new Map();
async function sprintFieldId(site, authHeaders) {
  if (SPRINT_FIELD.has(site)) return SPRINT_FIELD.get(site) || null;
  try {
    const r = await fetch(site + "/rest/api/3/field", { headers: authHeaders });
    if (!r.ok) { SPRINT_FIELD.set(site, ""); return null; }
    const fields = await r.json();
    const f = (Array.isArray(fields) ? fields : []).find(
      (x) => x.schema && x.schema.custom === "com.pyxis.greenhopper.jira:gh-sprint");
    SPRINT_FIELD.set(site, f ? f.id : "");
    return f ? f.id : null;
  } catch { SPRINT_FIELD.set(site, ""); return null; }
}
async function d1q(env, sql, params, mode) {
  const jalan = () => {
    const st = env.CATET_DB.prepare(sql).bind(...params);
    return mode === "first" ? st.first() : mode === "all" ? st.all() : st.run();
  };
  try { return await jalan(); }
  catch (e) {
    const m = String(e && e.message);
    if (/no such table/i.test(m)) {
      for (const s of SKEMA) await env.CATET_DB.exec(s);
    } else if (/no such column/i.test(m)) {
      for (const s of MIGRASI) { try { await env.CATET_DB.exec(s); } catch { /* sudah ada */ } }
    } else throw e;
    return await jalan();
  }
}

function jumlahPerubahan(result) {
  if (!result) return 0;
  if (Number.isInteger(result.changes)) return result.changes;
  return result.meta && Number.isInteger(result.meta.changes) ? result.meta.changes : 0;
}

import workPatternContract from "../assets/js/work-pattern-report-contract.js";

function validateWeeklyWrappedReport(body) {
  if (body?.schema_version === 2) {
    try { workPatternContract.validateWorkPatternReport(body); return true; } catch { return false; }
  }
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  const isoWeek = /^\d{4}-W\d{2}$/;
  const tones = new Set(["accent", "success", "info", "warning", "dark"]);
  const kinds = new Set(["fact", "inference", "recommendation"]);
  const confidence = new Set(["high", "medium", "low", "insufficient"]);
  const commitmentStatus = new Set(["shipped", "carry-over", "cancelled", "changed"]);
  const text = (value, max = 2000) => typeof value === "string" && value.trim() && value.length <= max;

  if (!body || body.schema_version !== 1 || !isoWeek.test(body.report_id || "") ||
      !text(body.generated_at, 60) || isNaN(new Date(body.generated_at)) ||
      !body.period || !isoDate.test(body.period.start || "") || !isoDate.test(body.period.end || "") ||
      !text(body.period.label, 100) || body.period.timezone !== "Asia/Jakarta" ||
      !text(body.objective) || !Array.isArray(body.slides) || body.slides.length < 3 || body.slides.length > 10 ||
      !body.report || !text(body.report.status, 200) || !text(body.report.summary)) return false;

  if (body.slides.some((slide) => !slide || !text(slide.eyebrow, 120) || !text(slide.title, 500) ||
      !text(slide.body, 2000) || !text(slide.metric, 100) || !text(slide.metric_label, 150) || !tones.has(slide.tone))) return false;
  const evidence = body.report.evidence;
  if (!Array.isArray(evidence) || !evidence.length || evidence.length > 100) return false;
  const ids = new Set();
  for (const item of evidence) {
    if (!item || !text(item.id, 100) || ids.has(item.id) || !text(item.source, 100) || !text(item.ref, 500) ||
        !text(item.observation, 4000) || item.sensitivity !== "sanitized") return false;
    ids.add(item.id);
  }
  const validRefs = (refs) => Array.isArray(refs) && refs.length > 0 && refs.length <= 20 && refs.every((ref) => ids.has(ref));
  if (!Array.isArray(body.report.commitments) || body.report.commitments.length > 20 ||
      body.report.commitments.some((item) => !item || !text(item.outcome, 1000) ||
        !commitmentStatus.has(item.status) || !validRefs(item.evidence_refs))) return false;
  if (!Array.isArray(body.report.claims) || body.report.claims.length > 30 ||
      body.report.claims.some((item) => !item || !text(item.title, 1000) || !text(item.impact, 3000) ||
        !kinds.has(item.kind) || !confidence.has(item.confidence) || !validRefs(item.evidence_refs) ||
        (item.kind === "inference" && !text(item.corrective_action, 3000)))) return false;
  if (!Array.isArray(body.report.scorecard) || !body.report.scorecard.length || body.report.scorecard.length > 20 ||
      body.report.scorecard.some((item) => !item || !text(item.dimension, 200) || !confidence.has(item.confidence) ||
        (item.score === null ? item.confidence !== "insufficient" :
          (!Number.isInteger(item.score) || item.score < 1 || item.score > 5)))) return false;
  const next = body.report.next_week;
  if (!next || !Array.isArray(next.outcomes) || next.outcomes.length > 3 ||
      next.outcomes.some((item) => !text(item, 1500)) || !text(next.stop, 1500) ||
      !text(next.blocker, 1500) || !text(next.success_definition, 2000)) return false;
  return JSON.stringify(body).length <= 256 * 1024;
}

function weeklyCorrectionBlocked(note) {
  const text = typeof note === "string" ? note : "";
  return /https?:\/\//i.test(text)
    || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)
    || /\b(?:ghp_|github_pat_|gho_|sk-|xox[baprs]-)[A-Za-z0-9_-]+/i.test(text)
    || /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(text);
}

function validateWeeklyWrappedCorrection(body) {
  const isoWeek = /^\d{4}-W\d{2}$/;
  const verdicts = new Set(["looks_right", "wrong", "missed"]);
  if (!body || body.schema_version !== 1 || !isoWeek.test(body.report_id || "") ||
      typeof body.generated_at !== "string" || !body.generated_at.trim() || isNaN(new Date(body.generated_at)) ||
      !verdicts.has(body.verdict) || typeof body.note !== "string" || body.note.length > 500 ||
      weeklyCorrectionBlocked(body.note)) return false;
  const note = body.note.trim();
  if (body.verdict === "missed" && !note) return false;
  return true;
}

function normalizeWeeklyWrappedCorrection(body) {
  const note = body.verdict === "looks_right" ? "" : body.note.trim();
  return {
    schema_version: 1,
    report_id: body.report_id,
    generated_at: body.generated_at,
    verdict: body.verdict,
    note,
    idempotency_key: [body.report_id, body.generated_at, body.verdict, note].join("|"),
  };
}

const STATE_V2_KINDS = new Set(["tasks", "routines", "sprints", "jira_overrides"]);
function stateV2Valid(kind, data) {
  if (kind === "tasks") return Array.isArray(data);
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  if (kind === "routines") {
    return Array.isArray(data.routines) && !!data.routineDay &&
      typeof data.routineDay === "object" && !Array.isArray(data.routineDay);
  }
  if (kind === "sprints") return Array.isArray(data.list);
  if (kind === "jira_overrides") {
    return !!data.depOverrides && typeof data.depOverrides === "object" &&
      !Array.isArray(data.depOverrides);
  }
  return false;
}
function dokumenV2(row) {
  return {
    kind: row.kind,
    schemaVersion: row.schema_version,
    revision: row.revision,
    data: JSON.parse(row.blob),
  };
}
function worklogV2(row) {
  return {
    id: row.id,
    taskId: row.task_id || null,
    occurredAt: row.occurred_at,
    localDate: row.local_date,
    text: row.text,
    priority: row.priority || null,
    minutes: row.minutes,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    deletedAt: row.deleted_at || null,
  };
}

async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function wrappedStable(value) {
  if (Array.isArray(value)) return value.map(wrappedStable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, wrappedStable(value[key])]));
}
async function wrappedEtag(report) {
  return '"sha256:' + await sha256hex(JSON.stringify(wrappedStable(report))) + '"';
}
function kodeAcak() {
  return [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Pemilik kode akses di header X-Catet-Key, atau null.
async function userDariKode(env, request) {
  if (!env.CATET_DB) return null;
  const kode = (request.headers.get("X-Catet-Key") || "").trim();
  if (!kode) return null;
  return await d1q(env,
    "SELECT id, name, jira_site, jira_email, jira_token, cal_ics_url FROM users WHERE token_hash = ?1",
    [await sha256hex(kode)], "first");
}

/* ---------- iCalendar (Google Calendar "secret iCal URL") ---------- */
// Validasi URL iCal Google — hanya host calendar.google.com & path /ical/…ics
// (mencegah proxy dipakai fetch alamat sembarang/SSRF). → URL bersih | null.
function gcalUrlOk(raw) {
  let u; try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== "https:") return null;
  if (u.hostname !== "calendar.google.com") return null;
  if (!u.pathname.startsWith("/calendar/ical/") || !u.pathname.endsWith(".ics")) return null;
  return u.toString();
}
// Buang line-folding RFC5545 (baris lanjutan diawali spasi/tab).
function unfoldICS(t) { return t.replace(/\r?\n[ \t]/g, ""); }
// Pisah properti "NAME;PARAM=VAL:VALUE" → {name, params, value}.
function parseProp(line) {
  const c = line.indexOf(":");
  if (c < 0) return null;
  const kiri = line.slice(0, c), value = line.slice(c + 1);
  const bagian = kiri.split(";");
  const name = bagian[0].toUpperCase();
  const params = {};
  for (const b of bagian.slice(1)) {
    const eq = b.indexOf("=");
    if (eq > 0) params[b.slice(0, eq).toUpperCase()] = b.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name, params, value };
}
function unescapeText(s) {
  return s.replace(/\\n/gi, " ").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\").trim();
}
function urlsFromText(raw) {
  const text = String(raw || "");
  const found = [];
  const re = /https?:\/\/[^\s<>"'\\]+/gi;
  let match;
  while ((match = re.exec(text))) {
    let url = match[0].replace(/[),.;]+$/g, "");
    try {
      const parsed = new URL(url);
      if (parsed.hostname === "www.google.com" && parsed.pathname === "/url" && parsed.searchParams.get("q")) {
        url = parsed.searchParams.get("q");
      }
      if (!/^https?:$/i.test(new URL(url).protocol)) continue;
    } catch { continue; }
    if (!found.includes(url)) found.push(url);
    if (found.length >= 4) break;
  }
  return found;
}
// Wall-clock (di zona tz) → instant UTC. Koreksi offset sekali; zona tanpa DST
// (mis. Asia/Jakarta) selalu tepat.
function wallToUTC(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  try {
    const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const p = {}; for (const x of dtf.formatToParts(new Date(guess))) p[x.type] = x.value;
    const asIf = Date.UTC(+p.year, +p.month - 1, +p.day, p.hour === "24" ? 0 : +p.hour, +p.minute, +p.second);
    return new Date(guess - (asIf - guess));
  } catch { return new Date(guess); }
}
// Parse nilai DTSTART/DTEND. tzFallback dipakai untuk waktu "mengambang".
// → { allDay, date:"YYYY-MM-DD", instant:Date, wall:{y,mo,d,h,mi,s} }
function parseDT(prop, tzFallback) {
  const v = prop.value.trim();
  if (prop.params.VALUE === "DATE" || /^\d{8}$/.test(v)) {
    const y = +v.slice(0, 4), mo = +v.slice(4, 6), d = +v.slice(6, 8);
    return { allDay: true, date: v.slice(0, 4) + "-" + v.slice(4, 6) + "-" + v.slice(6, 8),
      instant: new Date(Date.UTC(y, mo - 1, d)), wall: { y, mo, d, h: 0, mi: 0, s: 0 } };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  const [, ys, mos, ds, hs, mis, ss, z] = m;
  const wall = { y: +ys, mo: +mos, d: +ds, h: +hs, mi: +mis, s: +ss };
  let instant;
  if (z) instant = new Date(Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s));
  else instant = wallToUTC(wall.y, wall.mo, wall.d, wall.h, wall.mi, wall.s, prop.params.TZID || tzFallback);
  return { allDay: false, date: null, instant, wall };
}
function ymd(dt) { return dt.getUTCFullYear() * 10000 + (dt.getUTCMonth() + 1) * 100 + dt.getUTCDate(); }
// Perluas satu VEVENT (termasuk RRULE sederhana) ke daftar occurrence dalam
// [winA, winB]. Menangani FREQ DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT,
// UNTIL, BYDAY (WEEKLY), dan EXDATE. Cukup untuk meeting rutin lazim.
const HARI_KODE = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
function expandEvent(ev, winA, winB, tz) {
  const durMs = ev.end && ev.start ? (ev.end.instant - ev.start.instant) : 0;
  const buat = (inst, wall) => ({
    // UID + occurrence start menjaga import worklog idempotent untuk recurring
    // event. Event dari kalender lama tanpa UID tetap memakai fallback client.
    id: ev.uid ? ev.uid + "|" + inst.toISOString() : undefined,
    summary: ev.summary, location: ev.location, allDay: ev.start.allDay,
    start: inst.toISOString(), date: ev.start.allDay ? isoDate(wall) : null,
    end: new Date(inst.getTime() + durMs).toISOString(),
    urls: urlsFromText(ev.description || ""),
  });
  const isoDate = (w) => String(w.y).padStart(4, "0") + "-" + String(w.mo).padStart(2, "0") + "-" + String(w.d).padStart(2, "0");
  const dalam = (inst) => inst >= winA && inst <= winB;
  if (!ev.rrule) {
    return dalam(ev.start.instant) ? [buat(ev.start.instant, ev.start.wall)] : [];
  }
  const R = {}; for (const kv of ev.rrule.split(";")) { const [k, v] = kv.split("="); if (k) R[k.toUpperCase()] = v; }
  const freq = R.FREQ, interval = Math.max(1, +R.INTERVAL || 1);
  const count = R.COUNT ? +R.COUNT : Infinity;
  const until = R.UNTIL ? parseDT({ value: R.UNTIL, params: {} }, tz).instant : null;
  const byday = R.BYDAY ? R.BYDAY.split(",").map((x) => HARI_KODE[x.slice(-2).toUpperCase()]).filter((x) => x != null) : null;
  const exdate = new Set(ev.exdate.map((s) => s.slice(0, 8)));
  const out = []; const w0 = ev.start.wall; let n = 0, dibuat = 0;
  const maxIter = 1000;
  for (let i = 0; i < maxIter && dibuat < count; i++) {
    // tanggal dasar untuk langkah ke-i
    let dates = [];
    if (freq === "WEEKLY" && byday) {
      const base = new Date(Date.UTC(w0.y, w0.mo - 1, w0.d));
      const senin = new Date(base); senin.setUTCDate(base.getUTCDate() - ((base.getUTCDay() + 6) % 7)); // awal minggu (Senin)
      senin.setUTCDate(senin.getUTCDate() + i * interval * 7);
      for (const wd of byday) {
        const dd = new Date(senin); dd.setUTCDate(senin.getUTCDate() + ((wd + 6) % 7));
        dates.push({ y: dd.getUTCFullYear(), mo: dd.getUTCMonth() + 1, d: dd.getUTCDate() });
      }
    } else {
      const base = new Date(Date.UTC(w0.y, w0.mo - 1, w0.d));
      if (freq === "DAILY") base.setUTCDate(base.getUTCDate() + i * interval);
      else if (freq === "WEEKLY") base.setUTCDate(base.getUTCDate() + i * interval * 7);
      else if (freq === "MONTHLY") base.setUTCMonth(base.getUTCMonth() + i * interval);
      else if (freq === "YEARLY") base.setUTCFullYear(base.getUTCFullYear() + i * interval);
      else if (i > 0) break; // FREQ tak dikenal → anggap sekali saja
      dates.push({ y: base.getUTCFullYear(), mo: base.getUTCMonth() + 1, d: base.getUTCDate() });
    }
    for (const dt of dates) {
      if (dibuat >= count) break;
      const key = String(dt.y).padStart(4, "0") + String(dt.mo).padStart(2, "0") + String(dt.d).padStart(2, "0");
      const inst = ev.start.allDay
        ? new Date(Date.UTC(dt.y, dt.mo - 1, dt.d))
        : wallToUTC(dt.y, dt.mo, dt.d, w0.h, w0.mi, w0.s, ev.tzid || tz);
      if (until && inst > until) { i = maxIter; break; }
      dibuat++;
      if (exdate.has(key)) continue;
      if (dalam(inst)) out.push(buat(inst, { ...w0, y: dt.y, mo: dt.mo, d: dt.d }));
    }
    // berhenti kalau sudah jauh melewati jendela
    const cek = new Date(Date.UTC(w0.y, w0.mo - 1, w0.d));
    cek.setUTCDate(cek.getUTCDate() + i * interval * (freq === "WEEKLY" ? 7 : 1));
    if (cek > winB && freq !== "MONTHLY" && freq !== "YEARLY") break;
    if ((freq === "MONTHLY" || freq === "YEARLY") && new Date(Date.UTC(w0.y + (freq === "YEARLY" ? i : 0), w0.mo - 1 + (freq === "MONTHLY" ? i : 0), w0.d)) > winB) break;
  }
  return out;
}
// Parse ICS penuh → daftar occurrence dalam [from,to] (tanggal lokal tz).
function acaraDalamJendela(icsText, from, to, tz) {
  const lines = unfoldICS(icsText).split(/\r?\n/);
  const winA = wallToUTC(+from.slice(0, 4), +from.slice(5, 7), +from.slice(8, 10), 0, 0, 0, tz);
  const winB = wallToUTC(+to.slice(0, 4), +to.slice(5, 7), +to.slice(8, 10), 23, 59, 59, tz);
  const winApad = new Date(winA.getTime() - 2 * 86400000); // margin utk all-day/timezone
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = { exdate: [], summary: "", location: "", description: "" }; continue; }
    if (line === "END:VEVENT") {
      if (cur && cur.start && cur.status !== "CANCELLED") events.push(cur);
      cur = null; continue;
    }
    if (!cur) continue;
    const p = parseProp(line); if (!p) continue;
    if (p.name === "UID") cur.uid = unescapeText(p.value).slice(0, 300);
    else if (p.name === "DTSTART") { cur.start = parseDT(p, tz); cur.tzid = p.params.TZID || null; }
    else if (p.name === "DTEND") cur.end = parseDT(p, tz);
    else if (p.name === "SUMMARY") cur.summary = unescapeText(p.value).slice(0, 200);
    else if (p.name === "LOCATION") cur.location = unescapeText(p.value).slice(0, 200);
    else if (p.name === "DESCRIPTION") cur.description = unescapeText(p.value).slice(0, 4000);
    else if (p.name === "RRULE") cur.rrule = p.value.trim();
    else if (p.name === "EXDATE") cur.exdate.push(...p.value.split(",").map((s) => s.trim()));
    else if (p.name === "STATUS") cur.status = p.value.trim().toUpperCase();
  }
  const out = [];
  for (const ev of events) {
    if (!ev.rrule && ev.start.instant < winApad) continue;
    for (const oc of expandEvent(ev, winA, winB, tz)) out.push(oc);
    if (out.length > 500) break;
  }
  out.sort((a, b) => a.start.localeCompare(b.start));
  return out;
}

// Test case QAlity adalah issue Jira biasa (tipe "QAlity Test") yang di-link
// ke tiketnya. Ia bukan pekerjaan inbox, bukan tiket QA/dev untuk pairing,
// dan bukan dependensi yang harus Done sebelum tiket QA siap dites.
function isQalityType(name) {
  return typeof name === "string" && /^qality(?:\s+test)?$/i.test(name.trim());
}
function isQalityLink(link) {
  const other = link && (link.outwardIssue || link.inwardIssue);
  const type = other && other.fields && other.fields.issuetype;
  return isQalityType(link && link.type && link.type.name) || isQalityType(type && type.name);
}

function descriptionMentionsKey(desc, key) {
  if (!desc || !key) return false;
  const raw = typeof desc === "string" ? desc : JSON.stringify(desc);
  if (raw.includes("/browse/" + key)) return true;
  try {
    return new RegExp("\\b" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(raw);
  } catch {
    return raw.includes(key);
  }
}

function asAdfDoc(desc) {
  if (!desc) return { type: "doc", version: 1, content: [] };
  if (typeof desc === "string") {
    const text = desc.trim();
    return {
      type: "doc",
      version: 1,
      content: text ? [{ type: "paragraph", content: [{ type: "text", text }] }] : [],
    };
  }
  if (desc && desc.type === "doc") {
    return {
      type: "doc",
      version: desc.version || 1,
      content: Array.isArray(desc.content) ? desc.content.slice() : [],
    };
  }
  return { type: "doc", version: 1, content: [] };
}

function withDevChip(desc, site, devKey) {
  const doc = asAdfDoc(desc);
  const url = String(site || "").replace(/\/+$/, "") + "/browse/" + devKey;
  doc.content.push({
    type: "paragraph",
    content: [{ type: "inlineCard", attrs: { url } }],
  });
  return doc;
}

/* ---------- test case QAlity (token, dry run, push di balik flag) ----------
   Host QAlity tetap — tidak bisa diatur klien. Validasi hard di sini setara
   validateTestCases di assets/js/testcases.js: Worker otoritatif, browser
   hanya UX. Warning standar penulisan cukup di browser. Push/relink hanya
   ada bila env.TESTCASE_PUSH_ENABLED === "on"; selain itu 404. */
const QALITY_API = "https://apps-qalityplus.soldevelo.com/api";
const TC_MAX_BATCH = 20;
const TC_TITLE_MAX = 255;
const TC_TEKS_MAX = 5000; // batas keamanan per butir, bukan aturan standar
const TC_BUTIR_MAX = 30;
const TC_STATUS_DIBUAT = ["created_linked", "created_unlinked", "link_unverified"];
// Baris 'pending' = case sedang/pernah di-import tapi hasilnya belum tercatat.
// Lewat batas ini dianggap terputus: push berikutnya mencari dulu test case
// berjudul sama di Jira sebelum membuat ulang (supaya tidak kembar).
const TC_PENDING_BASI_MS = 10 * 60 * 1000;
const TC_LINK_TYPE = "QAlity Test";
const kunciJudulTc = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

// Body klien → case ter-normalisasi + error per case/batch, bentuknya sama
// dengan validateTestCases di browser ({ errors, cases: [{ errors }] }).
function validasiTestCases(raw) {
  const res = { errors: [], cases: [], norm: [] };
  if (!Array.isArray(raw)) { res.errors.push("Field cases harus berupa daftar."); return res; }
  if (!raw.length) res.errors.push("Belum ada case yang dipilih.");
  if (raw.length > TC_MAX_BATCH) res.errors.push("Batch berisi " + raw.length + " case; maksimal " + TC_MAX_BATCH + " per push.");
  if (res.errors.length) return res;
  const kembar = new Map();
  for (const c of raw) {
    const k = kunciJudulTc(c && typeof c.title === "string" ? c.title : "");
    if (k) kembar.set(k, (kembar.get(k) || 0) + 1);
  }
  for (const c of raw) {
    const errors = [];
    const obj = !!c && typeof c === "object" && !Array.isArray(c);
    if (!obj) errors.push("Case bukan objek { title, preconditions, steps, expected }.");
    else if (c.title != null && typeof c.title !== "string") errors.push("Title harus berupa teks.");
    const title = obj && typeof c.title === "string" ? c.title.replace(/\s+/g, " ").trim() : "";
    const daftar = (f) => {
      const v = obj ? c[f] : null;
      if (v == null) return [];
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) { errors.push("“" + f + "” harus berupa daftar teks."); return []; }
      return v.map((x) => x.trim()).filter(Boolean);
    };
    const pre = daftar("preconditions"), steps = daftar("steps"), expected = daftar("expected");
    if (!title) errors.push("Title kosong.");
    else {
      if ([...title].length > TC_TITLE_MAX) errors.push("Title lebih dari " + TC_TITLE_MAX + " karakter.");
      if (kembar.get(kunciJudulTc(title)) > 1) errors.push("Title duplikat dengan case lain di batch ini.");
      if (/^gap\s*:/i.test(title)) errors.push("Case GAP: menandai celah requirement, bukan test case.");
    }
    if (!steps.length) errors.push("Tidak ada Test Step.");
    if (!expected.length) errors.push("Tidak ada Expected Result.");
    if ([pre, steps, expected].some((l) => l.length > TC_BUTIR_MAX)) errors.push("Maksimal " + TC_BUTIR_MAX + " butir per bagian.");
    if ([...pre, ...steps, ...expected].some((t) => t.length > TC_TEKS_MAX)) errors.push("Ada butir lebih dari " + TC_TEKS_MAX + " karakter.");
    res.cases.push({ errors });
    res.norm.push({ title, preconditions: pre, steps, expected });
  }
  return res;
}

// Satu case → TestCaseImportBean QAlity (plan §4): precondition di data step 1,
// expected bernomor di result step terakhir. position 1-based: uji nyata
// 20 Okt (CD-5964, 3 step) → tersimpan 0..N-1 dengan urutan dan isi sama persis.
function petaQality(c) {
  const n = c.steps.length;
  return {
    name: c.title,
    testSteps: c.steps.map((step, i) => ({
      step,
      data: i === 0 && c.preconditions.length ? "Precondition:\n" + c.preconditions.map((p) => "- " + p).join("\n") : "",
      result: i === n - 1 ? c.expected.map((e, j) => (j + 1) + ". " + e).join("\n") : "",
      position: i + 1,
    })),
    properties: {},
  };
}

// case_hash = identitas idempotency satu case per tiket; previewHash = isi
// batch yang sudah dilihat Zack di dry run (push Fase 3 wajib sama persis).
const tcCaseHash = (issueKey, c) => sha256hex(JSON.stringify(wrappedStable({ v: 1, issueKey, case: c })));
const tcPreviewHash = (issueKey, cases) => sha256hex(JSON.stringify(wrappedStable({ v: 1, issueKey, cases })));

// GET ke QAlity dengan token user. Body error QAlity tidak pernah diteruskan
// (bisa memantulkan header); hanya status + pesan buatan Worker.
async function qalityGet(path, token) {
  let r;
  try {
    r = await fetch(QALITY_API + path, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  } catch {
    return { error: "QAlity tidak bisa dihubungi. Coba lagi sebentar.", status: 502 };
  }
  if (r.status === 401 || r.status === 403) {
    return { error: "Token QAlity ditolak (HTTP " + r.status + ") — buat token baru di Jira → QAlity API Tokens, lalu simpan di Settings.", status: 400 };
  }
  if (r.status === 429) return { error: "QAlity sedang membatasi request (HTTP 429). Coba lagi sebentar.", status: 429 };
  if (!r.ok) return { error: "QAlity menolak (HTTP " + r.status + ").", status: 502 };
  try { return { data: await r.json() }; } catch { return { error: "Respons QAlity bukan JSON.", status: 502 }; }
}

// Tiket tujuan + test case QAlity yang sudah ter-link (tipe link apa pun).
// Hanya project/issuetype/issuelinks — description tiket tidak dibaca.
async function bacaTiketTestCase(site, authHeaders, key) {
  const r = await fetch(site + "/rest/api/3/issue/" + encodeURIComponent(key) + "?fields=project,issuetype,issuelinks",
    { headers: authHeaders });
  if (r.status === 404) return { error: "Tiket " + key + " tidak ditemukan atau tidak bisa dibaca dengan akun Jira-mu.", status: 404 };
  if (!r.ok) return { error: "Jira menolak membaca " + key + " (HTTP " + r.status + ").", status: 502 };
  const issue = await r.json();
  const f = issue.fields || {};
  const existing = new Map();
  for (const l of f.issuelinks || []) {
    const lain = l.inwardIssue || l.outwardIssue;
    const lf = (lain && lain.fields) || {};
    if (!lain || !lain.key || existing.has(lain.key) || !isQalityType(lf.issuetype && lf.issuetype.name)) continue;
    existing.set(lain.key, { key: lain.key, summary: lf.summary || "", status: (lf.status && lf.status.name) || null,
      linkType: (l.type && l.type.name) || "" });
  }
  return {
    key: issue.key || key,
    projectKey: (f.project && f.project.key) || "",
    projectId: f.project && f.project.id != null ? String(f.project.id) : "",
    issueType: (f.issuetype && f.issuetype.name) || "",
    existing: [...existing.values()],
  };
}

// Baca beberapa issue sekaligus (satu subrequest) → Map key → fields; null bila gagal.
async function bacaIssues(site, authHeaders, keys, fields) {
  try {
    const r = await fetch(site + "/rest/api/3/issue/bulkfetch", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ issueIdsOrKeys: keys, fields }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return new Map((d.issues || []).map((i) => [i.key, i.fields || {}]));
  } catch { return null; }
}

// Link "QAlity Test" (payload terverifikasi spike Fase 0): test case = inward,
// tiket = outward. Dibaca balik: di test case outwardIssue = tiket, di tiket
// inwardIssue = test case.
const tcLinkKeTiket = (links, ticketKey) => (links || []).some((l) =>
  l && l.type && l.type.name === TC_LINK_TYPE && l.outwardIssue && l.outwardIssue.key === ticketKey);
const tcLinkDariTest = (links, testKey) => (links || []).some((l) =>
  l && l.type && l.type.name === TC_LINK_TYPE && l.inwardIssue && l.inwardIssue.key === testKey);
async function buatLinkQality(site, authHeaders, testKey, ticketKey) {
  let r;
  try {
    r = await fetch(site + "/rest/api/3/issueLink", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ type: { name: TC_LINK_TYPE }, inwardIssue: { key: testKey }, outwardIssue: { key: ticketKey } }),
    });
  } catch { return "Jira tidak bisa dihubungi saat membuat link."; }
  return r.ok ? null : "Jira menolak link (HTTP " + r.status + ").";
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    // Pagar terluar: exception apa pun harus tetap balik lewat json() (yang
    // membawa header CORS). Tanpa ini, error mentah → 500 default Cloudflare
    // TANPA CORS → browser salah lapor sebagai "CORS error".
    try {
      return await tangani(request, env);
    } catch (e) {
      return json({ error: "Worker error: " + (e && e.message ? e.message : String(e)) }, 500);
    }
  },
};

async function tangani(request, env) {
    const url0 = new URL(request.url);

    // /admin/users — kelola kode akses (POST buat, GET daftar, DELETE hapus).
    // Dilindungi ADMIN_KEY sendiri & dipakai lewat curl (tanpa Origin), jadi
    // sengaja SEBELUM pagar originOk.
    if (url0.pathname === "/admin/users" || url0.pathname.startsWith("/admin/users/")) {
      if (!env.ADMIN_KEY) return json({ error: "Set secret ADMIN_KEY dulu (wrangler secret put ADMIN_KEY)." }, 500);
      if (request.headers.get("X-Admin-Key") !== env.ADMIN_KEY) return json({ error: "X-Admin-Key salah." }, 401);
      if (!env.CATET_DB) return json({ error: "Multi-user butuh D1 (lihat worker/README.md)." }, 500);
      if (request.method === "POST" && url0.pathname === "/admin/users") {
        let b; try { b = await request.json(); } catch { return json({ error: "Body harus JSON." }, 400); }
        const name = (b && typeof b.name === "string" ? b.name.trim() : "").slice(0, 60);
        if (!name) return json({ error: "Field name wajib." }, 400);
        const id = crypto.randomUUID();
        const code = kodeAcak();
        await d1q(env, "INSERT INTO users (id, name, token_hash, created_at) VALUES (?1, ?2, ?3, ?4)",
          [id, name, await sha256hex(code), new Date().toISOString()], "run");
        return json({ id, name, code }); // kode hanya ditampilkan sekali ini
      }
      if (request.method === "GET" && url0.pathname === "/admin/users") {
        const rs = await d1q(env,
          "SELECT id, name, created_at, jira_site, CASE WHEN jira_token IS NULL OR jira_token = '' THEN 0 ELSE 1 END AS punya_jira FROM users ORDER BY created_at",
          [], "all");
        return json({ users: (rs && rs.results) || [] });
      }
      if (request.method === "DELETE" && url0.pathname.startsWith("/admin/users/")) {
        const id = decodeURIComponent(url0.pathname.slice("/admin/users/".length));
        await d1q(env, "DELETE FROM states WHERE user_id = ?1", [id], "run");
        await d1q(env, "DELETE FROM qality_credentials WHERE user_id = ?1", [id], "run");
        await d1q(env, "DELETE FROM users WHERE id = ?1", [id], "run");
        return json({ ok: true });
      }
      return json({ error: "Rute admin tidak dikenal." }, 404);
    }

    if (!originOk(request.headers.get("Origin"), env)) {
      return json({ error: "Origin tidak diizinkan untuk mengakses proxy ini." }, 403);
    }

    // POST /signup — buat akun sendiri (self-service). Dijaga origin + passphrase
    // bersama SIGNUP_SECRET (owner bagikan sekali ke tim). Tanpa SIGNUP_SECRET,
    // pendaftaran mandiri tertutup — kode tetap dibuat admin lewat /admin/users.
    if (request.method === "POST" && url0.pathname === "/signup") {
      if (!env.CATET_DB) return json({ error: "Signup butuh D1 (lihat worker/README.md)." }, 500);
      if (!env.SIGNUP_SECRET) return json({ error: "Pendaftaran mandiri belum dibuka — minta kode ke admin." }, 403);
      let b; try { b = await request.json(); } catch { return json({ error: "Body harus JSON." }, 400); }
      if (String((b && b.secret) || "") !== env.SIGNUP_SECRET) return json({ error: "Signup passphrase salah." }, 401);
      const name = (b && typeof b.name === "string" ? b.name.trim() : "").slice(0, 60);
      if (!name) return json({ error: "Isi nama dulu." }, 400);
      const id = crypto.randomUUID();
      const code = kodeAcak();
      await d1q(env, "INSERT INTO users (id, name, token_hash, created_at) VALUES (?1, ?2, ?3, ?4)",
        [id, name, await sha256hex(code), new Date().toISOString()], "run");
      return json({ name, code }); // kode hanya ditampilkan sekali ini
    }

    // Identitas: kode akses → user. Semua endpoint data wajib kode valid,
    // tanpa pengecualian dan tanpa bergantung variabel Worker. Tidak ada user
    // "default" anonim: kode kosong/salah tidak pernah memakai secret global.
    // Service token tidak menggantikan kode — X-Catet-Key tetap memilih user.
    const user = await userDariKode(env, request);
    if (!user) {
      return json({ error: "Kode akses tidak valid atau belum diisi — Sign in di Settings → Account." }, 401);
    }
    const uid = user.id;
    const weeklyWrappedServiceOk = url0.pathname === "/weekly-wrapped" &&
      !!env.WEEKLY_WRAPPED_SERVICE_TOKEN &&
      request.headers.get("Authorization") === "Bearer " + env.WEEKLY_WRAPPED_SERVICE_TOKEN;

    // GET/PUT /v2/state/:kind — satu dokumen per domain dengan revision CAS.
    // Writer basi ditolak 409 agar satu perangkat tidak diam-diam menimpa yang lain.
    if (url0.pathname.startsWith("/v2/state/")) {
      if (!env.CATET_DB) return json({ error: "Schema v2 membutuhkan D1." }, 500);
      const kind = decodeURIComponent(url0.pathname.slice("/v2/state/".length));
      if (!STATE_V2_KINDS.has(kind)) return json({ error: "Jenis state v2 tidak dikenal." }, 404);
      if (request.method === "GET") {
        const row = await d1q(env,
          "SELECT kind, schema_version, revision, blob, updated_at FROM state_documents WHERE user_id = ?1 AND kind = ?2",
          [uid, kind], "first");
        return row ? json(dokumenV2(row)) : json({ kind, schemaVersion: 2, revision: 0, data: null });
      }
      if (request.method === "PUT") {
        let body; try { body = await request.json(); } catch { return json({ error: "Body harus JSON." }, 400); }
        if (!body || !Number.isInteger(body.schemaVersion) || body.schemaVersion < 2 ||
          !Number.isInteger(body.revision) || body.revision < 0 || !stateV2Valid(kind, body.data)) {
          return json({ error: "schemaVersion, revision, dan data tidak valid untuk jenis ini." }, 400);
        }
        const blob = JSON.stringify(body.data);
        if (blob.length > 256 * 1024) return json({ error: "Dokumen terlalu besar (maks 256 KB)." }, 413);
        const updatedAt = new Date().toISOString();
        if (body.revision === 0) {
          const result = await d1q(env,
            "INSERT INTO state_documents (user_id, kind, schema_version, revision, blob, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(user_id, kind) DO NOTHING",
            [uid, kind, body.schemaVersion, 1, blob, updatedAt], "run");
          if (jumlahPerubahan(result) === 1) {
            return json({ ok: true, kind, schemaVersion: body.schemaVersion, revision: 1 }, 201);
          }
        } else {
          const result = await d1q(env,
            "UPDATE state_documents SET blob = ?1, schema_version = ?2, revision = revision + 1, updated_at = ?3 WHERE user_id = ?4 AND kind = ?5 AND revision = ?6",
            [blob, body.schemaVersion, updatedAt, uid, kind, body.revision], "run");
          if (jumlahPerubahan(result) === 1) {
            return json({ ok: true, kind, schemaVersion: body.schemaVersion, revision: body.revision + 1 });
          }
        }
        const current = await d1q(env,
          "SELECT revision FROM state_documents WHERE user_id = ?1 AND kind = ?2", [uid, kind], "first");
        // revision > 0 pada row yang belum ada berarti kontrak client rusak,
        // bukan konflik dengan writer lain.
        if (!current) return json({ error: "Dokumen belum ada; buat dengan revision 0." }, 404);
        return json({ error: "State berubah di perangkat lain.", currentRevision: current ? current.revision : 0 }, 409);
      }
    }

    // GET/POST /v2/worklogs — histori append-only; duplicate id ditolak.
    if (url0.pathname === "/v2/worklogs") {
      if (!env.CATET_DB) return json({ error: "Schema v2 membutuhkan D1." }, 500);
      if (request.method === "GET") {
        const since = url0.searchParams.get("since") || "0000-01-01";
        const limit = Math.min(Math.max(parseInt(url0.searchParams.get("limit") || "200", 10) || 200, 1), 500);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) return json({ error: "Parameter since harus YYYY-MM-DD." }, 400);
        const rs = await d1q(env,
          "SELECT id, task_id, occurred_at, local_date, text, priority, minutes, metadata, deleted_at FROM worklog_entries WHERE user_id = ?1 AND local_date >= ?2 ORDER BY local_date DESC, occurred_at DESC LIMIT ?3",
          [uid, since, limit], "all");
        return json({ items: ((rs && rs.results) || []).map(worklogV2) });
      }
      if (request.method === "POST") {
        let body; try { body = await request.json(); } catch { return json({ error: "Body harus JSON." }, 400); }
        const occurred = body && typeof body.occurredAt === "string" ? new Date(body.occurredAt) : null;
        const localDateObj = body && /^\d{4}-\d{2}-\d{2}$/.test(body.localDate || "")
          ? new Date(body.localDate + "T00:00:00Z") : null;
        if (!body || typeof body.id !== "string" || !body.id.trim() || body.id.length > 100 ||
          typeof body.text !== "string" || !body.text.trim() || body.text.length > 5000 ||
          !occurred || isNaN(occurred) || !localDateObj || isNaN(localDateObj) ||
          localDateObj.toISOString().slice(0, 10) !== body.localDate ||
          !Number.isInteger(body.minutes) || body.minutes < 0 || body.minutes > 24 * 60) {
          return json({ error: "Format worklog tidak valid." }, 400);
        }
        let metadata = null;
        try { metadata = body.metadata == null ? null : JSON.stringify(body.metadata); }
        catch { return json({ error: "Metadata worklog harus bisa diserialisasi ke JSON." }, 400); }
        if (body.metadata != null && metadata === undefined) {
          return json({ error: "Metadata worklog harus berupa nilai JSON." }, 400);
        }
        if (metadata && metadata.length > 64 * 1024) return json({ error: "Metadata worklog terlalu besar." }, 413);
        const result = await d1q(env,
          "INSERT INTO worklog_entries (user_id, id, task_id, occurred_at, local_date, text, priority, minutes, metadata, deleted_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) ON CONFLICT(user_id, id) DO NOTHING",
          [uid, body.id.trim(), body.taskId || null, occurred.toISOString(), body.localDate,
            body.text.trim(), body.priority || null, body.minutes, metadata, null], "run");
        if (jumlahPerubahan(result) !== 1) return json({ error: "Worklog dengan id ini sudah ada." }, 409);
        return json({ ok: true, id: body.id.trim() }, 201);
      }
    }

    // Snapshot Weekly Wrapped dipisah dari state canonical CATET. Engine privat
    // hanya dapat menulis report tersanitasi dengan dedicated service token;
    // browser membaca report milik user melalui access code CATET yang sudah ada.
    if (url0.pathname === "/weekly-wrapped") {
      if (!env.CATET_DB) return json({ error: "Weekly Wrapped membutuhkan D1." }, 500);
      if (request.method === "GET") {
        if (!user) return json({ error: "Weekly Wrapped membutuhkan kode akses CATET valid." }, 401);
        const row = await d1q(env,
          "SELECT blob, updated_at FROM weekly_wrapped_reports WHERE user_id = ?1", [uid], "first");
        if (!row) return json({ report: null, updatedAt: null });
        const report = JSON.parse(row.blob);
        const etag = await wrappedEtag(report);
        report.updated_at = row.updated_at;
        const response = json(report);
        response.headers.set("ETag", etag);
        response.headers.set("Cache-Control", "no-store, no-transform");
        response.headers.set("Content-Encoding", "identity");
        response.headers.set("X-Wrapped-Publish-Protocol", "cas-v1");
        return response;
      }
      if (request.method === "PUT") {
        if (!weeklyWrappedServiceOk) return json({ error: "Weekly Wrapped write membutuhkan service token khusus." }, 401);
        let body;
        try { body = await request.json(); } catch { return json({ error: "Body harus JSON." }, 400); }
        if (!validateWeeklyWrappedReport(body)) return json({ error: "Format Weekly Wrapped tidak valid atau belum tersanitasi." }, 400);
        const raw = JSON.stringify(body);
        const updatedAt = new Date().toISOString();
        const match = request.headers.get("If-Match");
        let result;
        if (body.schema_version === 2 || match !== null) {
          if (!match) return json({ error: "Exact If-Match required." }, 428);
          const prior = await d1q(env,
            "SELECT blob, updated_at FROM weekly_wrapped_reports WHERE user_id = ?1", [uid], "first");
          // ponytail: v2 replaces an existing report only; initial publication needs a separate create protocol.
          if (!prior || match !== await wrappedEtag(JSON.parse(prior.blob))) return json({ error: "Report changed." }, 412);
          result = await d1q(env,
            "UPDATE weekly_wrapped_reports SET report_id = ?2, blob = ?3, updated_at = ?4 WHERE user_id = ?1 AND blob = ?5 AND updated_at = ?6",
            [uid, body.report_id, raw, updatedAt, prior.blob, prior.updated_at], "run");
        } else {
          const prior = await d1q(env,
            "SELECT blob, updated_at FROM weekly_wrapped_reports WHERE user_id = ?1", [uid], "first");
          if (prior && JSON.parse(prior.blob).schema_version === 2) return json({ error: "Exact If-Match required." }, 428);
          // Preserve v1 upsert, but atomically refuse downgrade if a v2 writer wins the race.
          result = await d1q(env,
            "INSERT INTO weekly_wrapped_reports (user_id, report_id, blob, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(user_id) DO UPDATE SET report_id = ?2, blob = ?3, updated_at = ?4 WHERE json_extract(weekly_wrapped_reports.blob, '$.schema_version') = 1",
            [uid, body.report_id, raw, updatedAt], "run");
        }
        if (result?.meta?.changes !== 1) return json({ error: "Report changed." }, 412);
        return json({ ok: true, reportId: body.report_id, updatedAt });
      }
      return json({ error: "Method tidak didukung." }, 405);
    }

    // Koreksi dipisah dari report immutable dan dari state canonical CATET.
    // Browser menulis record ringan milik user; service token privat tidak dipakai di sini.
    if (url0.pathname === "/weekly-wrapped/corrections") {
      if (!env.CATET_DB) return json({ error: "Weekly Wrapped membutuhkan D1." }, 500);
      if (!user) return json({ error: "Koreksi Weekly Wrapped membutuhkan kode akses CATET valid." }, 401);
      if (request.method === "GET") {
        const reportId = url0.searchParams.get("report_id") || "";
        if (!/^\d{4}-W\d{2}$/.test(reportId)) return json({ error: "report_id tidak valid." }, 400);
        const row = await d1q(env,
          "SELECT blob FROM weekly_wrapped_corrections WHERE user_id = ?1 AND report_id = ?2",
          [uid, reportId], "first");
        return json({ correction: row ? JSON.parse(row.blob) : null });
      }
      if (request.method === "POST") {
        let body;
        try { body = await request.json(); } catch { return json({ error: "Body harus JSON." }, 400); }
        if (!validateWeeklyWrappedCorrection(body)) {
          return json({ error: "Format koreksi tidak valid atau berisi data yang tidak boleh disimpan." }, 400);
        }
        const reportRow = await d1q(env,
          "SELECT report_id, blob FROM weekly_wrapped_reports WHERE user_id = ?1", [uid], "first");
        if (!reportRow || reportRow.report_id !== body.report_id) {
          return json({ error: "Report untuk periode ini tidak ditemukan." }, 404);
        }
        const stored = JSON.parse(reportRow.blob);
        if (stored.generated_at !== body.generated_at) {
          return json({ error: "Correction harus menunjuk snapshot report yang sedang ditampilkan." }, 409);
        }
        const normalized = normalizeWeeklyWrappedCorrection(body);
        const existing = await d1q(env,
          "SELECT blob, idempotency_key FROM weekly_wrapped_corrections WHERE user_id = ?1 AND report_id = ?2",
          [uid, normalized.report_id], "first");
        if (existing && existing.idempotency_key === normalized.idempotency_key) {
          return json(JSON.parse(existing.blob));
        }
        const previous = existing ? JSON.parse(existing.blob) : null;
        const now = new Date().toISOString();
        const record = {
          ...normalized,
          correction_id: previous && previous.correction_id ? previous.correction_id : ("corr-" + normalized.report_id),
          revision: previous ? Number(previous.revision || 1) + 1 : 1,
          saved_at: now,
          source: "live",
        };
        await d1q(env,
          "INSERT INTO weekly_wrapped_corrections (user_id, report_id, correction_id, blob, idempotency_key, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(user_id, report_id) DO UPDATE SET correction_id = ?3, blob = ?4, idempotency_key = ?5, updated_at = ?6",
          [uid, record.report_id, record.correction_id, JSON.stringify(record), record.idempotency_key, now], "run");
        return json(record);
      }
      return json({ error: "Method tidak didukung." }, 405);
    }

    // Snapshot prioritas dipisah dari blob state agar scheduler tidak pernah
    // menimpa edit browser. PUT hanya untuk user berkode atau service token.
    if (url0.pathname === "/priority-snapshot") {
      if (!env.CATET_DB) return json({ error: "Priority snapshot membutuhkan D1." }, 500);
      if (request.method === "GET") {
        const row = await d1q(env, "SELECT blob FROM priority_snapshots WHERE user_id = ?1", [uid], "first");
        return json(row ? JSON.parse(row.blob) : { date: null, items: [] });
      }
      if (request.method === "PUT") {
        let body;
        try { body = await request.json(); } catch { return json({ error: "Body harus JSON." }, 400); }
        const dateObj = body && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? new Date(body.date + "T00:00:00Z") : null;
        if (!body || !dateObj || isNaN(dateObj) || dateObj.toISOString().slice(0, 10) !== body.date ||
          typeof body.generatedAt !== "string" || isNaN(new Date(body.generatedAt)) ||
          !Number.isInteger(body.active) || body.active < 0 ||
          !Number.isInteger(body.today) || body.today < 0 || body.today > body.active ||
          !Array.isArray(body.items) || body.items.length > 5 ||
          body.items.some((item, i) => !item || typeof item.taskId !== "string" ||
            typeof item.text !== "string" || !Number.isInteger(item.score) || item.score < 1 || item.score > 10 ||
            item.rank !== i + 1)) {
          return json({ error: "Format snapshot tidak valid." }, 400);
        }
        const raw = JSON.stringify(body);
        if (raw.length > 128 * 1024) return json({ error: "Snapshot terlalu besar (maks 128 KB)." }, 413);
        const updatedAt = new Date().toISOString();
        await d1q(env,
          "INSERT INTO priority_snapshots (user_id, blob, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(user_id) DO UPDATE SET blob = ?2, updated_at = ?3",
          [uid, raw, updatedAt], "run");
        return json({ ok: true, updatedAt });
      }
    }

    // Snapshot PR merge terkait tiket QA. Dipisah dari blob state agar poller
    // VPS tidak pernah menimpa edit browser. Writer memakai service token yang
    // sama dengan priority snapshot; pembaca tetap wajib akun/service token.
    if (url0.pathname === "/pr-merge-snapshot") {
      if (!env.CATET_DB) return json({ error: "PR merge snapshot membutuhkan D1." }, 500);
      if (request.method === "GET") {
        const row = await d1q(env, "SELECT blob FROM pr_merge_snapshots WHERE user_id = ?1", [uid], "first");
        return json(row ? JSON.parse(row.blob) : { generatedAt: null, items: [] });
      }
      if (request.method === "PUT") {
        let body;
        try { body = await request.json(); } catch { return json({ error: "Body harus JSON." }, 400); }
        const validKey = (value) => typeof value === "string" && /^[A-Z][A-Z0-9]{1,9}-\d+$/.test(value);
        const validUrl = (value, host) => {
          if (typeof value !== "string" || value.length > 1000) return false;
          try { const u = new URL(value); return u.protocol === "https:" && u.hostname === host; }
          catch { return false; }
        };
        const invalidItem = (item) => !item || !validKey(item.qaKey) || !validKey(item.devKey) ||
          typeof item.qaSummary !== "string" || item.qaSummary.length > 500 ||
          typeof item.qaStatus !== "string" || item.qaStatus.length > 100 ||
          typeof item.devSummary !== "string" || item.devSummary.length > 500 ||
          typeof item.prId !== "string" || !/^\d+$/.test(item.prId) ||
          typeof item.prName !== "string" || item.prName.length > 500 ||
          !validUrl(item.prUrl, "bitbucket.org") || item.status !== "MERGED" ||
          typeof item.mergedAt !== "string" || isNaN(new Date(item.mergedAt));
        if (!body || typeof body.generatedAt !== "string" || isNaN(new Date(body.generatedAt)) ||
          !Array.isArray(body.items) || body.items.length > 500 || body.items.some(invalidItem)) {
          return json({ error: "Format PR merge snapshot tidak valid." }, 400);
        }
        const raw = JSON.stringify(body);
        if (raw.length > 512 * 1024) return json({ error: "PR merge snapshot terlalu besar (maks 512 KB)." }, 413);
        const updatedAt = new Date().toISOString();
        await d1q(env,
          "INSERT INTO pr_merge_snapshots (user_id, blob, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(user_id) DO UPDATE SET blob = ?2, updated_at = ?3",
          [uid, raw, updatedAt], "run");
        return json({ ok: true, updatedAt });
      }
    }

    if (url0.pathname === "/pr-merge-snapshot/ack" && request.method === "POST") {
      if (!user || !env.CATET_DB) return json({ error: "Acknowledge membutuhkan kode akses CATET valid." }, 401);
      let body;
      try { body = await request.json(); } catch { return json({ error: "Body harus JSON." }, 400); }
      const eventKey = typeof body.eventKey === "string" ? body.eventKey : "";
      if (!/^[A-Z][A-Z0-9]{1,9}-\d+\|[A-Z][A-Z0-9]{1,9}-\d+\|\d+$/.test(eventKey)) {
        return json({ error: "Event PR merge tidak valid." }, 400);
      }
      const row = await d1q(env, "SELECT blob FROM pr_merge_snapshots WHERE user_id = ?1", [uid], "first");
      if (!row) return json({ error: "Snapshot PR merge belum tersedia." }, 404);
      let snapshot;
      try { snapshot = JSON.parse(row.blob); } catch { return json({ error: "Snapshot PR merge rusak." }, 500); }
      snapshot.items = (Array.isArray(snapshot.items) ? snapshot.items : [])
        .filter((item) => `${item.qaKey}|${item.devKey}|${item.prId}` !== eventKey);

      const updatedAt = new Date().toISOString();
      snapshot.generatedAt = updatedAt;
      await d1q(env,
        "UPDATE pr_merge_snapshots SET blob = ?2, updated_at = ?3 WHERE user_id = ?1",
        [uid, JSON.stringify(snapshot), updatedAt], "run");
      return json({ ok: true, acknowledged: eventKey, pending: snapshot.items.length });
    }

    // GET /me · POST /me/jira · POST /me/calendar · POST /me/qality — profil &
    // kredensial user. Token (Jira/QAlity) tidak pernah dikembalikan.
    if (url0.pathname.startsWith("/me")) {
      if (!user) return json({ error: "Butuh kode akses (tab Jira → Access)." }, 401);
      if (request.method === "GET" && url0.pathname === "/me") {
        const q = await d1q(env, "SELECT expires_at FROM qality_credentials WHERE user_id = ?1", [user.id], "first");
        return json({ name: user.name, jira_site: user.jira_site || "",
          jira_email: user.jira_email || "", jira_tersimpan: !!user.jira_token,
          cal_tersimpan: !!user.cal_ics_url,
          qality_tersimpan: !!q, qality_expires_at: (q && q.expires_at) || null });
      }
      if (request.method === "POST" && url0.pathname === "/me/qality") {
        let b; try { b = await request.json(); } catch { return json({ error: "Body harus JSON." }, 400); }
        if (!b || typeof b.token !== "string") return json({ error: "Field token wajib (\"\" = hapus)." }, 400);
        const token = b.token.trim();
        if (!token) {
          await d1q(env, "DELETE FROM qality_credentials WHERE user_id = ?1", [user.id], "run");
          return json({ ok: true, qality_tersimpan: false, qality_expires_at: null });
        }
        if (!/^[\x21-\x7e]{16,4096}$/.test(token)) {
          return json({ error: "Token QAlity tidak valid (tanpa spasi, minimal 16 karakter)." }, 400);
        }
        const exp = typeof b.expiresAt === "string" ? b.expiresAt.trim() : "";
        if (exp && !(/^\d{4}-\d{2}-\d{2}$/.test(exp) && Number.isFinite(Date.parse(exp)) &&
            new Date(exp).toISOString().slice(0, 10) === exp)) {
          return json({ error: "Tanggal kedaluwarsa harus YYYY-MM-DD." }, 400);
        }
        await d1q(env,
          "INSERT INTO qality_credentials (user_id, token, expires_at, updated_at) VALUES (?1, ?2, ?3, ?4) " +
          "ON CONFLICT(user_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at, updated_at = excluded.updated_at",
          [user.id, token, exp || null, new Date().toISOString()], "run");
        return json({ ok: true, qality_tersimpan: true, qality_expires_at: exp || null });
      }
      if (request.method === "POST" && url0.pathname === "/me/jira") {
        let b; try { b = await request.json(); } catch { return json({ error: "Body harus JSON." }, 400); }
        const s = (b && String(b.site || "")).trim().replace(/\/+$/, "");
        const email = (b && String(b.email || "")).trim();
        const token = (b && String(b.token || "")).trim();
        // hanya Jira Cloud — mencegah proxy dipakai fetch alamat sembarang
        if (!/^https:\/\/[a-z0-9-]+\.atlassian\.net$/.test(s)) {
          return json({ error: "Site harus https://<nama>.atlassian.net (Jira Cloud)." }, 400);
        }
        if (!email || !token) return json({ error: "Field email dan token wajib." }, 400);
        await d1q(env, "UPDATE users SET jira_site = ?2, jira_email = ?3, jira_token = ?4 WHERE id = ?1",
          [user.id, s, email, token], "run");
        return json({ ok: true });
      }
      if (request.method === "POST" && url0.pathname === "/me/calendar") {
        let b; try { b = await request.json(); } catch { return json({ error: "Body harus JSON." }, 400); }
        const raw = (b && String(b.url || "")).trim();
        const url = raw ? gcalUrlOk(raw) : ""; // "" = hapus; null = tidak valid
        if (raw && url === null) {
          return json({ error: "URL harus 'secret iCal URL' Google Calendar (calendar.google.com/.../basic.ics)." }, 400);
        }
        await d1q(env, "UPDATE users SET cal_ics_url = ?2 WHERE id = ?1", [user.id, url || null], "run");
        return json({ ok: true });
      }
      return json({ error: "Rute tidak dikenal." }, 404);
    }

    // GET /calendar?from=&to=&tz=&ics= — acara kalender dalam rentang tanggal.
    if (request.method === "GET" && url0.pathname === "/calendar") {
      // URL tersimpan di server (per akun) diutamakan; URL yang disimpan di
      // perangkat dikirim lewat ?ics=. Keduanya tetap divalidasi gcalUrlOk.
      const icsParam = url0.searchParams.get("ics");
      const icsParamOk = icsParam ? gcalUrlOk(icsParam) : null;
      if (icsParam && !icsParamOk) return json({ error: "URL iCal tidak valid (harus calendar.google.com/.../basic.ics)." }, 400);
      const icsUrl = user.cal_ics_url || icsParamOk;
      if (!icsUrl) return json({ error: "Kalender belum diisi (tab Jira → Access → Google Calendar)." }, 400);
      const from = url0.searchParams.get("from") || "";
      const to = url0.searchParams.get("to") || "";
      const tz = url0.searchParams.get("tz") || "UTC";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
        return json({ error: "from/to harus YYYY-MM-DD dan from ≤ to." }, 400);
      }
      if ((new Date(to) - new Date(from)) / 86400000 > 62) return json({ error: "Rentang maks 62 hari." }, 400);
      if (!gcalUrlOk(icsUrl)) return json({ error: "URL kalender tersimpan tidak valid." }, 400);
      const r = await fetch(icsUrl, { headers: { Accept: "text/calendar" } });
      if (!r.ok) return json({ error: "Google menolak (" + r.status + ") — URL iCal mungkin sudah diganti." }, 502);
      let text = await r.text();
      if (text.length > 4 * 1024 * 1024) text = text.slice(0, 4 * 1024 * 1024); // batasi kalender raksasa
      const events = acaraDalamJendela(text, from, to, tz);
      return json({ from, to, events });
    }

    // Kredensial Jira selalu milik user sendiri (D1). Secret JIRA_* global
    // tidak pernah dipakai: fallback ke sana membocorkan tiket/worklog pemilik.
    const jiraSiap = !!(user.jira_site && user.jira_email && user.jira_token);
    const url = new URL(request.url);
    if (!jiraSiap && url.pathname !== "/state") {
      return json({ error: "Kredensial Jira belum diisi — tab Jira → Access → Jira credentials." }, 400);
    }
    const site = (user.jira_site || "").trim().replace(/\/+$/, "");
    const authHeaders = {
      Authorization: "Basic " + btoa(user.jira_email + ":" + user.jira_token),
      Accept: "application/json",
    };

    // GET /missing-worklog — semua status; pisahkan dari inbox/sprint reconciliation.
    if (request.method === "GET" && url.pathname === "/missing-worklog") {
      const searchAll = async (jql, fields) => {
        const issues = [], keys = new Set(), tokens = new Set();
        let token = "";
        for (let pageNo = 0; pageNo < 100; pageNo++) {
          const params = new URLSearchParams({ jql, fields, maxResults: "100" });
          if (token) params.set("nextPageToken", token);
          const response = await fetch(site + "/rest/api/3/search/jql?" + params, { headers: authHeaders });
          if (!response.ok) throw new Error("Jira menolak pembacaan worklog (HTTP " + response.status + ").");
          const page = await response.json();
          if (!Array.isArray(page.issues)) throw new Error("Format pencarian Jira tidak valid.");
          for (const issue of page.issues) {
            if (!issue || typeof issue.key !== "string" || !/^[A-Z][A-Z0-9]{1,9}-\d+$/.test(issue.key) || keys.has(issue.key)) {
              throw new Error("Jira mengembalikan tiket invalid/duplikat; refresh kembali.");
            }
            keys.add(issue.key); issues.push(issue);
          }
          if (page.nextPageToken != null && typeof page.nextPageToken !== "string") throw new Error("Pagination Jira tidak valid.");
          token = page.nextPageToken || "";
          if (!token) {
            if (page.isLast === false) throw new Error("Halaman Jira belum lengkap.");
            return issues;
          }
          if (page.isLast === true || tokens.has(token)) throw new Error("Pagination Jira tidak valid.");
          tokens.add(token);
        }
        throw new Error("Terlalu banyak halaman Jira; hasil tidak ditampilkan sebagian.");
      };
      try {
        // ponytail: dua positive sets; tidak perlu 1 request worklog per tiket.
        const [assigned, worked] = await Promise.all([
          searchAll("assignee = currentUser() ORDER BY updated DESC", "summary,status,created,issuetype"),
          searchAll("assignee = currentUser() AND worklogAuthor = currentUser() ORDER BY updated DESC", "key"),
        ]);
        const assignedKeys = new Set(assigned.map(i => i.key));
        if (worked.some(i => !assignedKeys.has(i.key))) throw new Error("Assignment berubah saat membaca; refresh kembali.");
        const workedKeys = new Set(worked.map(i => i.key));
        let excludedQality = 0;
        const items = [];
        for (const issue of assigned) {
          if (workedKeys.has(issue.key)) continue;
          const f = issue.fields;
          if (!f || !f.issuetype || typeof f.issuetype.name !== "string" || typeof f.summary !== "string") {
            throw new Error("Metadata jenis tiket Jira belum lengkap.");
          }
          if (isQalityType(f.issuetype.name)) { excludedQality++; continue; }
          items.push({ key: issue.key, summary: f.summary, status: f.status && f.status.name || null,
            created: f.created || null, issueType: f.issuetype.name });
        }
        return json({ site, items, total: items.length, excludedQality, complete: true, checkedAt: new Date().toISOString() });
      } catch {
        return json({ error: "Gagal membaca daftar worklog lengkap dari Jira. Refresh kembali; hasil parsial tidak ditampilkan." }, 502);
      }
    }

    // POST /pairing-link — unggah SATU pasangan yang sudah dipilih user menjadi
    // native Jira issue link + chip tiket dev di description tiket QA.
    // Endpoint ini tidak pernah dipanggil matcher/sync. Idempoten: existing
    // link/chip dibaca sebelum write dan diverifikasi lagi sesudahnya.
    if (request.method === "POST" && url.pathname === "/pairing-link") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "Body harus JSON." }, 400); }
      const qaKey = body && body.qaKey;
      const devKey = body && body.devKey;
      const KEY = /^[A-Z][A-Z0-9]{1,9}-\d+$/;
      if (!KEY.test(qaKey || "") || !KEY.test(devKey || "") || qaKey === devKey) {
        return json({ error: "Format QA/dev key tidak valid." }, 400);
      }

      const sf = await sprintFieldId(site, authHeaders);
      if (!sf) return json({ error: "Field Sprint Jira tidak ditemukan; pairing dibatalkan." }, 502);
      const issueUrl = (key) => site + "/rest/api/3/issue/" + encodeURIComponent(key) +
        "?fields=" + encodeURIComponent("issuelinks,description," + sf);
      const bacaIssue = async (key) => {
        const r = await fetch(issueUrl(key), { headers: authHeaders });
        if (!r.ok) return { error: "Jira menolak tiket " + key + " (" + r.status + ").", status: r.status };
        return { issue: await r.json() };
      };
      const [qaRead, devRead] = await Promise.all([bacaIssue(qaKey), bacaIssue(devKey)]);
      if (qaRead.error || devRead.error) return json({ error: qaRead.error || devRead.error }, 502);
      const qa = qaRead.issue, dev = devRead.issue;
      const linksKe = (issue, otherKey) => (((issue || {}).fields || {}).issuelinks || []).some((l) => {
        const other = l.outwardIssue || l.inwardIssue;
        return other && other.key === otherKey;
      });
      const alreadyLinked = linksKe(qa, devKey) || linksKe(dev, qaKey);
      const alreadyMentioned = descriptionMentionsKey(((qa || {}).fields || {}).description, devKey);
      const hasil = (alreadyLinkedFlag, alreadyMentionedFlag, linkType) => ({
        ok: true, linked: true, alreadyLinked: alreadyLinkedFlag,
        mentioned: true, alreadyMentioned: alreadyMentionedFlag, verified: true,
        qaKey, devKey, linkType,
      });
      if (alreadyLinked && alreadyMentioned) return json(hasil(true, true, "existing"));

      const sprintAktif = (issue) => new Set(
        ((((issue || {}).fields || {})[sf] || [])
          .filter((s) => s && s.state === "active" && s.id != null)
          .map((s) => String(s.id)))
      );
      const qaSprints = sprintAktif(qa), devSprints = sprintAktif(dev);
      const sprintSama = [...qaSprints].some((id) => devSprints.has(id));
      if (!alreadyLinked && !sprintSama) {
        return json({ error: "Tiket QA dan dev tidak berada di active sprint yang sama." }, 409);
      }

      let linkType = alreadyLinked ? "existing" : "Relates";
      let latestQa = qa;
      if (!alreadyLinked) {
        // "Relates" dipilih karena simetris: CATET merekam pasangan, bukan
        // menyimpulkan arah block/depends yang bisa salah secara semantik.
        const typeR = await fetch(site + "/rest/api/3/issueLinkType", { headers: authHeaders });
        if (!typeR.ok) return json({ error: "Gagal membaca tipe issue link Jira (" + typeR.status + ")." }, 502);
        const types = (await typeR.json()).issueLinkTypes || [];
        const relate = types.find((t) => /^relates?$/i.test(t.name || "")) ||
          types.find((t) => /^relates?\s+to$/i.test(t.outward || "") && /^relates?\s+to$/i.test(t.inward || ""));
        if (!relate || !relate.id) return json({ error: "Tipe issue link Relates tidak tersedia di Jira." }, 409);

        const linkR = await fetch(site + "/rest/api/3/issueLink", {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({
            type: { id: String(relate.id) },
            outwardIssue: { key: qaKey },
            inwardIssue: { key: devKey },
          }),
        });
        if (!linkR.ok) return json({ error: "Jira menolak issue link (" + linkR.status + "): " + (await linkR.text()).slice(0, 200) }, 502);

        const verify = await bacaIssue(qaKey);
        if (verify.error || !linksKe(verify.issue, devKey)) {
          return json({ error: "Jira menerima upload tetapi link belum terverifikasi; sync ulang sebelum mencoba lagi." }, 502);
        }
        latestQa = verify.issue;
        linkType = relate.name || "Relates";
      }

      if (!alreadyMentioned) {
        const next = withDevChip(((latestQa || {}).fields || {}).description, site, devKey);
        const putR = await fetch(site + "/rest/api/3/issue/" + encodeURIComponent(qaKey) + "?notifyUsers=false", {
          method: "PUT",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ fields: { description: next } }),
        });
        if (!putR.ok) {
          return json({ error: "Jira menolak description (" + putR.status + "): " + (await putR.text()).slice(0, 200) }, 502);
        }
        const verifyDesc = await bacaIssue(qaKey);
        const desc = ((verifyDesc.issue || {}).fields || {}).description;
        if (verifyDesc.error || !descriptionMentionsKey(desc, devKey)) {
          return json({ error: "Jira menerima upload tetapi chip description belum terverifikasi; sync ulang sebelum mencoba lagi." }, 502);
        }
      }
      return json(hasil(alreadyLinked, alreadyMentioned, linkType));
    }

    // GET /testcases?issue=KEY · POST /testcases/preview · POST /testcases/push
    // · POST /testcases/relink — import test case QAlity. GET dan preview
    // read-only; push/relink menulis ke QAlity/Jira dan hanya ada bila flag on.
    if (url.pathname === "/testcases" || url.pathname.startsWith("/testcases/")) {
      const tulis = url.pathname === "/testcases/push" || url.pathname === "/testcases/relink";
      if (tulis && env.TESTCASE_PUSH_ENABLED !== "on") return json({ error: "Rute test case tidak dikenal." }, 404);
      if (!user) return json({ error: "Butuh kode akses — token QAlity disimpan per akun (Settings → Account)." }, 401);
      const KEY_1 = /^[A-Z][A-Z0-9]{1,9}-\d+$/;
      const riwayat = async (issueKey) => {
        const rs = await d1q(env,
          "SELECT case_hash, title, test_key, status, error, created_at, updated_at FROM testcase_pushes WHERE user_id = ?1 AND issue_key = ?2 ORDER BY created_at",
          [user.id, issueKey], "all");
        return (rs && rs.results) || [];
      };
      const basi = (r, sekarang) => !(Date.parse(r.updated_at) >= sekarang - TC_PENDING_BASI_MS);
      if (request.method === "GET" && url.pathname === "/testcases") {
        const issueKey = (url.searchParams.get("issue") || "").trim().toUpperCase();
        if (!KEY_1.test(issueKey)) return json({ error: "Parameter issue tidak valid (contoh: CD-1234)." }, 400);
        const t = await bacaTiketTestCase(site, authHeaders, issueKey);
        if (t.error) return json({ error: t.error }, t.status);
        return json({ issueKey: t.key, projectKey: t.projectKey, existing: t.existing, history: await riwayat(t.key) });
      }
      // Dry run dan push memakai persiapan yang sama: body, validasi hard,
      // token, tiket + settings QAlity, project aktif (opsi A).
      const siapkan = async () => {
        const raw = await request.text();
        if (raw.length > 256 * 1024) return { res: json({ error: "Body terlalu besar (maks 256 KB)." }, 413) };
        let b; try { b = JSON.parse(raw); } catch { return { res: json({ error: "Body harus JSON." }, 400) }; }
        const issueKey = String((b && b.issueKey) || "").trim().toUpperCase();
        if (!KEY_1.test(issueKey)) return { res: json({ error: "issueKey tidak valid (contoh: CD-1234)." }, 400) };
        const v = validasiTestCases(b && b.cases);
        if (v.errors.length || v.cases.some((c) => c.errors.length)) {
          return { res: json({ error: "Ada case yang tidak valid — perbaiki atau hapus centangnya.", errors: v.errors, cases: v.cases }, 400) };
        }
        const kred = await d1q(env, "SELECT token, expires_at FROM qality_credentials WHERE user_id = ?1", [user.id], "first");
        if (!kred || !kred.token) return { res: json({ error: "Token QAlity belum disimpan — isi di Settings → Account → QAlity token." }, 400) };
        if (kred.expires_at && kred.expires_at < new Date().toISOString().slice(0, 10)) {
          return { res: json({ error: "Token QAlity kedaluwarsa sejak " + kred.expires_at + " — buat token baru lalu simpan di Settings." }, 400) };
        }
        const [t, qs] = await Promise.all([bacaTiketTestCase(site, authHeaders, issueKey), qalityGet("/qalitySettings", kred.token)]);
        if (t.error) return { res: json({ error: t.error }, t.status) };
        if (qs.error) return { res: json({ error: qs.error }, qs.status) };
        if (isQalityType(t.issueType)) {
          return { res: json({ error: t.key + " sendiri adalah test case QAlity — buka task tiket story/bug yang mau diuji." }, 400) };
        }
        // Keputusan Zack (opsi A): hanya project yang terdaftar aktif di
        // pengaturan QAlity token ini; createmeta saja tidak cukup (PROD/CHEC/PROM).
        const settings = qs.data && typeof qs.data === "object" && !Array.isArray(qs.data) ? qs.data : {};
        const aktif = Object.keys(settings).filter((k) => {
          const s = settings[k];
          return s && s.isQalityEnabled === true && s.isPluginEnabled === true && /^\d+$/.test(String(s.projectId || ""));
        }).sort();
        const proj = aktif.includes(t.projectKey) ? settings[t.projectKey] : null;
        if (!proj) {
          return { res: json({ error: "Project " + (t.projectKey || "?") + " belum aktif di QAlity untuk akunmu, jadi belum didukung. Project aktif: " +
            (aktif.join(", ") || "—") + ".", projectKey: t.projectKey, eligibleProjects: aktif }, 400) };
        }
        const projectId = String(proj.projectId);
        if (t.projectId && projectId !== t.projectId) {
          return { res: json({ error: "Id project " + t.projectKey + " di QAlity (" + projectId + ") beda dengan Jira (" + t.projectId + "); dihentikan." }, 409) };
        }
        return { b, t, v, kred, projectId };
      };
      if (request.method === "POST" && url.pathname === "/testcases/preview") {
        const s = await siapkan();
        if (s.res) return s.res;
        const { t, v, projectId } = s;
        // Duplikat: judul sama dengan test case yang sudah ter-link, atau case
        // yang sama pernah dibuat dari CATET. QAlity sendiri tidak menolak kembar.
        const terlink = new Map(t.existing.map((x) => [kunciJudulTc(x.summary), x.key]));
        const lama = new Map((await riwayat(t.key)).map((r) => [r.case_hash, r]));
        const sekarang = Date.now();
        const plan = [];
        for (const [index, c] of v.norm.entries()) {
          const caseHash = await tcCaseHash(t.key, c);
          const linked = terlink.get(kunciJudulTc(c.title)) || null;
          const r = lama.get(caseHash);
          const dibuat = r && TC_STATUS_DIBUAT.includes(r.status) && r.test_key ? r.test_key : null;
          const sibuk = !linked && !dibuat && r && r.status === "pending";
          const dup = linked || dibuat;
          plan.push({
            index, title: c.title, caseHash,
            action: dup ? "skip_duplicate" : sibuk && !basi(r, sekarang) ? "skip_busy" : "create",
            duplicateOf: dup,
            reason: linked ? "Judul sama dengan test case yang sudah ter-link: " + linked + "."
              : dup ? "Sudah pernah dibuat dari CATET: " + dup + "."
              : sibuk && !basi(r, sekarang) ? "Push sebelumnya untuk case ini belum selesai — tunggu ±10 menit lalu Dry run lagi."
              : sibuk ? "Push sebelumnya terputus; saat Push, Worker mencari dulu judul ini di Jira supaya tidak kembar." : null,
            testCase: petaQality(c),
          });
        }
        const create = plan.filter((p) => p.action === "create").length;
        return json({
          issueKey: t.key,
          project: { key: t.projectKey, id: projectId },
          linkType: TC_LINK_TYPE,
          existing: t.existing,
          plan,
          counts: { create, skip: plan.length - create },
          previewHash: await tcPreviewHash(t.key, v.norm),
        });
      }
      if (request.method === "POST" && url.pathname === "/testcases/push") {
        const s = await siapkan();
        if (s.res) return s.res;
        const { b, t, v, kred, projectId } = s;
        // Yang dipush harus persis yang sudah dilihat di dry run.
        if (String((b && b.previewHash) || "") !== await tcPreviewHash(t.key, v.norm)) {
          return json({ error: "Isi test case berubah sejak Dry run — jalankan Dry run lagi sebelum Push." }, 409);
        }
        const mulai = new Date().toISOString();
        const terlink = new Map(t.existing.map((x) => [kunciJudulTc(x.summary), x.key]));
        const lama = new Map((await riwayat(t.key)).map((r) => [r.case_hash, r]));
        const hasil = [];
        const klaim = []; // { h, c, basi } — case yang dipegang push ini
        for (const [index, c] of v.norm.entries()) {
          const caseHash = await tcCaseHash(t.key, c);
          const h = { index, title: c.title, caseHash, status: null, testKey: null, error: null };
          hasil.push(h);
          const linked = terlink.get(kunciJudulTc(c.title));
          const r = lama.get(caseHash);
          if (linked || (r && TC_STATUS_DIBUAT.includes(r.status) && r.test_key)) {
            h.status = "skipped_duplicate"; h.testKey = linked || r.test_key;
            continue;
          }
          // Klaim atomik per case di D1: klik ganda / dua tab tidak membuat kembar.
          let dapat = false;
          const lewat = !!r && r.status === "pending" && basi(r, Date.parse(mulai));
          if (!r) {
            dapat = jumlahPerubahan(await d1q(env,
              "INSERT INTO testcase_pushes (user_id, issue_key, case_hash, title, test_key, status, error, created_at, updated_at) " +
              "VALUES (?1, ?2, ?3, ?4, NULL, 'pending', NULL, ?5, ?5) ON CONFLICT DO NOTHING",
              [user.id, t.key, caseHash, c.title, mulai], "run")) === 1;
          } else if (r.status === "failed") {
            dapat = jumlahPerubahan(await d1q(env,
              "UPDATE testcase_pushes SET status = 'pending', error = NULL, title = ?4, updated_at = ?5 " +
              "WHERE user_id = ?1 AND issue_key = ?2 AND case_hash = ?3 AND status = 'failed'",
              [user.id, t.key, caseHash, c.title, mulai], "run")) === 1;
          } else if (lewat) {
            dapat = jumlahPerubahan(await d1q(env,
              "UPDATE testcase_pushes SET updated_at = ?5 WHERE user_id = ?1 AND issue_key = ?2 AND case_hash = ?3 AND status = 'pending' AND updated_at = ?4",
              [user.id, t.key, caseHash, r.updated_at, mulai], "run")) === 1;
          }
          if (!dapat) {
            h.status = "skipped_busy";
            h.error = "Case ini sedang diproses push lain — tunggu ±10 menit lalu Dry run lagi.";
            continue;
          }
          klaim.push({ h, c, basi: lewat });
        }

        // Push sebelumnya terputus (pending basi): cari dulu judulnya di Jira.
        // Ketemu → cukup di-link; tidak bisa dicek → tidak membuat apa pun.
        const terputus = klaim.filter((k) => k.basi);
        if (terputus.length) {
          let temu = null;
          if (/^[A-Z][A-Z0-9_]{0,19}$/.test(t.projectKey)) {
            const sejak = Math.min(...terputus.map((k) => Date.parse((lama.get(k.h.caseHash) || {}).created_at) || Date.parse(mulai)));
            const menit = Math.ceil((Date.parse(mulai) - sejak) / 60000) + 5;
            const jql = 'project = "' + t.projectKey + '" AND issuetype = "QAlity Test" AND created >= -' + menit + "m ORDER BY created DESC";
            try {
              const r = await fetch(site + "/rest/api/3/search/jql?jql=" + encodeURIComponent(jql) + "&fields=summary&maxResults=100", { headers: authHeaders });
              if (r.ok) {
                const d = await r.json();
                if (!d.nextPageToken) {
                  temu = new Map();
                  for (const i of d.issues || []) {
                    const kj = kunciJudulTc(i.fields && i.fields.summary);
                    if (kj && !temu.has(kj)) temu.set(kj, i.key);
                  }
                }
              }
            } catch { temu = null; }
          }
          for (const k of terputus) {
            if (!temu) {
              k.h.status = "pending";
              k.h.error = "Push sebelumnya terputus dan Jira belum bisa dicek — tidak ada yang dibuat; coba lagi nanti.";
            } else if (temu.has(kunciJudulTc(k.c.title))) k.h.testKey = temu.get(kunciJudulTc(k.c.title));
          }
        }

        // Import QAlity: satu request untuk semua case yang perlu dibuat.
        const buat = klaim.filter((k) => !k.h.status && !k.h.testKey);
        const tanpaPeta = []; // key yang terbuat tapi belum jelas milik case mana
        if (buat.length) {
          let r = null, d = null;
          try {
            r = await fetch(QALITY_API + "/testCases/import", {
              method: "POST",
              headers: { Authorization: "Bearer " + kred.token, "Content-Type": "application/json", Accept: "application/json" },
              body: JSON.stringify({ projectId, testCases: buat.map((k) => petaQality(k.c)) }),
            });
            if (r.ok) d = await r.json();
          } catch { d = null; }
          if (r && !r.ok && r.status < 500) {
            // 4xx/429 = QAlity menolak seluruh request; aman dicoba lagi.
            const pesan = r.status === 401 || r.status === 403 ? "Token QAlity ditolak (HTTP " + r.status + ") — perbarui token di Settings; tidak ada yang dibuat."
              : r.status === 429 ? "QAlity membatasi request (HTTP 429) — tidak ada yang dibuat; coba lagi sebentar."
              : "QAlity menolak import (HTTP " + r.status + ") — tidak ada yang dibuat.";
            for (const k of buat) { k.h.status = "failed"; k.h.error = pesan; }
          } else if (!d || !Array.isArray(d.success)) {
            // 5xx / jaringan / body aneh: bisa saja sudah terbuat. Tetap pending.
            for (const k of buat) {
              k.h.status = "pending";
              k.h.error = "Hasil import QAlity tidak pasti" + (r ? " (HTTP " + r.status + ")" : "") +
                " — jangan buat manual; Push ulang setelah ±10 menit mencari dulu judulnya di Jira.";
            }
          } else {
            // Respons spike hanya { testCaseKey }; nama dipakai bila ada, sisanya
            // urut. Pemetaan akhir dipastikan dari Summary di Jira (di bawah).
            const ditolak = new Set((Array.isArray(d.errors) ? d.errors : []).map((x) => kunciJudulTc(x && x.name)).filter(Boolean));
            const keys = d.success.map((x) => x && x.testCaseKey).filter((k) => KEY_1.test(String(k || "")));
            const sisaKey = [];
            for (const x of d.success) {
              if (!keys.includes(x && x.testCaseKey)) continue;
              const k = x.name != null ? buat.find((k) => !k.h.testKey && kunciJudulTc(k.c.title) === kunciJudulTc(x.name)) : null;
              if (k) k.h.testKey = x.testCaseKey; else sisaKey.push(x.testCaseKey);
            }
            const belum = buat.filter((k) => !k.h.testKey && !ditolak.has(kunciJudulTc(k.c.title)));
            if (sisaKey.length === belum.length) belum.forEach((k, i) => { k.h.testKey = sisaKey[i]; });
            else tanpaPeta.push(...sisaKey);
            for (const k of buat) {
              if (k.h.testKey) continue;
              if (ditolak.has(kunciJudulTc(k.c.title))) { k.h.status = "failed"; k.h.error = "QAlity menolak case ini — tidak dibuat."; }
              else k.h.belumPasti = true;
            }
          }
        }

        // Link setiap test case ke tiket, lalu baca balik kedua sisi.
        const linkGagal = new Map();
        const semuaKey = [...new Set([...klaim.map((k) => k.h.testKey).filter(Boolean), ...tanpaPeta])];
        for (const key of semuaKey) {
          const e = await buatLinkQality(site, authHeaders, key, t.key);
          if (e) linkGagal.set(key, e);
        }
        const cek = semuaKey.length ? await bacaIssues(site, authHeaders, [t.key, ...semuaKey], ["summary", "issuelinks"]) : null;
        if (cek) {
          // Pemetaan pasti key → case lewat Summary (judul unik per batch).
          const bySummary = new Map(semuaKey.filter((key) => cek.get(key)).map((key) => [kunciJudulTc(cek.get(key).summary), key]));
          const terpakai = new Set();
          for (const k of klaim) {
            if (k.h.status) continue;
            const key = bySummary.get(kunciJudulTc(k.c.title));
            if (key) { k.h.testKey = key; k.h.belumPasti = false; terpakai.add(key); k.pasti = true; }
          }
          // Key hasil urutan yang ternyata milik case lain → belum pasti.
          for (const k of klaim) if (!k.h.status && !k.pasti && terpakai.has(k.h.testKey)) k.h.belumPasti = true;
        }
        const tiket = cek && cek.get(t.key);
        for (const k of klaim) {
          const h = k.h;
          if (h.status) { /* failed / pending ditetapkan di atas */ }
          else if (!h.testKey || h.belumPasti) {
            h.status = "pending"; h.testKey = null;
            h.error = "QAlity tidak mengembalikan key untuk case ini — Push ulang setelah ±10 menit mencari dulu judulnya di Jira.";
          } else if (linkGagal.has(h.testKey)) {
            h.status = "created_unlinked"; h.error = linkGagal.get(h.testKey) + " Klik Retry link.";
          } else if (cek && cek.get(h.testKey) && tiket &&
              tcLinkKeTiket(cek.get(h.testKey).issuelinks, t.key) && tcLinkDariTest(tiket.issuelinks, h.testKey)) {
            h.status = "created_linked";
          } else {
            h.status = "link_unverified"; h.error = "Link dikirim tapi belum terbaca balik di Jira — klik Retry link untuk cek ulang.";
          }
          delete h.belumPasti;
          // pending: updated_at baru = jeda ±10 menit dihitung dari sekarang.
          await d1q(env,
            "UPDATE testcase_pushes SET status = ?4, test_key = ?5, error = ?6, title = ?7, updated_at = ?8 WHERE user_id = ?1 AND issue_key = ?2 AND case_hash = ?3",
            [user.id, t.key, h.caseHash, h.status, h.testKey, h.error, h.title, new Date().toISOString()], "run");
        }
        const counts = {};
        for (const h of hasil) counts[h.status] = (counts[h.status] || 0) + 1;
        return json({
          issueKey: t.key, project: { key: t.projectKey, id: projectId }, linkType: TC_LINK_TYPE,
          results: hasil, counts, unmappedKeys: tanpaPeta.filter((key) => !klaim.some((k) => k.h.testKey === key)),
          history: await riwayat(t.key),
        });
      }
      if (request.method === "POST" && url.pathname === "/testcases/relink") {
        let b; try { b = await request.json(); } catch { return json({ error: "Body harus JSON." }, 400); }
        const issueKey = String((b && b.issueKey) || "").trim().toUpperCase();
        const testKey = String((b && b.testKey) || "").trim().toUpperCase();
        if (!KEY_1.test(issueKey) || !KEY_1.test(testKey)) return json({ error: "issueKey/testKey tidak valid (contoh: CD-1234)." }, 400);
        const row = await d1q(env,
          "SELECT case_hash FROM testcase_pushes WHERE user_id = ?1 AND issue_key = ?2 AND test_key = ?3 AND status IN ('created_unlinked','link_unverified')",
          [user.id, issueKey, testKey], "first");
        if (!row) return json({ error: "Tidak ada test case " + testKey + " yang menunggu link ke " + issueKey + "." }, 404);
        const awal = await bacaIssues(site, authHeaders, [testKey], ["issuetype", "issuelinks"]);
        const f = awal && awal.get(testKey);
        if (!f) return json({ error: "Jira belum bisa membaca " + testKey + " — coba lagi sebentar." }, 502);
        if (!isQalityType(f.issuetype && f.issuetype.name)) return json({ error: testKey + " bukan test case QAlity." }, 409);
        // Sudah ter-link (mis. link_unverified yang ternyata berhasil) → tidak POST lagi.
        let error = tcLinkKeTiket(f.issuelinks, issueKey) ? null : await buatLinkQality(site, authHeaders, testKey, issueKey);
        let status = "created_unlinked";
        if (!error) {
          const cek = await bacaIssues(site, authHeaders, [issueKey, testKey], ["issuelinks"]);
          const ok = !!cek && !!cek.get(testKey) && !!cek.get(issueKey) &&
            tcLinkKeTiket(cek.get(testKey).issuelinks, issueKey) && tcLinkDariTest(cek.get(issueKey).issuelinks, testKey);
          status = ok ? "created_linked" : "link_unverified";
          if (!ok) error = "Link belum terbaca balik di Jira — coba Retry link lagi sebentar.";
        }
        await d1q(env,
          "UPDATE testcase_pushes SET status = ?4, error = ?5, updated_at = ?6 WHERE user_id = ?1 AND issue_key = ?2 AND case_hash = ?3",
          [user.id, issueKey, row.case_hash, status, error, new Date().toISOString()], "run");
        return json({ issueKey, testKey, status, error, history: await riwayat(issueKey) });
      }
      return json({ error: "Rute test case tidak dikenal." }, 404);
    }

    // GET /tickets — tiket terbuka yang di-assign ke pemilik token, plus
    // dependensi tiket dev-nya (deps): dari issue link DAN key yang disebut di
    // description. Untuk pencocokan CATET-only, Worker juga mengambil metadata
    // minimal seluruh issue di sprint aktif (termasuk Done dan issue orang lain).
    // Test case QAlity dikecualikan dari ketiganya (lihat isQalityType).
    // Description mentah tidak pernah diteruskan ke browser.
    if (request.method === "GET" && url.pathname === "/tickets") {
      const jql = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
      const sf = await sprintFieldId(site, authHeaders); // id field Sprint (bisa null)
      const ticketFields = "summary,status,created,issuetype,parent,components,labels,issuelinks,description,resolutiondate,statuscategorychangedate";
      let assignedToken = "", assignedIssues = [];
      const seenAssignedTokens = new Set();
      do {
        const pageUrl = site + "/rest/api/3/search/jql?jql=" + encodeURIComponent(jql) +
          "&fields=" + ticketFields + (sf ? "," + sf : "") + "&maxResults=100" +
          (assignedToken ? "&nextPageToken=" + encodeURIComponent(assignedToken) : "");
        const r = await fetch(pageUrl, { headers: authHeaders });
        if (!r.ok) return json({ error: "Jira menolak (" + r.status + "): " + (await r.text()).slice(0, 300) }, 502);
        const page = await r.json();
        assignedIssues.push(...(page.issues || []));
        assignedToken = page.nextPageToken || "";
        if (assignedToken && seenAssignedTokens.has(assignedToken)) {
          return json({ error: "Jira mengulang token pagination tiket; hasil tidak aman dipakai." }, 502);
        }
        if (assignedToken) seenAssignedTokens.add(assignedToken);
      } while (assignedToken);
      // Test case QAlity yang di-assign ke user tidak masuk inbox; key-nya
      // diingat supaya juga tidak terhitung dependensi atau kandidat pairing.
      const qalityKeys = new Set();
      const data = { issues: assignedIssues.filter((i) => {
        const t = i.fields && i.fields.issuetype;
        if (!isQalityType(t && t.name)) return true;
        qalityKeys.add(i.key);
        return false;
      }) };
      const excludedQality = assignedIssues.length - data.issues.length;
      const KEY_G = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;
      const beres = (st) => !!st && ((st.statusCategory && st.statusCategory.key === "done") || /^done$/i.test(st.name || ""));
      const statusByKey = new Map(); // key → { status, done, doneAt }
      const depsByTiket = new Map(); // key tiket → Set(key dependensi)
      for (const i of data.issues || []) {
        const f = i.fields || {};
        const set = new Set();
        for (const l of f.issuelinks || []) {
          const lain = l.outwardIssue || l.inwardIssue;
          if (!lain || !lain.key) continue;
          if (isQalityLink(l)) { qalityKeys.add(lain.key); continue; }
          set.add(lain.key);
          const st = lain.fields && lain.fields.status;
          if (st) {
            const done = beres(st);
            statusByKey.set(lain.key, {
              status: st.name || "?", done,
              doneAt: done ? (lain.fields.resolutiondate || lain.fields.statuscategorychangedate || null) : null,
            });
          }
        }
        for (const m of JSON.stringify(f.description || "").matchAll(KEY_G)) set.add(m[0]);
        set.delete(i.key);
        if (set.size) depsByTiket.set(i.key, set);
      }
      // ?keys= — key tugas papan milik klien; statusnya dilaporkan balik supaya
      // tugas yang tiketnya sudah Done via Jira bisa ditutup otomatis. Tiket
      // Done tak pernah muncul di feed (JQL != Done), jadi harus dicek eksplisit.
      const KEY_1 = /^[A-Z][A-Z0-9]{1,9}-\d+$/;
      const papanKeys = (url.searchParams.get("keys") || "").split(",")
        .map((k) => k.trim()).filter((k) => KEY_1.test(k)).slice(0, 50);
      for (const i of data.issues || []) {
        const st = i.fields && i.fields.status;
        if (st) {
          const done = beres(st);
          statusByKey.set(i.key, {
            status: st.name || "?", done,
            doneAt: done ? (i.fields.resolutiondate || i.fields.statuscategorychangedate || null) : null,
          });
        }
      }
      const tanya = [...new Set([...[...depsByTiket.values()].flatMap((s) => [...s]).filter((k) => !qalityKeys.has(k)), ...papanKeys])]
        .filter((k) => !statusByKey.has(k) || (statusByKey.get(k).done && !statusByKey.get(k).doneAt)).slice(0, 100);
      if (tanya.length) {
        const rb = await fetch(site + "/rest/api/3/issue/bulkfetch", {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ issueIdsOrKeys: tanya,
            fields: ["status", "resolutiondate", "statuscategorychangedate", "issuetype"] }),
        });
        if (rb.ok) {
          const db = await rb.json();
          for (const bi of db.issues || []) {
            const f = bi.fields || {};
            // Key test case yang hanya disebut di description baru ketahuan
            // tipenya di sini.
            if (isQalityType(f.issuetype && f.issuetype.name)) qalityKeys.add(bi.key);
            const st = f.status;
            if (!st) continue;
            const done = beres(st);
            // Tanggal Done sebenarnya — supaya penutupan otomatis di klien
            // mencatat log di hari yang benar, bukan hari sinkronnya.
            const doneAt = done ? (f.resolutiondate || f.statuscategorychangedate || null) : null;
            statusByKey.set(bi.key, { status: st.name || "?", done, doneAt });
          }
        }
      }
      // Candidate pool pasangan QA↔dev: semua issue di sprint aktif yang terlihat
      // pada feed user. Query kedua sengaja meliputi Done; status Done adalah
      // sinyal yang dibutuhkan badge "ready to test". Flag assignedToMe menandai
      // tiket yang juga ada di feed assignee=currentUser(); klien memakai flag
      // itu untuk menyembunyikan review pairing milik orang lain. Kalau Jira
      // menolak query ini, feed utama tetap berfungsi dan klien hanya tidak
      // mendapat warning.
      let pairingIssues = [];
      if (sf) {
        const activeSprintIds = [...new Set((data.issues || []).flatMap((i) => {
          const arr = i.fields && i.fields[sf];
          return Array.isArray(arr) ? arr.filter((x) => x && x.state === "active" && x.id != null).map((x) => String(x.id)) : [];
        }))].filter((x) => /^\d+$/.test(x)).slice(0, 10);
        if (activeSprintIds.length) {
          const pairJql = "sprint in (" + activeSprintIds.join(",") + ") ORDER BY updated DESC";
          let nextPageToken = "", pairRaw = [], pairingComplete = true;
          const seenPairTokens = new Set();
          do {
            const pageUrl = site + "/rest/api/3/search/jql?jql=" + encodeURIComponent(pairJql) +
              "&fields=" + ticketFields + "," + sf + "&maxResults=100" +
              (nextPageToken ? "&nextPageToken=" + encodeURIComponent(nextPageToken) : "");
            const rp = await fetch(pageUrl, { headers: authHeaders });
            if (!rp.ok) { pairingComplete = false; break; }
            const pd = await rp.json();
            pairRaw.push(...(pd.issues || []));
            nextPageToken = pd.nextPageToken || "";
            if (nextPageToken && seenPairTokens.has(nextPageToken)) { pairingComplete = false; break; }
            if (nextPageToken) seenPairTokens.add(nextPageToken);
          } while (nextPageToken);
          // Jangan menghasilkan warning dari candidate pool parsial: lebih baik
          // tidak ada warning daripada menuduh pasangan hilang dari data bolong.
          if (!pairingComplete) pairRaw = [];
          const assignedKeys = new Set((data.issues || []).map((i) => i.key));
          pairRaw = pairRaw.filter((i) => {
            const t = i.fields && i.fields.issuetype;
            if (!isQalityType(t && t.name)) return true;
            qalityKeys.add(i.key);
            return false;
          });
          pairingIssues = pairRaw.map((i) => {
            const f = i.fields || {};
            const arr = Array.isArray(f[sf]) ? f[sf] : [];
            const aktif = arr.find((x) => x && x.state === "active");
            const st = f.status || null;
            const links = (f.issuelinks || []).filter((l) => !isQalityLink(l))
              .map((l) => l.outwardIssue || l.inwardIssue)
              .filter((x) => x && x.key && !qalityKeys.has(x.key)).map((x) => x.key);
            const mentions = [...String(JSON.stringify(f.description || "")).matchAll(KEY_G)].map((m) => m[0])
              .filter((k) => k !== i.key && !qalityKeys.has(k));
            return {
              key: i.key,
              summary: f.summary || "",
              status: st && st.name || null,
              done: beres(st),
              doneAt: beres(st) ? (f.resolutiondate || f.statuscategorychangedate || null) : null,
              created: f.created || null,
              issueType: f.issuetype && f.issuetype.name || "",
              parentKey: f.parent && f.parent.key || null,
              components: (f.components || []).map((x) => x && x.name).filter(Boolean),
              labels: Array.isArray(f.labels) ? f.labels : [],
              linkedKeys: [...new Set(links)],
              mentionedKeys: [...new Set(mentions)],
              sprintId: aktif && aktif.id != null ? String(aktif.id) : null,
              sprintName: aktif && aktif.name || null,
              assignedToMe: assignedKeys.has(i.key),
            };
          });
        }
      }

      const body = {
        site,
        pairingIssues,
        excludedQality,
        items: (data.issues || []).map((i) => {
          const it = {
            key: i.key,
            summary: (i.fields && i.fields.summary) || "",
            status: (i.fields && i.fields.status && i.fields.status.name) || null,
            created: (i.fields && i.fields.created) || null,
          };
          const set = depsByTiket.get(i.key);
          const deps = set
            ? [...set].filter((k) => statusByKey.has(k) && !qalityKeys.has(k)).map((k) => ({ key: k, ...statusByKey.get(k) }))
            : [];
          if (deps.length) it.deps = deps;
          // Sprint aktif tiket ini (kalau ada) — klien memakainya untuk
          // memunculkan sprint otomatis tanpa dibuat manual.
          const arr = sf && i.fields ? i.fields[sf] : null;
          const aktif = Array.isArray(arr) ? arr.find((x) => x && x.state === "active") : null;
          if (aktif) it.sprint = { jiraId: aktif.id, name: aktif.name || "", endDate: aktif.endDate || null };
          return it;
        }),
      };
      if (papanKeys.length) {
        body.keyStatus = {};
        for (const k of papanKeys) if (statusByKey.has(k)) body.keyStatus[k] = statusByKey.get(k);
      }
      return json(body);
    }

    // GET /bau?project=TDBU — daftar tiket "topik" di project BAU (Business
    // as Usual), untuk worklog di luar task sprint. Semua tiket yang belum
    // Done ikut; Catet yang mencocokkan judul tugas ke topiknya.
    if (request.method === "GET" && url.pathname === "/bau") {
      const proj = (url.searchParams.get("project") || "").trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9]{1,9}$/.test(proj)) {
        return json({ error: "Parameter project tidak valid (contoh: TDBU)." }, 400);
      }
      const jql = "project = " + proj + " AND statusCategory != Done ORDER BY key ASC";
      const r = await fetch(
        site + "/rest/api/3/search/jql?jql=" + encodeURIComponent(jql) +
          "&fields=summary,issuetype&maxResults=100",
        { headers: authHeaders }
      );
      if (!r.ok) return json({ error: "Jira menolak (" + r.status + "): " + (await r.text()).slice(0, 300) }, 502);
      const data = await r.json();
      return json({
        items: (data.issues || []).map((i) => ({
          key: i.key,
          summary: (i.fields && i.fields.summary) || "",
          type: (i.fields && i.fields.issuetype && i.fields.issuetype.name) || null,
        })),
      });
    }

    // GET /worklog-report?from=YYYY-MM-DD&to=YYYY-MM-DD — total worklog milik
    // pemilik token per tanggal (semua project), untuk panel "sudah ter-log
    // berapa hari ini" di Catet. Dua tahap: JQL worklogAuthor mencari tiket
    // yang memuat worklog-ku pada rentang itu, lalu worklog tiap tiket
    // diambil dan dijumlahkan per tanggal (tanggal lokal penulisnya — Jira
    // menyimpan started lengkap dengan offset zona waktu).
    if (request.method === "GET" && url.pathname === "/worklog-report") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
        return json({ error: "Parameter from/to harus YYYY-MM-DD dan from ≤ to." }, 400);
      }
      if ((new Date(to) - new Date(from)) / 86400000 > 31) {
        return json({ error: "Rentang maksimal 31 hari." }, 400);
      }
      const meR = await fetch(site + "/rest/api/3/myself", { headers: authHeaders });
      if (!meR.ok) return json({ error: "Jira menolak (" + meR.status + ")" }, 502);
      const me = (await meR.json()).accountId;

      const jql = 'worklogAuthor = currentUser() AND worklogDate >= "' + from + '" AND worklogDate <= "' + to + '"';
      const sR = await fetch(
        site + "/rest/api/3/search/jql?jql=" + encodeURIComponent(jql) + "&fields=summary&maxResults=50",
        { headers: authHeaders }
      );
      if (!sR.ok) return json({ error: "Jira menolak (" + sR.status + "): " + (await sR.text()).slice(0, 300) }, 502);
      // Maks 40 tiket per permintaan — di bawah kuota 50 subrequest Worker.
      const issues = ((await sR.json()).issues || []).slice(0, 40);

      // Pagar zona waktu: filter startedAfter/Before dilonggarkan ±1 hari,
      // penyaring pastinya tetap perbandingan tanggal lokal di bawah.
      const afterMs = new Date(from + "T00:00:00Z").getTime() - 86400000;
      const beforeMs = new Date(to + "T23:59:59Z").getTime() + 86400000;
      const hasil = await Promise.all(issues.map(async (i) => {
        const r = await fetch(
          site + "/rest/api/3/issue/" + encodeURIComponent(i.key) + "/worklog" +
            "?startedAfter=" + afterMs + "&startedBefore=" + beforeMs + "&maxResults=1000",
          { headers: authHeaders }
        );
        if (!r.ok) return { key: i.key, logs: [] };
        return { key: i.key, logs: (await r.json()).worklogs || [] };
      }));

      // Teks polos dari comment ADF (dipangkas 200 huruf).
      const adfText = (n) => !n ? "" :
        (typeof n.text === "string" ? n.text : (n.content || []).map(adfText).join(" ").trim());

      const days = {};
      for (const { key, logs } of hasil) {
        for (const w of logs) {
          if (!w.author || w.author.accountId !== me) continue;
          const tgl = String(w.started || "").slice(0, 10); // tanggal lokal penulis
          if (tgl < from || tgl > to) continue;
          const d = (days[tgl] = days[tgl] || { total: 0, items: {}, entries: [] });
          d.total += w.timeSpentSeconds || 0;
          d.items[key] = (d.items[key] || 0) + (w.timeSpentSeconds || 0);
          d.entries.push({
            id: w.id, key, started: w.started, seconds: w.timeSpentSeconds || 0,
            comment: adfText(w.comment).replace(/\s+/g, " ").slice(0, 200),
          });
        }
      }
      // items: objek → array tersortir jam terbesar, biar enak ditampilkan.
      for (const tgl of Object.keys(days)) {
        days[tgl].items = Object.entries(days[tgl].items)
          .map(([key, seconds]) => ({ key, seconds }))
          .sort((a, b) => b.seconds - a.seconds);
        days[tgl].entries.sort((a, b) => String(a.started).localeCompare(String(b.started)));
      }
      const summaries = {};
      for (const i of issues) summaries[i.key] = (i.fields && i.fields.summary) || "";
      return json({ from, to, days, summaries });
    }

    // POST /worklog — { key, started (ISO), timeSpentSeconds, comment }
    if (request.method === "POST" && url.pathname === "/worklog") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "Body harus JSON." }, 400); }
      const { entryId, key, started, timeSpentSeconds, comment = "" } = body || {};
      const startedJira = typeof started === "string" && toJiraDate(started);
      if (typeof key !== "string" || !/^[A-Z][A-Z0-9]{1,9}-\d+$/.test(key) ||
          !startedJira || !Number.isSafeInteger(timeSpentSeconds) || timeSpentSeconds <= 0 ||
          typeof comment !== "string" || comment.length > 2000 ||
          (entryId != null && (typeof entryId !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(entryId)))) {
        return json({ error: "Worklog key, tanggal, durasi, note, atau entryId tidak valid." }, 400);
      }
      const payload = { started: startedJira, timeSpentSeconds: Math.max(60, timeSpentSeconds) };
      if (comment) payload.comment = {
        type: "doc", version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: comment }] }],
      };
      const base = site + "/rest/api/3/issue/" + encodeURIComponent(key) + "/worklog";
      const digest = await sha256hex(JSON.stringify({ key, ...payload }));
      const marker = entryId ? await sha256hex(uid + ":" + entryId) : null;
      if (marker) payload.properties = [{ key: "catet.entry", value: { id: marker } }];
      const text = (n) => !n ? "" : typeof n.text === "string" ? n.text : (n.content || []).map(text).join("");
      const matches = (w) => w && String(w.id || "") && toJiraDate(w.started) === startedJira &&
        w.timeSpentSeconds === payload.timeSpentSeconds && text(w.comment) === comment &&
        (!marker || (w.properties || []).some(p => p.key === "catet.entry" && p.value && p.value.id === marker));
      const verify = async (id) => {
        if (!/^\d+$/.test(String(id || ""))) throw new Error("Jira tidak mengembalikan worklog ID valid.");
        const read = await fetch(base + "/" + id + "?expand=properties", { headers: authHeaders });
        if (!read.ok || !matches(await read.json())) throw new Error("Read-back worklog Jira belum cocok; jangan kirim ulang sebelum rekonsiliasi.");
        if (entryId) await d1q(env,
          "UPDATE worklog_requests SET worklog_id = ?1 WHERE user_id = ?2 AND entry_id = ?3",
          [String(id), uid, entryId], "run");
        return json({ ok: true, worklogId: String(id) });
      };
      if (entryId) {
        if (!env.CATET_DB) return json({ error: "Pengiriman aman worklog membutuhkan D1." }, 503);
        const claim = await d1q(env,
          "INSERT INTO worklog_requests (user_id, entry_id, payload_hash) VALUES (?1, ?2, ?3) ON CONFLICT(user_id, entry_id) DO NOTHING",
          [uid, entryId, digest], "run");
        if (!jumlahPerubahan(claim)) {
          const existing = await d1q(env,
            "SELECT payload_hash, worklog_id FROM worklog_requests WHERE user_id = ?1 AND entry_id = ?2",
            [uid, entryId], "first");
          if (!existing || existing.payload_hash !== digest) return json({ error: "Worklog pernah dikirim dengan isi berbeda. Periksa Jira sebelum mengubahnya." }, 409);
          if (existing.worklog_id) return verify(existing.worklog_id);
          // ponytail: scan dibatasi 10 halaman; bila belum pasti, tolak retry
          // daripada menduplikasi worklog. Tambah operasi rekonsiliasi admin bila perlu.
          for (let startAt = 0, page = 0; page < 10; page++) {
            const read = await fetch(base + "?expand=properties&maxResults=100&startAt=" + startAt, { headers: authHeaders });
            if (!read.ok) break;
            const list = await read.json();
            if (!Array.isArray(list.worklogs)) break;
            const found = list.worklogs.find(matches);
            if (found) return verify(found.id);
            startAt += list.worklogs.length;
            if (!list.worklogs.length || !Number.isInteger(list.total) || startAt >= list.total) break;
          }
          return json({ error: "Pengiriman sebelumnya belum terverifikasi. Periksa Jira; request baru tidak dikirim." }, 409);
        }
      }
      try {
        const r = await fetch(base + "?notifyUsers=true&adjustEstimate=auto&expand=properties", {
          method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" }, body: JSON.stringify(payload),
        });
        if (!r.ok) {
          // Hanya penolakan definitif 4xx (bukan timeout) yang aman dicoba lagi.
          if (entryId && r.status >= 400 && r.status < 500 && r.status !== 408) await d1q(env,
            "DELETE FROM worklog_requests WHERE user_id = ?1 AND entry_id = ?2", [uid, entryId], "run");
          // Teruskan alasan dari Jira (mis. "Worklog tidak boleh pada tiket Done") supaya
          // user tahu apa yang ditolak; tanpa ini 400 tak bisa didiagnosis.
          let alasan = "";
          try {
            const j = JSON.parse(await r.text());
            alasan = [...(j.errorMessages || []), ...Object.values(j.errors || {})]
              .filter(x => typeof x === "string").join("; ").slice(0, 300);
          } catch {}
          return json({ error: "Jira menolak (" + r.status + ")" + (alasan ? ": " + alasan : ". Periksa status sebelum mencoba lagi.") }, 502);
        }
        return await verify((await r.json()).id);
      } catch {
        return json({ error: "Hasil pengiriman Jira belum terverifikasi. Retry hanya merekonsiliasi request yang sama." }, 502);
      }
    }

    // POST /transition — { key, target:"inprogress"|"done" } → geser status
    // tiket. Aman & idempoten, tak pernah mundur:
    //  • inprogress: hanya dari kategori To Do (new); yang sudah maju diabaikan.
    //  • done: dari To Do / In Progress; yang sudah Done diabaikan.
    // Transisi tujuan dicari dinamis (nama diutamakan, lalu kategori) — kebal
    // beda nama status antar workflow.
    if (request.method === "POST" && url.pathname === "/transition") {
      let body; try { body = await request.json(); } catch { return json({ error: "Body harus JSON." }, 400); }
      const key = body && body.key;
      const target = body && body.target === "done" ? "done" : "inprogress";
      if (!key || !/^[A-Z][A-Z0-9]{1,9}-\d+$/.test(key)) return json({ error: "Format key tidak valid." }, 400);
      const base = site + "/rest/api/3/issue/" + encodeURIComponent(key);
      const rs = await fetch(base + "?fields=status", { headers: authHeaders });
      if (!rs.ok) return json({ error: "Jira menolak (" + rs.status + "): " + (await rs.text()).slice(0, 200) }, 502);
      const cur = (await rs.json()).fields || {};
      const catNow = cur.status && cur.status.statusCategory && cur.status.statusCategory.key;
      // guard anti-mundur: skip kalau sudah di/di depan kategori tujuan
      const skip = target === "inprogress" ? catNow !== "new" : catNow === "done";
      if (skip) return json({ ok: true, skipped: true, status: (cur.status && cur.status.name) || null });
      const rt = await fetch(base + "/transitions", { headers: authHeaders });
      if (!rt.ok) return json({ error: "Gagal ambil transisi (" + rt.status + ")." }, 502);
      const trs = ((await rt.json()).transitions) || [];
      const namaRe = target === "done" ? /^done$/i : /^in\s*progress$/i;
      const kat = target === "done" ? "done" : "indeterminate";
      const cocok = trs.find((t) => t.to && namaRe.test(t.to.name || "")) ||
        trs.find((t) => t.to && t.to.statusCategory && t.to.statusCategory.key === kat);
      if (!cocok) return json({ ok: false, error: "Tak ada transisi ke " + target + "." }, 200);
      const rp = await fetch(base + "/transitions", {
        method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ transition: { id: cocok.id } }),
      });
      if (!rp.ok) return json({ error: "Jira menolak transisi (" + rp.status + "): " + (await rp.text()).slice(0, 200) }, 502);
      return json({ ok: true, status: (cocok.to && cocok.to.name) || target });
    }

    // GET/PUT /state — sinkronisasi data antar perangkat. Satu blob JSON per
    // pengguna di D1, last-write-wins di klien. (KV lama hanya menyimpan blob
    // user "default" tanpa kode; jalur itu sudah ditutup.)
    if (url.pathname === "/state") {
      if (!env.CATET_DB) {
        return json({ error: "Storage belum dikonfigurasi — buat D1 (wrangler d1 create catet-db), isi database_id di wrangler.toml, deploy ulang. Lihat worker/README.md." }, 500);
      }
      if (request.method === "GET") {
        const row = await d1q(env, "SELECT blob FROM states WHERE user_id = ?1", [uid], "first");
        return json(row ? JSON.parse(row.blob) : { updatedAt: null, stores: null });
      }
      if (request.method === "PUT") {
        let body;
        try { body = await request.json(); } catch { return json({ error: "Body harus JSON." }, 400); }
        if (!body || typeof body.updatedAt !== "string" || !Number.isFinite(Date.parse(body.updatedAt)) || !validCatetStores(body.stores)) {
          return json({ error: "Field updatedAt dan stores wajib ada." }, 400);
        }
        const raw = JSON.stringify({ updatedAt: body.updatedAt, stores: body.stores });
        if (new TextEncoder().encode(raw).byteLength > 512 * 1024) return json({ error: "Data terlalu besar (maks 512 KB)." }, 413);
        await d1q(env,
          "INSERT INTO states (user_id, blob, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(user_id) DO UPDATE SET blob = ?2, updated_at = ?3",
          [uid, raw, body.updatedAt], "run");
        return json({ ok: true, updatedAt: body.updatedAt });
      }
    }

    return json({ error: "Endpoint tidak dikenal. Yang ada: GET /tickets, POST /worklog, GET/PUT /state, GET/PUT /priority-snapshot." }, 404);
}
