// jira.js — integrasi Jira: autolink kode tiket, inbox "belum diambil",
// impor tempel-manual, dan sinkronisasi otomatis lewat proxy Cloudflare Worker
// (lihat worker/README.md). Kunci localStorage: catet.jira.v1.
"use strict";

/* ---------- Jira: autolink + inbox tiket ---------- */
const JIRA_KEY_STORE = "catet.jira.v1";
const READY_NOTIFICATIONS_KEY = "catet.readyNotifications.v1";
const JIRA_RE = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g;
let jira = (() => {
  try {
    const j = JSON.parse(localStorage.getItem(JIRA_KEY_STORE));
    if (j && typeof j === "object" && Array.isArray(j.items)) return j;
  } catch {}
  return { site: "https://erafone.atlassian.net", items: [] };
})();
// Lengkapi field yang belum ada di skema lama. WAJIB dipanggil bukan hanya
// saat muat awal, tapi juga SETIAP objek jira diganti utuh dengan data dari
// luar (terapkanRemote saat sinkron) — state di server bisa ditulis oleh
// versi/perangkat lama tanpa field ini, dan render (mis. cocokBau) crash
// kalau strukturnya bolong: tugas-tugas jadi tak tampil sama sekali.
function normalisasiJira(j) {
  j.proxy = j.proxy || "";
  j.key = j.key || "";
  j.calIcs = j.calIcs || ""; // secret iCal URL, disimpan per perangkat
  j.dismissed = j.dismissed || [];
  // Dependensi tiket dev per key tiket QA: native Jira + hasil matcher CATET.
  j.deps = j.deps || {};
  j.depOverrides = j.depOverrides || {}; // pilihan manual QA key → dev key
  j.depSuggestions = j.depSuggestions || {};
  j.depWarnings = Array.isArray(j.depWarnings) ? j.depWarnings : [];
  j.pairingIssues = Array.isArray(j.pairingIssues) ? j.pairingIssues : [];
  let readyState = j.readyNotifications;
  try {
    const localReady = JSON.parse(localStorage.getItem(READY_NOTIFICATIONS_KEY));
    if (localReady && Number(localReady.lastObservedAt || 0) > Number((readyState || {}).lastObservedAt || 0)) readyState = localReady;
  } catch {}
  j.readyNotifications = typeof CatetReadyNotifications !== "undefined"
    ? CatetReadyNotifications.normalize(readyState)
    : (readyState || { initialized: false, readiness: {}, items: {} });
  j.items = Array.isArray(j.items) ? j.items : [];
  // Topik BAU (Business as Usual): tiket "wadah worklog" di project khusus
  // (mis. TDBU) untuk kerjaan di luar task sprint — meeting, deployment, dst.
  // alias = pemetaan manual "teks → key topik" yang diingat, supaya entri
  // berulang (mis. rutinitas "daily standup") cukup dipilihkan sekali.
  j.bau = j.bau || {};
  j.bau.project = j.bau.project || "";
  j.bau.items = Array.isArray(j.bau.items) ? j.bau.items : [];
  j.bau.alias = j.bau.alias || {};
  return j;
}
normalisasiJira(jira);

// Data Catet bersifat per akun. Tanpa kode akses, jangan biarkan cache akun
// sebelumnya tetap terlihat atau nanti ikut terunggah ke akun lain. Preferensi
// perangkat (tab aktif, reminder, dsb.) sengaja tidak ikut dihapus.
function kosongkanDataLokalTanpaAkses() {
  const proxy = jira.proxy || ""; // Worker custom tetap diperlukan untuk signup/sign in.
  for (const key of [
    "catet.tasks.v1", "catet.worklog.v1", "catet.routines.v1",
    "catet.routineday.v1", "catet.sprints.v1", "catet.dirty.v1",
    "catet.dirtyAt.v1", "catet.syncAt.v1", "catet.synced.v1",
    READY_NOTIFICATIONS_KEY,
  ]) localStorage.removeItem(key);

  tasks = [];
  worklog = [];
  routines = [];
  rday = null;
  sprints = { list: [], aktif: null };
  jira = normalisasiJira({ site: "", proxy, key: "", calIcs: "", items: [] });
  localStorage.setItem(JIRA_KEY_STORE, JSON.stringify(jira));

  // Variabel berikut baru tersedia setelah semua script selesai dimuat;
  // cabang ini dipakai saat sign out tanpa perlu menggandakan fungsi reset.
  if (typeof dailyPriority !== "undefined") dailyPriority = null;
  if (typeof calEvents !== "undefined") calEvents = null;
  if (typeof gridEvents !== "undefined") gridEvents = [];
  if (typeof calAktif !== "undefined") calAktif = false;
  if (typeof lapJira !== "undefined") lapJira = null;
}
if (!jira.key.trim()) kosongkanDataLokalTanpaAkses();
// tanpaDirty=true untuk penyegaran MESIN (tarikan tiket/topik berkala,
// rapikan inbox): tiap perangkat menariknya sendiri dari Jira, jadi tak
// perlu mendorong state — dan tidak boleh, karena flag dirty membuat
// perangkat mendorong seluruh state (termasuk tasks yang mungkin basi)
// alih-alih menarik: tugas yang sudah selesai di perangkat lain bisa
// "hidup lagi" ditimpa tab lama yang jalan di latar.
function saveJira(tanpaDirty) {
  localStorage.setItem(JIRA_KEY_STORE, JSON.stringify(jira));
  if (!tanpaDirty && typeof syncDirty === "function") syncDirty();
}
function saveReadyNotificationsLocal() {
  jira.readyNotifications = CatetReadyNotifications.normalize(jira.readyNotifications);
  localStorage.setItem(READY_NOTIFICATIONS_KEY, JSON.stringify(jira.readyNotifications));
}
function jiraSite() { return (jira.site || "").trim().replace(/\/+$/, ""); }
function jiraUrl(key) { return jiraSite() + "/browse/" + key; }

// Ubah kode tiket dalam teks jadi link ke Jira. Mengembalikan node-node DOM
// (bukan innerHTML) supaya teks pengguna tidak pernah dieksekusi sebagai HTML.
function linkify(text) {
  const frag = document.createDocumentFragment();
  if (!jiraSite()) { frag.append(text); return frag; }
  let last = 0;
  for (const m of text.matchAll(JIRA_RE)) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    const a = document.createElement("a");
    a.href = jiraUrl(m[1]); a.target = "_blank"; a.rel = "noopener";
    a.textContent = m[1];
    frag.append(a);
    last = m.index + m[1].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

// Impor menerima: JSON {site?, items:[{key,summary,status?}]}, JSON array,
// atau baris teks "KEY ringkasan".
function parseJiraImport(raw) {
  raw = raw.trim();
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    const arr = Array.isArray(j) ? j : (Array.isArray(j.items) ? j.items : null);
    if (arr) {
      if (!Array.isArray(j) && typeof j.site === "string" && j.site.trim()) jira.site = j.site.trim();
      return arr
        .filter((x) => x && typeof x.key === "string" && typeof x.summary === "string")
        .map((x) => ({ key: x.key.toUpperCase(), summary: x.summary, status: typeof x.status === "string" ? x.status : null }));
    }
  } catch {}
  const out = [];
  for (const line of raw.split("\n")) {
    const m = line.trim().match(/^([A-Za-z][A-Za-z0-9]{1,9}-\d+)[\s:—-]+(.+)$/);
    if (m) out.push({ key: m[1].toUpperCase(), summary: m[2].trim(), status: null });
  }
  return out;
}
function importJira(raw) {
  const parsed = parseJiraImport(raw);
  let added = 0;
  for (const p of parsed) {
    const dup = jira.items.some((x) => x.key === p.key) ||
      tasks.some((t) => t.status !== "selesai" && t.text.includes(p.key));
    if (!dup) { jira.items.push({ id: uid(), ...p, addedAt: new Date().toISOString() }); added++; }
  }
  saveJira();
  return { parsed: parsed.length, added };
}
// "Ambil" — geser tiket dari inbox Jira ke papan utama sebagai tugas biasa.
// Key-nya masuk daftar dismissed supaya sinkronisasi tidak memunculkannya lagi.
// sprintId opsional: tombol "＋ Sprint" mengisikan sprint aktif.
function takeJiraItem(item, sprintId) {
  tasks.push({
    id: uid(), text: item.key + " — " + item.summary, priority: "sedang", due: null,
    createdAt: new Date().toISOString(),
    status: "aktif", doneAt: null, focusedAt: null, notified: false,
    sprintId: sprintId || null,
    sprintManual: sprintId ? true : undefined, // pilihan user menang atas sync sprint Jira
  });
  jira.items = jira.items.filter((x) => x.id !== item.id);
  if (!jira.dismissed.includes(item.key)) jira.dismissed.push(item.key);
  save(); saveJira();
}

// Bereskan inbox: tiket yang sudah jadi tugas aktif (sudah diambil / masuk
// sprint) tak boleh ikut nampang di daftar "belum diambil". Bisa nyangkut
// karena race sinkron antar perangkat — mis. satu perangkat mengambil tiket
// sementara perangkat lain masih memegang salinan inbox lama, lalu keduanya
// bergabung. Kembalikan true kalau ada yang dibersihkan (perlu disimpan).
function rapikanInbox() {
  const aktif = new Set();
  for (const t of tasks) {
    if (t.status === "selesai") continue;
    for (const m of t.text.matchAll(JIRA_RE)) aktif.add(m[1]);
  }
  const nyangkut = jira.items.filter((x) => aktif.has(x.key));
  if (!nyangkut.length) return false;
  jira.items = jira.items.filter((x) => !aktif.has(x.key));
  for (const x of nyangkut) if (!jira.dismissed.includes(x.key)) jira.dismissed.push(x.key);
  return true;
}

/* ---------- fokus/selesai → status tiket Jira ikut ----------
   Tugas dari tiket Jira: difokuskan → tiket jadi In Progress; diselesaikan →
   tiket jadi Done. Sekali per tugas per target (flag jiraInProgress/jiraDone);
   best-effort — gagal ringan melepas flag agar bisa dicoba lagi. Worker tak
   pernah memundurkan status. */
async function transisiJira(t, target) {
  const flag = target === "done" ? "jiraDone" : "jiraInProgress";
  if (!t || t[flag] || !jiraProxy()) return;
  const m = t.text.match(JIRA_RE);
  if (!m) return;
  t[flag] = true; saveTanpaSinkron(); // optimistik — jangan spam
  try {
    const r = await fetch(jiraProxy() + "/transition", {
      method: "POST", headers: { "Content-Type": "application/json", ...headerAkses() },
      body: JSON.stringify({ key: m[0], target: target || "inprogress" }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false) throw new Error(d.error || ("HTTP " + r.status));
    const it = jira.items.find((x) => x.key === m[0]); // segarkan status di inbox
    if (it && d.status) { it.status = d.status; saveJira(true); }
    if (view === "papan" || view === "jira") render();
  } catch (e) {
    t[flag] = false; saveTanpaSinkron(); // izinkan dicoba lagi
  }
}
function transisiJiraInProgress(t) { return transisiJira(t, "inprogress"); }

/* ---------- dependensi tiket dev (QA menunggu dev done) ---------- */
function depsTiket(key) { return (key && jira.deps && jira.deps[key]) || null; }
// Untuk tugas papan: dependensi key tiket pertama di teks tugas.
function depsTugas(t) {
  const m = t && t.text ? t.text.match(JIRA_RE) : null;
  return m ? depsTiket(m[0]) : null;
}
function warningTiket(key) {
  return (jira.depWarnings || []).find((x) => x && x.key === key) || null;
}
function suggestionTiket(key) { return jira.depSuggestions && jira.depSuggestions[key] || null; }

function metadataReady(feed) {
  const result = {};
  const sprintMeta = new Map();
  for (const issue of jira.pairingIssues || []) {
    sprintMeta.set(issue.key, {
      summary: issue.summary || "", status: issue.status || "",
      sprintId: issue.sprintId || null, sprintName: issue.sprintName || null,
    });
  }
  for (const issue of feed || []) {
    const sprint = issue.sprint || {};
    result[issue.key] = {
      summary: issue.summary || "", status: issue.status || "",
      sprintId: sprint.jiraId == null ? null : sprint.jiraId,
      sprintName: sprint.name || null,
    };
  }
  for (const [key, meta] of sprintMeta) result[key] = { ...(result[key] || {}), ...meta };
  for (const task of tasks) {
    const match = String(task.text || "").match(JIRA_RE);
    if (!match || result[match[0]]) continue;
    const sprint = (sprints.list || []).find((item) => String(item.id) === String(task.sprintId));
    result[match[0]] = {
      summary: String(task.text || "").replace(match[0], "").replace(/^\s*[—:-]\s*/, ""),
      status: task.status || "", sprintId: task.sprintId || null,
      sprintName: sprint && sprint.nama || null,
    };
  }
  return result;
}

function rekonsiliasiReadyNotifications(feed, nowMs) {
  const result = CatetReadyNotifications.reconcile(
    jira.readyNotifications, jira.deps, metadataReady(feed), nowMs
  );
  jira.readyNotifications = result.state;
  saveReadyNotificationsLocal();
  return result.added;
}

function readyNotificationsAktif() {
  return CatetReadyNotifications.visible(jira.readyNotifications);
}

function renderReadyNotifications() {
  const button = $("#ready-alert-btn");
  const panel = $("#ready-alert-panel");
  const list = $("#ready-alert-list");
  if (!button || !panel || !list) return;
  const items = readyNotificationsAktif();
  button.hidden = items.length === 0;
  $("#ready-alert-count").textContent = String(items.length);
  button.setAttribute("aria-label", items.length + " tiket baru siap dites");
  if (!items.length) {
    panel.classList.add("hidden");
    button.setAttribute("aria-expanded", "false");
    list.innerHTML = "";
    return;
  }
  list.innerHTML = "";
  for (const item of items) {
    const row = el("article", "ready-alert-item");
    const main = el("div", "ready-alert-main");
    const top = el("div", "ready-alert-item-top");
    const link = el("a", "jira-key", item.key);
    link.href = jiraUrl(item.key); link.target = "_blank"; link.rel = "noopener noreferrer";
    top.append(link, el("span", "ready-alert-age", fmtAgo(new Date(item.readyAt).toISOString())));
    main.append(top, el("div", "ready-alert-summary", item.summary || "Tiket QA siap dites"));
    const meta = el("div", "ready-alert-meta");
    meta.append(el("span", "effort-badge dep-ready", "Ready to test"));
    meta.append(el("span", "ready-alert-scope", item.sprintName ? item.sprintName : "Non-sprint"));
    if (item.devKeys && item.devKeys.length) meta.append(el("span", "ready-alert-scope", "Dev " + item.devKeys.join(", ")));
    main.append(meta);
    row.append(main);
    list.append(row);
  }
}
function warningBadge(w) {
  const label = w.type === "dev-missing-qa" ? "⚠ QA ticket belum ditemukan"
    : w.type === "qa-ambiguous" ? "⚠ pilih tiket dev" : "⚠ dev ticket belum ditemukan";
  const b = el("span", "effort-badge dep-warning", label);
  b.title = w.message || label;
  return b;
}
function terapkanHasilPasangan(result, nativeDeps) {
  const next = { ...(nativeDeps || {}) };
  const nativeKeys = new Set(Object.keys(next));
  const nativeDevKeys = new Set(Object.values(next).flatMap((dep) => dep && Array.isArray(dep.keys) ? dep.keys : []));
  for (const [key, dep] of Object.entries(next)) dep.source = "jira-native";
  for (const m of result.matches || []) {
    if (next[m.qaKey]) continue; // relasi eksplisit Jira selalu menang
    next[m.qaKey] = {
      ready: !!m.done, keys: [m.devKey], source: m.source,
      readyAt: m.done ? (m.doneAt || null) : null,
      wait: m.done ? [] : [{ key: m.devKey, status: m.status || "?" }],
      evidence: m.evidence || [], score: m.score || null,
    };
  }
  jira.deps = next;
  jira.depSuggestions = {};
  for (const s of (result.suggestions || []).filter((s) => !nativeKeys.has(s.qaKey))) jira.depSuggestions[s.qaKey] = s;
  jira.depWarnings = (result.warnings || []).filter((w) => !nativeKeys.has(w.key) && !nativeDevKeys.has(w.key));
}
function hitungPasangan(nativeDeps) {
  if (typeof CatetDependencyMatcher !== "object") return;
  // Scope pairing hanya sprint aktif Jira yang benar-benar ada di Catet.
  // Jangan audit backlog atau tiket non-sprint — itu sumber spam, bukan insight.
  const sprintIds = new Set((sprints.list || []).filter((s) => s.auto && s.jiraId != null)
    .map((s) => String(s.jiraId)));
  const sprintIssues = (jira.pairingIssues || [])
    .filter((i) => i.sprintId && sprintIds.has(String(i.sprintId)));
  const result = CatetDependencyMatcher.matchSprintIssues(sprintIssues, { overrides: jira.depOverrides });
  terapkanHasilPasangan(result, nativeDeps || Object.fromEntries(
    Object.entries(jira.deps || {}).filter(([, dep]) => dep && dep.source === "jira-native")));
}
function pilihDependency(qaKey, devKey) {
  jira.depOverrides[qaKey] = devKey;
  hitungPasangan(); saveJira(); render();
}
function hapusPilihanDependency(qaKey) {
  delete jira.depOverrides[qaKey];
  hitungPasangan(); saveJira(); render();
}
async function uploadDependencyKeJira(qaKey, button) {
  const devKey = jira.depOverrides[qaKey];
  if (!devKey || !jiraProxy()) return;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Mengunggah…";
  try {
    const r = await fetch(jiraProxy() + "/pairing-link", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headerAkses() },
      body: JSON.stringify({ qaKey, devKey }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false || !d.verified) throw new Error(d.error || ("HTTP " + r.status));
    jira.deps[qaKey] = { keys: [devKey], done: false, source: "jira-native" };
    delete jira.depSuggestions[qaKey];
    jira.depWarnings = (jira.depWarnings || []).filter((w) => w.key !== qaKey && w.key !== devKey);
    saveJira(true);
    button.textContent = d.alreadyLinked ? "Sudah ada di Jira" : "Terunggah ke Jira";
    button.classList.add("uploaded");
    setTimeout(() => syncJira(true), 300);
  } catch (e) {
    button.disabled = false;
    button.textContent = label;
    alert("Gagal upload pairing ke Jira: " + (e && e.message ? e.message : "koneksi"));
  }
}
function dependencyReview(key) {
  const sug = suggestionTiket(key), manual = jira.depOverrides[key];
  if (!sug && !manual) return null;
  const native = depsTiket(key);
  const sudahNative = !!(manual && native && native.source === "jira-native" &&
    Array.isArray(native.keys) && native.keys.includes(manual));
  const box = el("div", "dep-review");
  if (sug && Array.isArray(sug.candidates)) {
    box.append(el("span", "dep-review-label", "Pilih tiket dev"));
    for (const c of sug.candidates) {
      const b = el("button", "btn-line dep-candidate", c.key);
      b.append(el("span", "dep-score mono", String(c.score)));
      b.title = (c.summary || c.key) + (c.evidence && c.evidence.length ? " — " + c.evidence.join("; ") : "");
      b.onclick = () => pilihDependency(key, c.key);
      box.append(b);
    }
  }
  if (manual) {
    box.append(el("span", "dep-review-label", "Terpilih: " + manual));
    if (sudahNative) {
      const synced = el("span", "effort-badge dep-ready", "✓ Ada di Jira");
      synced.title = "Pasangan ini sudah tersimpan sebagai native issue link Jira";
      box.append(synced);
    } else {
      const upload = el("button", "btn-solid dep-upload", "Upload ke Jira");
      upload.title = "Buat native Relates issue link di Jira untuk pasangan ini";
      upload.onclick = () => uploadDependencyKeJira(key, upload);
      box.append(upload);
    }
    const reset = el("button", "btn-line", "Reset");
    reset.title = "Hapus pilihan manual dan hitung ulang";
    reset.onclick = () => hapusPilihanDependency(key);
    box.append(reset);
  }
  return box;
}
function pairingTicketRow(w, actionable) {
  const row = el("div", "pairing-ticket" + (actionable ? " actionable" : ""));
  const main = el("div", "pairing-ticket-main");
  if (jiraSite()) {
    const a = el("a", "jira-key", w.key);
    a.href = jiraUrl(w.key); a.target = "_blank"; a.rel = "noopener";
    main.append(a);
  } else main.append(el("span", "jira-key", w.key));
  main.append(el("span", "pairing-ticket-title", w.summary || ""));
  if (!actionable) main.append(warningBadge(w));
  row.append(main);
  const review = actionable ? dependencyReview(w.key) : null;
  if (review) row.append(review);
  return row;
}
function warningsUntukSprint(s) {
  if (!s || !s.auto || s.jiraId == null) return [];
  return (jira.depWarnings || []).filter((w) => w.sprintId != null && String(w.sprintId) === String(s.jiraId));
}
function renderSprintPairing(s) {
  const warnings = warningsUntukSprint(s);
  if (!warnings.length) return null;
  const actionable = warnings.filter((w) => w.type === "qa-ambiguous");
  const audit = warnings.filter((w) => w.type !== "qa-ambiguous");
  const wrap = el("div", "pairing-sprint-review");

  if (actionable.length) {
    const actionCard = el("div", "pairing-card");
    actionCard.append(el("div", "pairing-card-label", "Ticket pairing · perlu keputusanmu"));
    for (const w of actionable) actionCard.append(pairingTicketRow(w, true));
    wrap.append(actionCard);
  }

  if (audit.length) {
    const details = document.createElement("details");
    details.className = "pairing-audit";
    const label = document.createElement("summary");
    label.append("Tiket sprint tanpa pasangan ", el("span", "count mono", String(audit.length)));
    details.append(label);
    const list = el("div", "pairing-audit-list");
    for (const w of audit) list.append(pairingTicketRow(w, false));
    details.append(list);
    wrap.append(details);
  }
  return wrap;
}
// Badge "✅ ready to test" / "⏳ dev: KEY" — dipakai papan, inbox Jira, dan
// item sprint. Bisa diklik → buka tiket dev-nya di Jira (kalau key & site ada;
// data lama tanpa `keys` jatuh ke span biasa sampai sinkron berikutnya).
function depBadge(dep) {
  const kelas = dep.ready ? "effort-badge dep-ready" : "effort-badge dep-wait";
  const label = dep.ready ? "✅ ready to test" : "⏳ dev: " + dep.wait[0].key;
  const key = dep.ready ? (dep.keys || [])[0] : dep.wait[0].key;
  const title = dep.ready
    ? "Tiket dev" + (dep.keys && dep.keys.length ? " " + dep.keys.join(", ") : "") +
      " sudah Done — siap dites, otomatis masuk “Do today”."
    : "Menunggu " + dep.wait.map((x) => x.key + " (" + x.status + ")").join(", ");
  if (key && jiraSite()) {
    const a = el("a", kelas, label);
    a.href = jiraUrl(key); a.target = "_blank"; a.rel = "noopener";
    a.title = title + " Klik untuk buka " + key + " di Jira.";
    a.onclick = (e) => e.stopPropagation(); // jangan memicu aksi baris di belakangnya
    return a;
  }
  const b = el("span", kelas, label);
  b.title = title;
  return b;
}

/* ---------- sinkronisasi otomatis lewat proxy (Cloudflare Worker) ---------- */
// Alamat Worker mentah hanya dipakai oleh alur autentikasi (mis. /signup).
// Endpoint data memakai jiraProxy(), yang sengaja kosong sebelum access code
// terpasang agar tidak ada sync anonim ke Cloudflare.
const DEFAULT_PROXY = "https://catet-jira-proxy.zackyanto-leo.workers.dev";
function workerUrl() { return (jira.proxy || DEFAULT_PROXY).trim().replace(/\/+$/, ""); }
function jiraProxy() { return jira.key && jira.key.trim() ? workerUrl() : ""; }
// Kode akses (multi-user; per perangkat, tidak ikut sinkron) — dikirim di
// semua permintaan data ke Worker.
function headerAkses() { return jira.key ? { "X-Catet-Key": jira.key } : {}; }
let jiraSyncMsg = "";
let jiraSyncing = false;
async function syncJira(manual) {
  if (!jiraProxy()) {
    if (manual) alert("Isi dulu alamat proxy + kunci di panel “impor tiket” (lihat worker/README.md di repo).");
    return;
  }
  if (jiraSyncing) return;
  jiraSyncing = true;
  jiraSyncMsg = "fetching…";
  if (view === "papan" || view === "jira") render();
  try {
    // Kirim key tugas papan yang masih aktif — Worker melaporkan statusnya,
    // supaya tugas yang tiketnya sudah Done via Jira ditutup otomatis di bawah.
    const papanKeys = [...new Set(tasks.filter((t) => t.status !== "selesai")
      .flatMap((t) => { const m = t.text.match(JIRA_RE); return m ? [m[0]] : []; }))].slice(0, 50);
    const qs = papanKeys.length ? "?keys=" + encodeURIComponent(papanKeys.join(",")) : "";
    const r = await fetch(jiraProxy() + "/tickets" + qs, { headers: headerAkses() });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
    if (typeof data.site === "string" && data.site) jira.site = data.site;
    const feed = Array.isArray(data.items) ? data.items : [];
    const feedKeys = new Set(feed.map((f) => f.key));
    for (const f of feed) {
      if (jira.dismissed.includes(f.key)) continue;
      if (tasks.some((t) => t.status !== "selesai" && t.text.includes(f.key))) continue;
      const ex = jira.items.find((x) => x.key === f.key);
      if (ex) { ex.summary = f.summary; ex.status = f.status; ex.created = f.created || ex.created; }
      else jira.items.push({ id: uid(), key: f.key, summary: f.summary, status: f.status, created: f.created || null, src: "sync", addedAt: new Date().toISOString() });
    }
    // Relasi eksplisit Jira tetap source of truth. Matcher deterministic hanya
    // mengisi tiket yang belum punya issue link/key di description.
    const nativeDeps = {};
    for (const f of feed) {
      if (Array.isArray(f.deps) && f.deps.length) {
        nativeDeps[f.key] = {
          ready: f.deps.every((d) => d.done),
          readyAt: f.deps.every((d) => d.done)
            ? f.deps.map((d) => d.doneAt).filter(Boolean).sort().at(-1) || null
            : null,
          keys: f.deps.map((d) => d.key),
          wait: f.deps.filter((d) => !d.done).map((d) => ({ key: d.key, status: d.status })),
          source: "jira-native",
        };
      }
    }
    jira.pairingIssues = Array.isArray(data.pairingIssues) ? data.pairingIssues : [];
    hitungPasangan(nativeDeps);
    rekonsiliasiReadyNotifications(feed);
    // Tiket hasil sinkron yang sudah tidak muncul di Jira (selesai/di-reassign)
    // ikut hilang; tiket hasil impor manual dibiarkan.
    jira.items = jira.items.filter((x) => x.src !== "sync" || feedKeys.has(x.key));
    // Pangkas daftar dismissed: key yang tak ada lagi di feed berarti tiketnya
    // sudah Done/di-reassign dan tak mungkin muncul lagi — tak perlu diingat
    // selamanya (daftar ini tumbuh tanpa batas setiap tiket diambil/dibuang).
    // Hanya saat feed berisi, supaya respons kosong yang janggal tidak
    // menghapus penjaga untuk tiket yang sebenarnya masih terbuka.
    if (feed.length) jira.dismissed = jira.dismissed.filter((k) => feedKeys.has(k));
    rapikanInbox(); // buang tiket yang sudah jadi tugas aktif
    // Tugas papan yang tiketnya sudah Done di Jira → tandai selesai otomatis
    // (masuk lipatan Done + tercatat di log kerja), tanpa klaim dirty.
    // Tanggal selesai memakai resolutiondate Jira — tiket lama yang baru
    // terdeteksi tidak boleh menumpuk di log "hari ini".
    if (data.keyStatus) {
      let selaras = false;
      for (const t of [...tasks]) {
        const m = t.text.match(JIRA_RE);
        const st = m ? data.keyStatus[m[0]] : null;
        if (!st || !st.done) continue;
        if (t.status !== "selesai") {
          completeTask(t, true, st.doneAt || null);
          t.logSelaras = true; selaras = true;
        } else if (!t.logSelaras && st.doneAt) {
          // Perbaikan satu kali untuk korban penutupan bertanggal salah:
          // entri log tanpa menit fokus dipindah ke tanggal Done Jira.
          // Sekali saja (logSelaras) — jangan melawan editan manual pengguna.
          const e = worklog.find((x) => x.taskId === t.id);
          const tglJira = localDateStr(new Date(st.doneAt));
          if (e && !e.mins && e.date !== tglJira) {
            e.ts = st.doneAt; e.date = tglJira;
            t.doneAt = st.doneAt;
            saveWorklogTanpaSinkron();
          }
          t.logSelaras = true; selaras = true;
        }
      }
      if (selaras) saveTanpaSinkron();
    }
    // Sprint otomatis dari Jira (tak perlu dibuat manual lagi).
    if (feed.length && typeof rekonsiliasiSprintJira === "function") rekonsiliasiSprintJira(feed);
    jira.lastSync = new Date().toISOString();
    jiraSyncMsg = "";
    saveJira(true); // penyegaran mesin — jangan klaim dirty
    syncBau(false); // topik BAU ikut segar (throttle 6 jam di dalamnya)
  } catch (e) {
    jiraSyncMsg = "failed: " + (e && e.message ? e.message : "koneksi");
  }
  jiraSyncing = false;
  if (view === "papan" || view === "jira") render();
}

/* ---------- topik BAU: worklog di luar task sprint ---------- */
let bauSyncMsg = "";
let bauSyncing = false;
async function syncBau(manual) {
  const proj = (jira.bau.project || "").trim().toUpperCase();
  if (!jiraProxy() || !proj) return;
  // Topik jarang berubah — otomatis cukup sekali per 6 jam; manual selalu boleh.
  if (!manual && jira.bau.lastSync && Date.now() - new Date(jira.bau.lastSync) < 6 * 3600000) return;
  if (bauSyncing) return;
  bauSyncing = true;
  bauSyncMsg = "fetching…";
  if (view === "jira") render();
  try {
    const r = await fetch(jiraProxy() + "/bau?project=" + encodeURIComponent(proj), { headers: headerAkses() });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
    jira.bau.items = Array.isArray(data.items) ? data.items : [];
    jira.bau.lastSync = new Date().toISOString();
    bauSyncMsg = "";
    saveJira(true); // penyegaran mesin — jangan klaim dirty
  } catch (e) {
    bauSyncMsg = "failed: " + (e && e.message ? e.message : "koneksi");
  }
  bauSyncing = false;
  if (view === "jira") render();
}

// Cari topik BAU untuk sebuah teks tugas/log. Urutan: (1) alias — pemetaan
// manual yang pernah dipilih untuk teks persis sama; (2) nama topik yang
// terkandung di teks (case-insensitive), pilih yang paling spesifik (nama
// terpanjang). Teks yang sudah memuat key tiket eksplisit tidak dicocokkan —
// worklognya sudah punya tujuan.
function cocokBau(text) {
  if (!jira.bau || !Array.isArray(jira.bau.items) || !jira.bau.items.length) return null;
  if ((text.match(JIRA_RE) || []).length) return null;
  const alias = jira.bau.alias[text.trim().toLowerCase()];
  if (alias) {
    const b = jira.bau.items.find((x) => x.key === alias);
    if (b) return b;
  }
  const lo = text.toLowerCase();
  let best = null;
  for (const b of jira.bau.items) {
    const s = (b.summary || "").trim().toLowerCase();
    if (s.length >= 3 && lo.includes(s) && (!best || s.length > best._len)) {
      best = { key: b.key, summary: b.summary, _len: s.length };
    }
  }
  return best ? { key: best.key, summary: best.summary } : null;
}
function bauByKey(key) { return (jira.bau && Array.isArray(jira.bau.items) ? jira.bau.items : []).find((x) => x.key === key) || null; }

// Menu pilih topik BAU (pola sama dengan menu sprint; memakai CSS-nya juga).
// onPick(key) — key topik, atau null untuk "kembali ke otomatis".
let bauMenuEl = null;
function tutupBauMenu() {
  if (bauMenuEl) { bauMenuEl.remove(); bauMenuEl = null; }
  document.removeEventListener("mousedown", onDocBauMenu, true);
  document.removeEventListener("keydown", onDocBauMenu, true);
}
function onDocBauMenu(e) {
  if (e.type === "keydown" && e.key !== "Escape") return;
  if (e.type === "mousedown" && bauMenuEl && bauMenuEl.contains(e.target)) return;
  tutupBauMenu();
}
function bukaBauMenu(anchor, currentKey, onPick) {
  tutupBauMenu();
  tutupSprintMenu();
  const menu = el("div", "sprint-menu bau-menu");
  bauMenuEl = menu;
  const pilih = (key) => (ev) => { ev.stopPropagation(); tutupBauMenu(); onPick(key); };

  // Daftar topik bisa puluhan (satu board BAU penuh) — kolom cari di atas,
  // daftarnya di area ber-scroll, tombol reset menetap di bawah.
  const cari = document.createElement("input");
  cari.type = "search"; cari.placeholder = "Search topics…";
  cari.className = "bau-menu-cari";
  cari.setAttribute("aria-label", "Cari topik BAU");
  menu.append(cari);
  const list = el("div", "bau-menu-list");
  menu.append(list);
  const isiDaftar = () => {
    list.textContent = "";
    const q = cari.value.trim().toLowerCase();
    const cocok = jira.bau.items.filter((b) =>
      !q || (b.key + " " + b.summary).toLowerCase().includes(q));
    for (const b of cocok) {
      const item = el("button", "sprint-menu-item" + (currentKey === b.key ? " aktif" : ""));
      item.append(el("span", "sprint-menu-tick", currentKey === b.key ? "✓" : ""));
      item.append(el("span", null, b.key + " — " + b.summary));
      item.onclick = pilih(b.key);
      list.append(item);
    }
    if (!cocok.length) list.append(el("div", "bau-menu-kosong", "Tidak ada topik yang cocok."));
  };
  isiDaftar();
  cari.oninput = isiDaftar;
  // Enter = pilih hasil teratas — ketik "deploy" ↵ selesai.
  cari.onkeydown = (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      const first = list.querySelector(".sprint-menu-item");
      if (first) first.click();
    }
  };
  if (currentKey) {
    const reset = el("button", "sprint-menu-item danger");
    reset.append(el("span", "sprint-menu-tick", ""));
    reset.append(el("span", null, "↺ Back to auto-match"));
    reset.onclick = pilih(null);
    menu.append(reset);
  }
  document.body.append(menu);
  // Autofokus ke kolom cari hanya di perangkat berkursor — di HP, keyboard
  // yang langsung muncul justru menutupi daftarnya.
  if (matchMedia("(pointer: fine)").matches) cari.focus();
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = r.left;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  menu.style.left = Math.max(8, left) + "px";
  const top = (r.bottom + 4 + mh > window.innerHeight - 8 && r.top - mh - 4 > 8)
    ? r.top - mh - 4 : r.bottom + 4;
  menu.style.top = top + "px";
  setTimeout(() => {
    document.addEventListener("mousedown", onDocBauMenu, true);
    document.addEventListener("keydown", onDocBauMenu, true);
  }, 0);
}

// Section "Topik BAU" di tab Jira: set project + daftar topik hasil tarikan.
function renderBauSection(wrap) {
  const sec = el("section", "section s-jira");
  sec.style.marginTop = "18px";
  const head = el("div", "section-head");
  head.append(el("h2", null, "BAU topics — non-sprint worklog"));
  if (jira.bau.items.length) head.append(el("span", "count mono", String(jira.bau.items.length)));
  if (jiraProxy() && jira.bau.project) {
    const refresh = el("button", "clear-done", bauSyncing ? "fetching…" : "⟳ fetch topics");
    refresh.onclick = () => syncBau(true);
    head.append(refresh);
    if (bauSyncMsg && !bauSyncing) head.append(el("span", "count", bauSyncMsg));
    else if (jira.bau.lastSync && !bauSyncing) head.append(el("span", "count mono", "synced " + fmtAgo(jira.bau.lastSync)));
  }
  sec.append(head);

  const det = document.createElement("details");
  det.className = "routine-manage";
  det.open = !jira.bau.project; // belum diset → langsung terbuka
  const sum = document.createElement("summary");
  sum.textContent = jira.bau.project ? "BAU topic settings" :
    "+ set BAU project (mis. TDBU) — worklog meeting/deployment/dll. di luar sprint";
  det.append(sum);
  const editor = el("div", "routine-editor");
  const form = el("div", "routine-form");
  const projIn = document.createElement("input");
  projIn.type = "text"; projIn.value = jira.bau.project || "";
  projIn.placeholder = "BAU project key… mis. TDBU";
  projIn.title = "Project Jira berisi tiket topik (Team Meeting, Deployment, dst.)";
  const setBtn = el("button", "btn-solid", "Save & fetch topics");
  setBtn.onclick = () => {
    jira.bau.project = projIn.value.trim().toUpperCase();
    jira.bau.lastSync = null;
    saveJira();
    if (jira.bau.project) syncBau(true); else render();
  };
  projIn.onkeydown = (e) => { if (e.key === "Enter") setBtn.onclick(); };
  form.append(projIn, setBtn);
  editor.append(form);
  editor.append(el("div", "cap-hint",
    "Tugas yang judulnya memuat nama topik (mis. “Deployment ccm”) otomatis nyantol ke tiketnya (mis. TDBU-28 Deployment) — lihat badge 🏢 di tugas, lalu kirim worklognya dari tab Log kerja. Salah cocok? Pilih manual lewat tombol 🏢 di entri log."));
  det.append(editor);
  sec.append(det);

  if (jira.bau.items.length) {
    const card = el("div", "routine-card");
    for (const b of jira.bau.items) {
      const row = el("div", "jira-row");
      row.append(el("span", "jira-key", b.key));
      row.append(el("span", "jira-summary", b.summary));
      if (b.type) row.append(el("span", "jira-status", b.type));
      card.append(row);
    }
    const det2 = document.createElement("details");
    det2.className = "routine-manage";
    const sum2 = document.createElement("summary");
    sum2.append("topic list ", el("span", "count mono", String(jira.bau.items.length)));
    det2.append(sum2, card);
    sec.append(det2);
  }
  wrap.append(sec);
}

// Section "Access": kode akses multi-user (disimpan per perangkat).
// Dirender di tab Settings (lihat settings.js), bukan tab Jira.
/* ---------- akun (kode akses = login) ----------
   Kode akses berfungsi sebagai login: kredensial Jira & iCal tersimpan di
   SERVER per akun, jadi di perangkat baru cukup sign in dengan kode — tak perlu
   isi ulang. profil = hasil GET /me (nama + status kredensial), ditarik sekali
   saat masuk tab. kodeBaru = kode hasil signup, ditampilkan sekali. */
let profil = null;
let profilAt = 0;
let profilLoading = false;
let kodeBaru = null;
async function tarikProfil(paksa) {
  if (!jira.key || !jiraProxy() || profilLoading) return;
  if (!paksa && profil && Date.now() - profilAt < 60000) return;
  profilLoading = true;
  try {
    const r = await fetch(jiraProxy() + "/me", { headers: headerAkses() });
    const d = await r.json().catch(() => ({}));
    profil = r.ok ? d : { error: d.error || ("HTTP " + r.status) };
    if (r.ok && d.jira_site) jira.site = d.jira_site;
  } catch (e) {
    profil = { error: (e && e.message) || "koneksi" };
  }
  profilAt = Date.now(); profilLoading = false;
  if (view === "jira" || view === "settings") render();
}
// Terapkan kode akses (sign in / ganti akun): pull state, tarik profil & tiket.
async function pakaiKode(kode) {
  jira.key = (kode || "").trim();
  saveJira(true); // kredensial perangkat, bukan perubahan data
  setSyncStatus(""); profil = null;
  await pullState(true);
  tarikProfil(true);
  syncJira(true);
  render();
}

function renderAksesSection(wrap) {
  const sec = el("section", "section s-jira");
  sec.style.marginTop = "18px";
  const head = el("div", "section-head");
  head.append(el("h2", null, "Account"));
  if (jira.key) head.append(el("span", "count mono",
    profil && profil.name ? "✓ " + profil.name : "✓ signed in"));
  sec.append(head);

  if (jira.key && jiraProxy()) tarikProfil(false);

  const det = document.createElement("details");
  det.className = "routine-manage";
  det.open = !jira.key; // belum sign in → panel terbuka biar kelihatan
  const sum = document.createElement("summary");
  sum.textContent = jira.key ? "account settings" : "+ sign in / create account";
  det.append(sum);
  const editor = el("div", "routine-editor");

  // Kode baru hasil signup — tampil sekali (di atas), harus disimpan.
  if (kodeBaru) editor.append(kotakKodeBaru());
  if (!jira.key) renderSignedOut(editor);
  else renderSignedIn(editor);

  det.append(editor);
  sec.append(det);
  wrap.append(sec);
}

// Kotak kode akses baru (hasil signup) — ditampilkan sekali, wajib disimpan.
function kotakKodeBaru() {
  const box = el("div", "kode-baru");
  box.append(el("div", "cap-label", "Your new access code — simpan!"));
  const row = el("div", "routine-form");
  const salin = el("button", "btn-line", "Copy");
  salin.onclick = () => copyText(kodeBaru, salin);
  row.append(el("code", "kode-baru-val", kodeBaru), salin);
  const tutup = el("button", "btn-line", "I saved it");
  tutup.onclick = () => { kodeBaru = null; render(); };
  row.append(tutup);
  box.append(row);
  box.append(el("div", "cap-hint",
    "Kode hanya ditampilkan sekali. Simpan baik-baik (mis. di password manager) — dipakai untuk sign in di semua perangkatmu."));
  return box;
}

// Belum sign in: form masuk (kode) + form buat akun (nama + passphrase).
function renderSignedOut(editor) {
  editor.append(el("div", "cap-label", "Sign in"));
  const form = el("div", "routine-form");
  const kodeIn = document.createElement("input");
  kodeIn.type = "password"; kodeIn.placeholder = "Access code";
  kodeIn.title = "Kode akunmu — identitas di server sinkronisasi";
  const simpan = el("button", "btn-solid", "Sign in");
  simpan.onclick = () => { if (kodeIn.value.trim()) pakaiKode(kodeIn.value); };
  kodeIn.onkeydown = (e) => { if (e.key === "Enter") simpan.onclick(); };
  form.append(kodeIn, simpan);
  editor.append(form);
  editor.append(el("div", "cap-hint",
    "Sekali sign in, kredensial Jira & kalender ikut dari server — di perangkat lain cukup kode ini, tak perlu isi ulang. Kosongkan kalau Worker-mu mode pribadi."));

  const daf = document.createElement("details");
  daf.className = "routine-manage"; daf.style.marginTop = "8px";
  const dsum = document.createElement("summary");
  dsum.textContent = "+ create account";
  daf.append(dsum);
  const df = el("div", "routine-form"); df.style.marginTop = "8px";
  const namaIn = document.createElement("input");
  namaIn.type = "text"; namaIn.placeholder = "Your name";
  const secretIn = document.createElement("input");
  secretIn.type = "password"; secretIn.placeholder = "Signup passphrase";
  secretIn.title = "Passphrase pendaftaran dari admin/tim";
  const buat = el("button", "btn-solid", "Create account");
  buat.onclick = async () => {
    if (!namaIn.value.trim()) { alert("Isi nama dulu."); return; }
    buat.disabled = true;
    try {
      const r = await fetch(workerUrl() + "/signup", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: namaIn.value.trim(), secret: secretIn.value }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
      kodeBaru = d.code;      // tampilkan sekali
      await pakaiKode(d.code); // langsung sign in dengan akun baru
    } catch (e) {
      alert("Gagal membuat akun: " + (e && e.message ? e.message : "koneksi"));
      buat.disabled = false;
    }
  };
  df.append(namaIn, secretIn, buat);
  daf.append(df);
  daf.append(el("div", "cap-hint",
    "Buat akunmu sendiri: butuh passphrase pendaftaran dari admin/tim. Setelah dibuat, kamu dapat kode akses untuk sign in."));
  editor.append(daf);
}

// Sudah sign in: identitas + status kredensial (tersimpan di server) + edit.
function renderSignedIn(editor) {
  const bar = el("div", "routine-form");
  bar.append(el("div", "cap-hint",
    profil && profil.name ? "Signed in as " + profil.name
    : profil && profil.error ? "Signed in (profil gagal dimuat: " + profil.error + ")"
    : "Signed in…"));
  const keluar = el("button", "btn-line", "Sign out");
  keluar.style.marginLeft = "auto";
  keluar.onclick = () => {
    if (!confirm("Sign out dari perangkat ini?\nCache data akun di browser ini akan dibersihkan; data di server tidak dihapus.")) return;
    kosongkanDataLokalTanpaAkses();
    profil = null; kodeBaru = null; setSyncStatus("");
    location.reload(); // batalkan request akun lama yang mungkin masih berjalan
  };
  bar.append(keluar);
  editor.append(bar);

  // Jira credentials — status + form ubah. Tersimpan di server per akun.
  editor.append(el("div", "cap-label", "Jira credentials"));
  const jiraOk = profil && profil.jira_tersimpan;
  editor.append(el("div", "cap-hint",
    jiraOk ? "✓ Tersambung ke " + (profil.jira_site || jira.site || "Jira") +
      " (tersimpan di server — tak perlu isi ulang di perangkat lain)."
    : profil ? "Belum diisi — tiket & worklog belum bisa ditarik. Isi di bawah."
    : "Memeriksa…"));
  const fj = el("div", "routine-form");
  const siteIn = document.createElement("input");
  siteIn.type = "url"; siteIn.placeholder = "https://kantormu.atlassian.net";
  siteIn.title = "Alamat Jira Cloud kamu";
  if (profil && profil.jira_site) siteIn.value = profil.jira_site;
  const emailIn = document.createElement("input");
  emailIn.type = "email"; emailIn.placeholder = "Email Atlassian";
  if (profil && profil.jira_email) emailIn.value = profil.jira_email;
  const tokenIn = document.createElement("input");
  tokenIn.type = "password"; tokenIn.placeholder = jiraOk ? "API token (isi untuk ganti)" : "API token";
  tokenIn.title = "Buat di id.atlassian.com/manage-profile/security/api-tokens";
  const kirimJ = el("button", "btn-solid", jiraOk ? "Update" : "Save Jira credentials");
  kirimJ.onclick = async () => {
    kirimJ.disabled = true;
    try {
      const r = await fetch(jiraProxy() + "/me/jira", {
        method: "POST", headers: { "Content-Type": "application/json", ...headerAkses() },
        body: JSON.stringify({ site: siteIn.value, email: emailIn.value, token: tokenIn.value }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
      jira.site = siteIn.value.trim().replace(/\/+$/, ""); saveJira(true);
      alert("Tersimpan. Tiket & worklog Jira memakai akunmu sendiri.");
      tarikProfil(true); syncJira(true);
    } catch (e) {
      alert("Gagal menyimpan: " + (e && e.message ? e.message : "koneksi"));
    }
    kirimJ.disabled = false; render();
  };
  fj.append(siteIn, emailIn, tokenIn, kirimJ);
  editor.append(fj);
  editor.append(el("div", "cap-hint",
    "Tersimpan di server (bukan di perangkat). Token dibuat sendiri di id.atlassian.com → Security → API tokens."));

  // Google Calendar — status server + form (calSettingsForm juga simpan ke server).
  if (profil) editor.append(el("div", "cap-hint",
    profil.cal_tersimpan ? "📅 Kalender tersimpan di server — muncul di semua perangkatmu."
    : "📅 Kalender belum diisi (opsional)."));
  if (typeof calSettingsForm === "function") editor.append(calSettingsForm());
}

/* ---------- sprint bar (di atas daftar tiket) ---------- */
let sprintFormOpen = false;
let sprintEditId = null; // satu sprint yang panel editnya terbuka (biar tak ambigu)
let sprintPrdOpenId = null; // progressive disclosure: editor PRD hanya saat diminta

function renderSprintPrd(s) {
  const links = sprintPrdLinks(s);
  const wrap = el("section", "sprint-prd-panel");
  wrap.setAttribute("aria-label", "PRD references");

  const head = el("div", "sprint-prd-head");
  const heading = el("div");
  heading.append(el("strong", null, "PRD references"));
  heading.append(el("span", "cap-hint", "Tautan ini ikut sinkron dan tersedia sebagai konteks sprint untuk integrasi AI."));
  head.append(heading);
  const addToggle = el("button", "btn-line", sprintPrdOpenId === s.id ? "Cancel" : "+ Add PRD");
  addToggle.type = "button";
  addToggle.setAttribute("aria-expanded", String(sprintPrdOpenId === s.id));
  addToggle.onclick = () => { sprintPrdOpenId = sprintPrdOpenId === s.id ? null : s.id; render(); };
  head.append(addToggle);
  wrap.append(head);

  const list = el("div", "sprint-prd-list");
  if (!links.length) list.append(el("p", "sprint-prd-empty", "Belum ada referensi PRD untuk sprint ini."));
  for (const p of links) {
    const item = el("div", "sprint-prd-item");
    const link = el("a", "sprint-prd-link");
    link.href = p.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = p.url;
    link.append(el("span", "sprint-prd-icon", "↗"), el("span", null, p.title));
    const del = el("button", "icon-btn danger", "✕");
    del.type = "button";
    del.title = "Hapus referensi " + p.title;
    del.setAttribute("aria-label", del.title);
    del.onclick = () => {
      if (confirm("Hapus referensi PRD “" + p.title + "” dari sprint ini?") && hapusSprintPrd(s, p.id)) render();
    };
    item.append(link, del);
    list.append(item);
  }
  wrap.append(list);

  if (sprintPrdOpenId === s.id) {
    const form = el("form", "sprint-prd-form");
    const title = document.createElement("input");
    title.type = "text"; title.placeholder = "PRD title (e.g. Checkout revamp)";
    title.setAttribute("aria-label", "PRD title"); title.maxLength = 120;
    const url = document.createElement("input");
    url.type = "text"; url.inputMode = "url"; url.placeholder = "https://docs…";
    url.setAttribute("aria-label", "PRD URL"); url.required = true;
    const error = el("span", "sprint-prd-error"); error.setAttribute("aria-live", "polite");
    const save = el("button", "btn-solid", "Save link"); save.type = "submit";
    form.append(title, url, save, error);
    form.onsubmit = (event) => {
      event.preventDefault();
      if (tambahSprintPrd(s, title.value, url.value)) {
        sprintPrdOpenId = null; render(); return;
      }
      error.textContent = normalisasiSprintPrdUrl(url.value)
        ? "Link itu sudah tersimpan." : "Masukkan URL http/https yang valid.";
      url.setAttribute("aria-invalid", "true"); url.focus();
    };
    wrap.append(form);
    setTimeout(() => title.focus(), 0);
  }
  return wrap;
}

// Baris satu sprint + panel edit (nama, tanggal, daftar task, selesai/hapus).
function sprintRow(s, sec) {
  const row = el("div", "jira-row");
  const body = el("span", "jira-summary");
  body.append(el("strong", null, s.nama));
  if (s.auto) {
    const tag = el("span", "effort-badge dep-ready", "🔄 Jira");
    tag.title = "Sprint otomatis dari Jira — nama, tanggal, & isinya ikut Jira.";
    body.append(" ", tag);
  }
  row.append(body);
  const badge = el("span", "due-badge mono" + (sprintPtsUntukBadge(s) >= 3 ? " late" : ""),
    "🏁 " + fmtDayName(s.selesai) + " · " + fmtSisaSprint(s));
  row.append(badge);
  const jml = jumlahTugasSprint(s.id);
  row.append(el("span", "jira-status", jml + " tasks"));
  const pairCount = warningsUntukSprint(s).length;
  if (pairCount) {
    row.append(el("span", "pairing-sprint-count", pairCount + " pairing"));
  }
  const prdLinks = sprintPrdLinks(s);
  if (prdLinks.length) {
    const prdCount = el("span", "sprint-prd-count", prdLinks.length + " PRD");
    prdCount.title = prdLinks.map((p) => p.title).join(" · ");
    row.append(prdCount);
  }

  const edit = el("button", "icon-btn" + (sprintEditId === s.id ? " in-sprint" : ""), "✎");
  edit.title = "Ubah sprint / lihat isinya"; edit.setAttribute("aria-label", edit.title);
  edit.onclick = () => { sprintEditId = sprintEditId === s.id ? null : s.id; render(); };
  row.append(edit);
  sec.append(row);

  if (sprintEditId !== s.id) return;

  // ----- panel edit sprint -----
  const ed = el("div", "task-editor");
  const pairing = renderSprintPairing(s);
  if (pairing) ed.append(pairing);
  ed.append(renderSprintPrd(s));
  ed.style.borderLeft = "3px solid var(--p-tinggi)";
  ed.style.paddingLeft = "10px";

  if (s.auto) {
    // Sprint otomatis: nama & tanggal dari Jira, tak bisa diedit di sini.
    const info = el("div", "cap-hint");
    info.textContent = "Ends " + fmtDayName(s.selesai) + " · nama & tanggal ikut Jira. " +
      "Isinya boleh diubah manual (tombol 🏃 di tugas/tiket) — perubahan manual tidak dilawan sync.";
    ed.append(info);
  } else {
    const grpNama = el("div", "cap-group");
    grpNama.append(el("span", "cap-label", "Name"));
    const namaIn = document.createElement("input");
    namaIn.type = "text"; namaIn.value = s.nama; namaIn.className = "sprint-edit-nama";
    const simpanNama = () => { const v = namaIn.value.trim(); if (v && v !== s.nama) { s.nama = v; saveSprints(); render(); } };
    namaIn.onblur = simpanNama;
    namaIn.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); namaIn.blur(); } };
    grpNama.append(namaIn);
    ed.append(grpNama);

    const grpTgl = el("div", "cap-group");
    grpTgl.append(el("span", "cap-label", "Ends"));
    const tglIn = document.createElement("input");
    tglIn.type = "date"; tglIn.value = s.selesai;
    tglIn.onchange = (e) => { if (e.target.value) { s.selesai = e.target.value; saveSprints(); render(); } };
    grpTgl.append(tglIn);
    ed.append(grpTgl);
  }

  // daftar task di sprint ini
  const anggota = tasks.filter((t) => t.sprintId === s.id);
  const lbl = el("div", "cap-label"); lbl.style.marginTop = "2px";
  lbl.textContent = "Sprint items (" + anggota.length + ")";
  ed.append(lbl);
  if (anggota.length) {
    const ul = el("ul", "sprint-tasks");
    anggota.sort(bandingkanTugas).forEach((t) => {
      const li = el("li");
      li.append(el("span", "sprint-task-dot p-" + t.priority));
      const tx = el("span", "sprint-task-text" + (t.status === "selesai" ? " done" : ""));
      tx.append(linkify(t.text));
      li.append(tx);
      // Status tiket dev (ready to test / menunggu dev) — sama seperti di Board.
      const key = (t.text.match(JIRA_RE) || [null])[0];
      const dep = t.status !== "selesai" ? depsTugas(t) : null;
      if (dep) li.append(depBadge(dep));
      else if (key) {
        const warn = warningTiket(key);
        if (warn) li.append(warningBadge(warn));
      }
      if (t.status !== "selesai") {
        const running = t.status === "fokus";
        const run = el("button", "btn-line sprint-run", running ? "● Running" : "▶ Run");
        run.title = running
          ? "Tugas ini sedang In progress — buka di Board"
          : "Jalankan sekarang sebagai In progress";
        run.setAttribute("aria-label", run.title);
        run.onclick = () => {
          // Jangan fokuskan ulang tugas yang sudah berjalan: itu akan mereset
          // stempel focusedAt dan membuang durasi sesi yang sedang dihitung.
          if (!running) fokuskan(t);
          setView("papan");
        };
        li.append(run);
      }
      const keluar = el("button", "icon-btn danger", "✕");
      keluar.title = "Keluarkan dari sprint"; keluar.setAttribute("aria-label", keluar.title);
      keluar.onclick = () => { setTaskSprint(t, null); render(); };
      li.append(keluar);
      ul.append(li);
    });
    ed.append(ul);
  } else {
    ed.append(el("div", "cap-hint", s.auto
      ? "Belum ada tugas dari sprint ini yang kamu ambil ke papan."
      : "Belum ada tugas. Tambahkan lewat panel edit tugas (tombol ✎) atau tombol 🏃 di tiket Jira."));
  }

  if (s.auto) {
    // Sprint otomatis ditutup/dihapus lewat Jira, bukan dari sini.
    ed.append(el("div", "cap-hint",
      "Sprint ini otomatis ikut Jira — akan hilang sendiri begitu sprint-nya ditutup di Jira."));
  } else {
    const aksi = el("div", "cap-group");
    const selesaiBtn = el("button", "btn-solid", "✓ Complete sprint");
    selesaiBtn.title = "Tutup sprint & catat ke Log kerja";
    selesaiBtn.onclick = () => {
      const belum = anggota.filter((t) => t.status !== "selesai").length;
      const pesan = "Tutup sprint “" + s.nama + "”?" +
        (belum ? "\n\nMasih ada " + belum + " tugas belum selesai (tetap di papan, hanya lepas tekanan sprint)." : "") +
        "\n\nAkan dicatat di Log kerja.";
      if (confirm(pesan)) { sprintEditId = null; completeSprint(s); render(); }
    };
    aksi.append(selesaiBtn);
    const hapusBtn = el("button", "btn-line", "Delete sprint");
    hapusBtn.onclick = () => {
      if (confirm("Hapus sprint “" + s.nama + "”?\nTugas-tugasnya tetap ada di papan, hanya lepas dari sprint.")) {
        sprints.list = sprints.list.filter((x) => x.id !== s.id);
        if (sprints.aktif === s.id) sprints.aktif = null;
        tasks.forEach((t) => { if (t.sprintId === s.id) t.sprintId = null; });
        sprintEditId = null;
        saveSprints(); save(); render();
      }
    };
    aksi.append(hapusBtn);
    ed.append(aksi);
  }
  sec.append(ed);
}

function renderSprintBar() {
  const sec = el("section", "section s-jira");
  sec.style.marginBottom = "18px";
  const head = el("div", "section-head");
  head.append(el("h2", null, "Sprint"));
  sec.append(head);

  const aktif = sprintAktifList();
  if (aktif.length) {
    const card = el("div", "routine-card");
    aktif.forEach((s) => sprintRow(s, card));
    sec.append(card);
  }

  // Sprint yang sudah ditutup — ringkas, tanpa menekan skor.
  const selesai = sprints.list.filter(sprintSelesai)
    .sort((a, b) => new Date(b.selesaiPada || 0) - new Date(a.selesaiPada || 0));
  if (selesai.length) {
    const det2 = document.createElement("details");
    det2.className = "routine-manage";
    const sum2 = document.createElement("summary");
    sum2.append("Completed sprints ", el("span", "count mono", String(selesai.length)));
    det2.append(sum2);
    const card2 = el("div", "routine-card");
    for (const s of selesai) {
      const row = el("div", "jira-row");
      row.append(el("span", "jira-summary", "🏁 " + s.nama));
      row.append(el("span", "jira-status", "closed " + (s.selesaiPada ? fmtAgo(s.selesaiPada) : "")));
      const del = el("button", "icon-btn danger", "✕");
      del.title = "Hapus dari riwayat"; del.setAttribute("aria-label", del.title);
      del.onclick = () => {
        sprints.list = sprints.list.filter((x) => x.id !== s.id);
        tasks.forEach((t) => { if (t.sprintId === s.id) t.sprintId = null; });
        saveSprints(); save(); render();
      };
      row.append(del);
      card2.append(row);
    }
    det2.append(card2);
    sec.append(det2);
  }

  const det = document.createElement("details");
  det.className = "routine-manage";
  det.open = sprintFormOpen;
  det.addEventListener("toggle", () => { sprintFormOpen = det.open; });
  const sum = document.createElement("summary");
  sum.textContent = sprints.list.length ? "+ new sprint" :
    "+ create sprint (kelompokkan tiket + tanggal selesai — makin mepet, skor tiketnya makin naik)";
  det.append(sum);
  const editor = el("div", "routine-editor");
  const form = el("div", "routine-form");
  const nama = document.createElement("input");
  nama.type = "text"; nama.id = "sprint-nama";
  nama.placeholder = "Sprint name… mis. “Sprint 12”";
  const tgl = document.createElement("input");
  tgl.type = "date"; tgl.id = "sprint-tgl";
  tgl.title = "Tanggal sprint berakhir";
  const buat = el("button", "btn-solid", "Create sprint");
  const buatSprint = () => {
    const n = nama.value.trim();
    if (!n || !tgl.value) { alert("Isi nama sprint dan tanggal selesainya."); return; }
    const s = { id: uid(), nama: n, selesai: tgl.value, createdAt: new Date().toISOString() };
    sprints.list.push(s);
    sprints.aktif = s.id;
    sprintFormOpen = false;
    saveSprints(); render();
  };
  buat.onclick = buatSprint;
  nama.addEventListener("keydown", (e) => { if (e.key === "Enter") buatSprint(); });
  form.append(nama, tgl, buat);
  editor.append(form);
  det.append(editor);
  sec.append(det);
  return sec;
}
// Untuk pewarnaan badge sisa waktu: pakai skala poin yang sama dengan tugas.
function sprintPtsUntukBadge(s) { return sprintPts({ sprintId: s.id }); }

/* ---------- Jira inbox rendering (tab sendiri: #jiraview) ---------- */
let jiraImportOpen = false;
let bulanBuka = {};        // ingatan buka/tutup per grup bulan
let bulanDefaultBuka = true; // default semua terbuka; diubah tombol lipat/buka semua
function renderJiraInbox() {
  const wrap = $("#jiraview");
  wrap.innerHTML = "";
  wrap.append(renderSprintBar());
  if (rapikanInbox()) saveJira(true); // penyembuhan mesin — tanpa klaim dirty
  const q = searchQuery.trim().toLowerCase();
  const shown = !q ? jira.items : jira.items.filter((x) =>
    (x.key + " " + x.summary + " " + (x.status || "")).toLowerCase().includes(q));

  const sec = el("section", "section s-jira");
  const head = el("div", "section-head");
  head.append(el("h2", null, "Jira tickets — not taken"));
  if (jira.items.length) {
    head.append(el("span", "count mono",
      q ? shown.length + "/" + jira.items.length : String(jira.items.length)));
  }
  if (jiraProxy()) {
    const refresh = el("button", "clear-done", jiraSyncing ? "fetching…" : "⟳ sync now");
    refresh.onclick = () => syncJira(true);
    head.append(refresh);
    if (jiraSyncMsg && !jiraSyncing) head.append(el("span", "count", jiraSyncMsg));
    else if (jira.lastSync && !jiraSyncing) head.append(el("span", "count mono", "synced " + fmtAgo(jira.lastSync)));
  }
  sec.append(head);

  if (q && !shown.length) {
    sec.append(el("div", "empty-note", "Tidak ada tiket yang cocok dengan “" + searchQuery.trim() + "”."));
  }
  if (shown.length) {
    // Kelompokkan per bulan dibuatnya tiket di Jira; impor manual tanpa
    // tanggal jatuh ke bulan saat masuk Catet.
    const NAMA_BULAN = ["Januari", "Februari", "Maret", "April", "Mei", "Juni",
      "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
    const tglItem = (x) => String(x.created || x.addedAt || "");
    const perBulan = new Map();
    for (const item of shown) {
      const k = tglItem(item).slice(0, 7) || "0000-00";
      if (!perBulan.has(k)) perBulan.set(k, []);
      perBulan.get(k).push(item);
    }
    const bulanIni = localDateStr(new Date()).slice(0, 7);
    const kunci = [...perBulan.keys()].sort().reverse();
    const buka = (k) => (k in bulanBuka ? bulanBuka[k] : bulanDefaultBuka);
    if (kunci.length > 1) {
      const semuaTerbuka = kunci.every(buka);
      const lipat = el("button", "clear-done", semuaTerbuka ? "⊟ collapse all" : "⊞ expand all");
      lipat.onclick = () => { bulanBuka = {}; bulanDefaultBuka = !semuaTerbuka; render(); };
      head.append(lipat);
    }
    for (const k of kunci) {
      const grup = perBulan.get(k).sort((a, b) => tglItem(b).localeCompare(tglItem(a)));
      const label = k === "0000-00" ? "No date"
        : NAMA_BULAN[Number(k.slice(5, 7)) - 1] + " " + k.slice(0, 4) +
          (k === bulanIni ? " — this month" : "");
      const det2 = document.createElement("details");
      det2.className = "bulan-wrap";
      // saat mencari semua terbuka; selain itu ikut ingatan/default
      det2.open = q ? true : buka(k);
      det2.addEventListener("toggle", () => { if (!q) bulanBuka[k] = det2.open; });
      const bl = document.createElement("summary");
      bl.className = "bulan-label";
      bl.append(label + " ", el("span", "count mono", String(grup.length)));
      det2.append(bl);
      const card = el("div", "routine-card");
      for (const item of grup) {
        const row = el("div", "jira-row");
      if (jiraSite()) {
        const a = el("a", "jira-key", item.key);
        a.href = jiraUrl(item.key); a.target = "_blank"; a.rel = "noopener";
        a.title = "Buka di Jira";
        row.append(a);
      } else {
        row.append(el("span", "jira-key", item.key));
      }
      row.append(el("span", "jira-summary", item.summary));
      if (item.status) row.append(el("span", "jira-status", item.status));
      const dep = depsTiket(item.key);
      if (dep) row.append(depBadge(dep));
      else {
        const warn = warningTiket(item.key);
        if (warn) row.append(warningBadge(warn));
      }
      const take = el("button", "btn-line", "＋ Take");
      take.title = "Pindahkan ke papan utama sebagai tugas";
      take.onclick = () => { takeJiraItem(item); render(); };
      row.append(take);
      if (sprintAktifList().length) {
        const takeSprint = el("button", "btn-line", "🏃 Sprint");
        takeSprint.title = "Ambil ke papan + pilih sprint";
        takeSprint.onclick = (e) => {
          e.stopPropagation();
          bukaSprintMenu(takeSprint, null, (id) => { if (id) { takeJiraItem(item, id); render(); } });
        };
        row.append(takeSprint);
      }
      const del = el("button", "icon-btn danger", "✕");
      del.title = "Buang dari daftar (tidak akan muncul lagi saat sinkron)";
      del.setAttribute("aria-label", "Buang dari daftar");
      del.onclick = () => {
        jira.items = jira.items.filter((x) => x.id !== item.id);
        if (!jira.dismissed.includes(item.key)) jira.dismissed.push(item.key);
        saveJira(); render();
      };
      row.append(del);
      card.append(row);
      }
      det2.append(card);
      sec.append(det2);
    }
  }

  const det = document.createElement("details");
  det.className = "routine-manage jira-import";
  det.open = jiraImportOpen;
  det.addEventListener("toggle", () => { jiraImportOpen = det.open; });
  const sum = document.createElement("summary");
  sum.textContent = jira.items.length ? "import tickets" : "+ import tickets (tempel daftar dari Claude / Jira)";
  det.append(sum);
  const editor = el("div", "routine-editor");
  const ta = document.createElement("textarea");
  ta.placeholder = 'Tempel di sini. Bisa JSON {"items":[{"key":"ERA-123","summary":"…"}]} atau per baris: ERA-123 perbaiki bug login';
  editor.append(ta);
  const form = el("div", "routine-form");
  const site = document.createElement("input");
  site.type = "url"; site.value = jira.site || "";
  site.placeholder = "https://perusahaan.atlassian.net";
  site.title = "Alamat Jira — dipakai untuk membuat link tiket";
  const impBtn = el("button", "btn-solid", "Import");
  impBtn.onclick = () => {
    jira.site = site.value.trim();
    const res = importJira(ta.value);
    if (!res.parsed) { alert("Tidak ada tiket yang dikenali. Formatnya per baris: KODE-123 ringkasan tiket — atau JSON dari Claude."); return; }
    if (!res.added) { alert("Semua " + res.parsed + " tiket sudah ada di daftar/papan."); return; }
    saveJira(); render();
  };
  form.append(site, impBtn);
  editor.append(form);

  // Sinkronisasi otomatis sudah aktif lewat proxy bawaan (Cloudflare Worker) —
  // tak perlu setup per perangkat. Tiket ditarik tiap 5 menit dan data
  // tersinkron antar perangkat; Log kerja bisa dikirim sebagai worklog.
  editor.append(el("div", "cap-hint",
    "Tiket & data tersinkron otomatis antar perangkat. Cukup buka aplikasinya — tak perlu memasukkan alamat proxy atau kunci."));

  // Pemulihan: key yang pernah dibuang (✕) atau terkunci oleh bug lama bisa
  // dibebaskan lagi — kecuali yang tugasnya memang masih aktif di papan.
  const terkunci = jira.dismissed.filter((k) =>
    !tasks.some((t) => t.status !== "selesai" && t.text.includes(k)));
  if (terkunci.length) {
    const pulih = el("button", "clear-done",
      "♻ restore " + terkunci.length + " dismissed tickets");
    pulih.title = "Cabut dari daftar abaikan: " + terkunci.join(", ");
    pulih.onclick = () => {
      if (!confirm("Pulihkan " + terkunci.length + " tiket ini supaya bisa muncul lagi di tab Jira?\n\n" + terkunci.join(", "))) return;
      jira.dismissed = jira.dismissed.filter((k) => !terkunci.includes(k));
      saveJira();
      if (jiraProxy()) syncJira(true);
      else alert("Selesai. Tiketnya akan muncul lagi saat sinkron/impor berikutnya.");
      render();
    };
    editor.append(pulih);
  }

  det.append(editor);
  sec.append(det);
  wrap.append(sec);
  renderBauSection(wrap);
}
