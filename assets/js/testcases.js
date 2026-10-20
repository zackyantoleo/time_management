// testcases.js — tempel test case hasil AI ke task bertiket Jira, parse
// (markdown standar Zack atau JSON catet.testcases.v1), validasi, dan pratinjau.
// Parse lokal; Dry run (Fase 2) minta Worker mengecek tiket, project QAlity, dan
// duplikat — read-only, belum ada Push. Token QAlity diatur di Settings.
"use strict";

const TESTCASE_FORMAT = "catet.testcases.v1";
const TESTCASE_MAX_BATCH = 20;   // batas subrequest Worker saat push (plan §6)
const TESTCASE_TITLE_MAX = 255;  // batas Summary issue Jira
// Draft tempelan per task — sengaja TIDAK ikut /state maupun backup.
const TESTCASE_DRAFT_KEY = "catet.testcaseDrafts.v1";

/* ---------- parse ---------- */

// Heading bagian yang dikenali: **Title:**, **Title**:, Title:, ### Title:, dst.
const TC_HEADING = /^\s{0,3}(?:#{1,6}\s+)?(?:\*\*|__)?\s*(title|pre-?conditions?|test\s+steps?(?:\s*\(s\))?|steps?(?:\s*\(s\))?|expected\s+results?(?:\s*\(s\))?)\s*(?:(?:\*\*|__)\s*:|:\s*(?:\*\*|__)?)\s*(.*)$/i;
// Label bold lain (mis. **Priority:**) — isinya diabaikan, tapi dilaporkan.
const TC_HEADING_LAIN = /^\s{0,3}(?:#{1,6}\s+)?(?:\*\*|__)([^*_\n:]{1,40}?)\s*(?::\s*(?:\*\*|__)|(?:\*\*|__)\s*:)\s*(.*)$/;
// Dekorasi tanpa isi (### Test Case 1, **Test Case 2: Negative**) — menutup bagian.
const TC_DEKORASI = /^\s{0,3}(?:#{1,6}\s+\S|(\*\*|__)[^*_]+\1\s*$)/;
const TC_PEMISAH = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const TC_PAGAR = /^\s*(```|~~~)/;
const TC_BUTIR = /^(\s*)(?:[-*+•]|\d{1,3}[.)])\s+(.*)$/;

function jenisBagianTestCase(label) {
  const l = label.toLowerCase();
  if (l === "title") return "title";
  if (l.startsWith("pre")) return "preconditions";
  if (l.startsWith("expected")) return "expected";
  return "steps";
}

function rapikanJudulTestCase(s) {
  let t = String(s).replace(/\s+/g, " ").trim();
  // "**Title: Verify X**" — sisa penutup bold ikut tertangkap di isi.
  if ((t.match(/\*\*/g) || []).length % 2) t = t.replace(/\s*\*\*\s*$/, "");
  return t;
}

function parseTestCases(text) {
  const out = { format: TESTCASE_FORMAT, source: null, cases: [], errors: [] };
  let isi = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
  if (!isi.trim()) { out.errors.push("Belum ada teks — tempel test case dulu."); return out; }
  // Seluruh tempelan dibungkus satu blok kode (```json / ```markdown) dari AI.
  const pagar = isi.trim().match(/^(```|~~~)[\w-]*[ \t]*\n([\s\S]*?)\n[ \t]*\1[ \t]*$/);
  if (pagar) isi = pagar[2];
  const awal = isi.trim();
  let data;
  if (awal.startsWith("{")) {
    out.source = "json";
    try { data = JSON.parse(awal); } catch (e) { out.errors.push("JSON tidak valid: " + e.message); return out; }
  } else if (awal.startsWith("[")) {
    try { data = JSON.parse(awal); out.source = "json"; } catch { /* bukan JSON — mis. "[Positive] …" */ }
  }
  if (out.source === "json") parseTestCasesJson(data, out);
  else { out.source = "markdown"; parseTestCasesMarkdown(isi, out); }
  if (!out.cases.length && !out.errors.length) {
    out.errors.push("Tidak ada test case yang dikenali. Pastikan tiap case punya **Title:**, **Test Step(s):**, dan **Expected Result:**, dipisah ---.");
  }
  return out;
}

function parseTestCasesJson(data, out) {
  if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.cases)) {
    out.errors.push("JSON harus berupa objek { \"format\": \"" + TESTCASE_FORMAT + "\", \"cases\": [...] }.");
    return;
  }
  if (data.format != null && data.format !== TESTCASE_FORMAT) {
    out.errors.push("Format JSON tidak dikenal: “" + String(data.format) + "” (harus " + TESTCASE_FORMAT + ").");
    return;
  }
  const dikenal = ["title", "preconditions", "steps", "expected"];
  data.cases.forEach((c, i) => {
    const no = "Case #" + (i + 1);
    const kasus = { title: "", preconditions: [], steps: [], expected: [], ignored: [] };
    out.cases.push(kasus); // tetap didorong supaya nomor case sejajar dengan input
    if (!c || typeof c !== "object" || Array.isArray(c)) { out.errors.push(no + " bukan objek { title, preconditions, steps, expected }."); return; }
    if (typeof c.title === "string") kasus.title = rapikanJudulTestCase(c.title);
    else if (c.title != null) out.errors.push(no + ": “title” harus berupa teks.");
    for (const f of ["preconditions", "steps", "expected"]) {
      const v = c[f];
      if (v == null) continue;
      if (typeof v === "string") kasus[f] = v.trim() ? [v.trim()] : [];
      else if (Array.isArray(v) && v.every((x) => typeof x === "string")) kasus[f] = v.map((x) => x.trim()).filter(Boolean);
      else out.errors.push(no + ": “" + f + "” harus berupa teks atau daftar teks.");
    }
    kasus.ignored = Object.keys(c).filter((k) => !dikenal.includes(k));
  });
}

function parseTestCasesMarkdown(isi, out) {
  let cur = null;        // case yang sedang dibangun
  let bagian = null;     // "title" | "preconditions" | "steps" | "expected" | "abaikan" | null
  let dasar = null;      // indentasi butir pertama di bagian ini
  let butirBerpenanda = false;
  let pagar = null;      // indentasi pembuka blok kode, null = di luar blok
  const mulai = () => { cur = { title: "", preconditions: [], steps: [], expected: [], ignored: [] }; };
  const selesai = () => {
    if (cur) {
      for (const f of ["preconditions", "steps", "expected"]) cur[f] = cur[f].map((x) => x.trim()).filter(Boolean);
      if (cur.title || cur.preconditions.length || cur.steps.length || cur.expected.length) out.cases.push(cur);
    }
    cur = null; bagian = null;
  };
  const daftar = () => (cur && ["preconditions", "steps", "expected"].includes(bagian) ? cur[bagian] : null);
  const tempel = (teks) => {
    const l = daftar();
    if (!l) return;
    if (l.length) l[l.length - 1] += "\n" + teks; else l.push(teks);
  };
  const tambahBaris = (baris) => {
    const l = daftar();
    if (!l) return;
    const m = baris.match(TC_BUTIR);
    if (m) {
      if (dasar == null) dasar = m[1].length;
      if (!l.length || m[1].length <= dasar + 1) { l.push(m[2]); butirBerpenanda = true; }
      else tempel(baris.trim()); // sub-bullet → lanjutan butir sebelumnya
    } else if (!l.length || !butirBerpenanda) { l.push(baris.trim()); butirBerpenanda = false; }
    else tempel(baris.trim());
  };

  for (const mentah of isi.split("\n")) {
    const baris = mentah.replace(/\s+$/, "");
    if (pagar != null) {
      const lekuk = baris.match(/^\s*/)[0].length;
      tempel(baris.slice(Math.min(pagar, lekuk)));
      if (TC_PAGAR.test(baris)) pagar = null;
      continue;
    }
    if (TC_PAGAR.test(baris)) { pagar = baris.match(/^\s*/)[0].length; tempel(baris.trim()); continue; }
    if (!baris.trim()) continue;
    if (TC_PEMISAH.test(baris)) { selesai(); continue; }
    const h = baris.match(TC_HEADING);
    if (h) {
      const jenis = jenisBagianTestCase(h[1]);
      if (jenis === "title" && cur && cur.title) selesai();
      if (!cur) mulai();
      bagian = jenis; dasar = null; butirBerpenanda = false;
      if (jenis === "title") { if (h[2].trim()) cur.title = rapikanJudulTestCase(h[2]); }
      else if (h[2].trim()) tambahBaris(h[2]);
      continue;
    }
    const lain = baris.match(TC_HEADING_LAIN);
    if (lain) {
      if (cur) {
        const nama = lain[1].trim();
        if (!cur.ignored.includes(nama)) cur.ignored.push(nama);
        bagian = "abaikan";
      }
      continue;
    }
    if (TC_DEKORASI.test(baris)) { bagian = null; continue; }
    if (!cur || !bagian || bagian === "abaikan") continue; // pembuka/penutup obrolan AI
    if (bagian === "title") {
      if (!cur.title) cur.title = rapikanJudulTestCase(baris.replace(TC_BUTIR, "$2"));
      continue;
    }
    tambahBaris(baris);
  }
  selesai();
}

/* ---------- validasi ---------- */

const TC_KATA_VALIDASI = /\b(verify|verifies|verified|verifying|check|checks|checked|checking|validate|validates|validated|validating|ensure|ensures|ensured|ensuring|pastikan|memastikan)\b/i;
const kunciJudulTestCase = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

// Error memblokir case; warning hanya pengingat standar penulisan. `cases` =
// case yang AKAN dipush (sudah difilter centangnya), jadi duplikat & batas
// batch dihitung dari situ. Worker kelak memvalidasi ulang (otoritatif).
function validateTestCases(cases) {
  const list = Array.isArray(cases) ? cases : [];
  const res = { ok: false, errors: [], cases: list.map(() => ({ errors: [], warnings: [] })) };
  if (!list.length) res.errors.push("Belum ada case yang dipilih.");
  if (list.length > TESTCASE_MAX_BATCH) {
    res.errors.push("Batch berisi " + list.length + " case; maksimal " + TESTCASE_MAX_BATCH + " per push. Hapus centang sebagian.");
  }
  const kembar = new Map();
  list.forEach((c) => { const k = kunciJudulTestCase(c && c.title); if (k) kembar.set(k, (kembar.get(k) || 0) + 1); });

  list.forEach((c, i) => {
    const { errors, warnings } = res.cases[i];
    const judul = String((c && c.title) || "").replace(/\s+/g, " ").trim();
    const pre = (c && Array.isArray(c.preconditions)) ? c.preconditions : [];
    const steps = (c && Array.isArray(c.steps)) ? c.steps : [];
    const expected = (c && Array.isArray(c.expected)) ? c.expected : [];
    const panjang = [...judul].length;
    if (!judul) errors.push("Title kosong.");
    else {
      if (panjang > TESTCASE_TITLE_MAX) errors.push("Title " + panjang + " karakter; maksimal " + TESTCASE_TITLE_MAX + ".");
      if (kembar.get(kunciJudulTestCase(judul)) > 1) errors.push("Title duplikat dengan case lain di batch ini.");
      if (/^gap\s*:/i.test(judul)) errors.push("Case GAP: menandai celah requirement, bukan test case — tidak akan dipush.");
      else if (!/^(verify|validate)\b/i.test(judul)) warnings.push("Title tidak diawali Verify/Validate.");
    }
    if (!steps.length) errors.push("Tidak ada Test Step.");
    if (!expected.length) errors.push("Tidak ada Expected Result.");
    if (!pre.length) warnings.push("Precondition kosong — boleh, asal memang tidak ada prasyarat.");
    steps.forEach((s, j) => {
      const m = String(s).match(TC_KATA_VALIDASI);
      if (m) warnings.push("Step " + (j + 1) + " mengandung kata validasi “" + m[1] + "” — validasi sebaiknya di Expected Result.");
    });
    if (steps.length > 3) warnings.push("Ada " + steps.length + " step; standar: seminimal mungkin, utamakan satu.");
    if (expected.length > 3) warnings.push("Ada " + expected.length + " expected result; standar: maksimal 3 poin.");
    for (const nama of (c && Array.isArray(c.ignored)) ? c.ignored : []) {
      warnings.push("Bagian “" + nama + "” tidak dikenal dan diabaikan.");
    }
  });
  res.ok = !res.errors.length && res.cases.every((r) => !r.errors.length);
  return res;
}

/* ---------- draft per task ---------- */

function bacaSemuaDraftTestCase() {
  try {
    const v = JSON.parse(localStorage.getItem(TESTCASE_DRAFT_KEY));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
function bacaDraftTestCase(taskId) {
  const d = bacaSemuaDraftTestCase()[taskId];
  return d && typeof d.text === "string" ? d.text : "";
}
// Sekalian membuang draft milik task yang sudah tidak ada (dihapus/diarsipkan).
function simpanDraftTestCase(taskId, text) {
  const ada = new Set((Array.isArray(tasks) ? tasks : []).map((t) => t.id));
  const semua = {};
  for (const [id, d] of Object.entries(bacaSemuaDraftTestCase())) if (ada.has(id) && id !== taskId) semua[id] = d;
  if (String(text || "").trim()) semua[taskId] = { text: String(text), updatedAt: new Date().toISOString() };
  try {
    if (Object.keys(semua).length) localStorage.setItem(TESTCASE_DRAFT_KEY, JSON.stringify(semua));
    else localStorage.removeItem(TESTCASE_DRAFT_KEY);
  } catch {}
}

/* ---------- panel ---------- */

let testcaseTaskId = null; // task yang panel Test cases-nya terbuka
let testcaseHasil = null;  // { taskId, text, parsed, pilih: [bool] } — parse terakhir
// Dry run terakhir: { taskId, sig, loading, error, rinci, data }. sig = isi case
// terpilih saat dikirim; hasil hanya tampil selama pilihan/isi masih sama.
let testcaseDry = null;

function keyTestCase(t) { return (String(t.text || "").match(JIRA_RE) || [null])[0]; }

// render() membangun ulang DOM; kembalikan fokus ke kontrol yang sama.
function renderLaluFokus(id) {
  render();
  const n = document.getElementById(id);
  if (n) n.focus({ preventScroll: true });
}

// Tombol pembuka panel; null kalau task tidak memuat key Jira.
function tombolTestCase(t, kelas, label) {
  if (!keyTestCase(t)) return null;
  const terbuka = testcaseTaskId === t.id;
  const btn = el("button", kelas + (terbuka ? " in-sprint" : ""), label);
  btn.type = "button";
  btn.id = "tc-btn-" + t.id;
  btn.title = "Test cases — tempel & cek test case hasil AI untuk tiket ini";
  btn.setAttribute("aria-label", "Test cases");
  btn.setAttribute("aria-expanded", String(terbuka));
  btn.setAttribute("aria-controls", "tc-panel-" + t.id);
  btn.onclick = () => { testcaseTaskId = terbuka ? null : t.id; renderLaluFokus(btn.id); };
  return btn;
}

function renderTestCasePanel(t) {
  const key = keyTestCase(t);
  const panel = el("div", "testcase-panel");
  panel.id = "tc-panel-" + t.id;
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "Test cases " + key);

  const head = el("div", "testcase-head");
  head.append(el("h3", null, "Test cases"), el("span", "jira-key", key));
  panel.append(head);
  panel.append(el("p", "testcase-hint",
    "Tempel test case hasil AI: bagian Title / Precondition / Test Step(s) / Expected Result, antar-case dipisah ---, " +
    "atau JSON " + TESTCASE_FORMAT + ". Parse hanya di perangkat ini; Dry run mengecek ke Jira/QAlity tanpa membuat apa pun."));

  const hasil = testcaseHasil && testcaseHasil.taskId === t.id ? testcaseHasil : null;
  const ta = document.createElement("textarea");
  ta.className = "testcase-input";
  ta.id = "tc-input-" + t.id;
  ta.rows = 8; ta.spellcheck = false;
  ta.setAttribute("aria-label", "Teks test case untuk " + key);
  ta.placeholder = "**Title:** Verify …\n\n**Precondition:**\n- …\n\n**Test Step(s):**\n1. …\n\n**Expected Result:**\n1. …\n\n---";
  ta.value = bacaDraftTestCase(t.id);
  const basi = el("p", "testcase-stale", "Teks berubah sejak Parse terakhir — klik Parse lagi supaya pratinjau sesuai.");
  basi.setAttribute("role", "status");
  const cekBasi = () => basi.classList.toggle("hidden", !hasil || ta.value === hasil.text);
  ta.oninput = () => { simpanDraftTestCase(t.id, ta.value); cekBasi(); };
  cekBasi();
  panel.append(ta, basi);

  const aksi = el("div", "testcase-actions");
  const parseBtn = el("button", "btn-solid", "Parse");
  parseBtn.type = "button"; parseBtn.id = "tc-parse-" + t.id;
  parseBtn.onclick = () => {
    const parsed = parseTestCases(ta.value);
    simpanDraftTestCase(t.id, ta.value);
    testcaseHasil = { taskId: t.id, text: ta.value, parsed, pilih: parsed.cases.map(() => true) };
    renderLaluFokus(parseBtn.id);
  };
  const clearBtn = el("button", "btn-line", "Clear");
  clearBtn.type = "button";
  clearBtn.onclick = () => {
    if (ta.value.trim() && !confirm("Kosongkan teks dan pratinjau test case untuk " + key + "?")) return;
    simpanDraftTestCase(t.id, "");
    if (hasil) testcaseHasil = null;
    if (testcaseDry && testcaseDry.taskId === t.id) testcaseDry = null;
    renderLaluFokus(ta.id);
  };
  const closeBtn = el("button", "btn-line", "Close");
  closeBtn.type = "button";
  closeBtn.title = "Tutup panel — teks tetap tersimpan sebagai draft di perangkat ini";
  closeBtn.onclick = () => { testcaseTaskId = null; renderLaluFokus("tc-btn-" + t.id); };
  aksi.append(parseBtn, clearBtn, closeBtn);
  panel.append(aksi);

  if (hasil) panel.append(pratinjauTestCase(t, hasil));
  return panel;
}

function daftarIsuTestCase(items, jenis) {
  const ul = el("ul", "testcase-issues " + jenis);
  for (const teks of items) {
    const li = el("li");
    li.append(el("span", "testcase-issue-tag", jenis === "err" ? "Error" : "Warning"), el("span", null, teks));
    ul.append(li);
  }
  return ul;
}

function pratinjauTestCase(t, hasil) {
  const { parsed, pilih } = hasil;
  const wrap = el("div", "testcase-preview");
  wrap.setAttribute("aria-live", "polite");
  if (parsed.errors.length) wrap.append(daftarIsuTestCase(parsed.errors, "err"));
  if (!parsed.cases.length) return wrap;

  const dipilih = parsed.cases.filter((_, i) => pilih[i]);
  const v = validateTestCases(dipilih);
  let j = 0;
  const isu = parsed.cases.map((_, i) => (pilih[i] ? v.cases[j++] : null));
  const nErr = isu.filter((x) => x && x.errors.length).length;
  const nWarn = isu.filter((x) => x && x.warnings.length).length;

  const ringkas = el("div", "testcase-summary");
  ringkas.append(
    el("span", "testcase-chip", parsed.cases.length + (parsed.cases.length === 1 ? " case" : " cases")),
    el("span", "testcase-chip", dipilih.length + " selected"),
    el("span", "testcase-chip" + (nErr ? " err" : ""), nErr + (nErr === 1 ? " error" : " errors")),
    el("span", "testcase-chip" + (nWarn ? " warn" : ""), nWarn + (nWarn === 1 ? " warning" : " warnings")));
  wrap.append(ringkas);
  if (v.errors.length) wrap.append(daftarIsuTestCase(v.errors, "err"));

  const ol = el("ol", "testcase-list");
  parsed.cases.forEach((c, i) => ol.append(kartuTestCase(t, c, i, pilih, isu[i])));
  wrap.append(ol);

  const siap = v.ok && !parsed.errors.length;
  wrap.append(el("p", "testcase-status" + (siap ? " ok" : ""), siap
    ? "Format valid — " + dipilih.length + " case siap. Klik Dry run untuk cek project, duplikat, dan isi persis yang akan dibuat."
    : "Perbaiki yang bertanda Error atau hapus centang case-nya. Warning boleh diabaikan."));
  if (siap) wrap.append(dryRunTestCase(t, dipilih));
  return wrap;
}

/* ---------- dry run (Worker, read-only) ---------- */

const kirimanTestCase = (cases) => cases.map((c) => ({ title: c.title, preconditions: c.preconditions, steps: c.steps, expected: c.expected }));
const sigTestCase = (key, cases) => JSON.stringify([key, kirimanTestCase(cases)]);

function dryRunTestCase(t, dipilih) {
  const key = keyTestCase(t);
  const sig = sigTestCase(key, dipilih);
  const d = testcaseDry && testcaseDry.taskId === t.id && testcaseDry.sig === sig ? testcaseDry : null;
  const box = el("div", "testcase-dryrun");
  const bar = el("div", "testcase-actions");
  const btn = el("button", "btn-solid", d && d.loading ? "Checking…" : d && d.data ? "Dry run again" : "Dry run");
  btn.type = "button"; btn.id = "tc-dry-" + t.id;
  btn.title = "Cek ke Jira & QAlity tanpa membuat apa pun";
  btn.disabled = !jiraProxy() || !!(d && d.loading);
  btn.onclick = () => jalankanDryRun(t, key, dipilih, sig);
  bar.append(btn);
  box.append(bar);
  if (!jiraProxy()) box.append(el("p", "testcase-hint", "Dry run butuh sign in (Settings → Account) dan token QAlity."));
  if (d && d.error) box.append(daftarIsuTestCase([d.error, ...(d.rinci || [])], "err"));
  if (d && d.data) box.append(rencanaTestCase(d.data));
  return box;
}

async function jalankanDryRun(t, key, cases, sig) {
  const masihSama = () => testcaseDry && testcaseDry.taskId === t.id && testcaseDry.sig === sig;
  testcaseDry = { taskId: t.id, sig, loading: true, error: "", rinci: [], data: null };
  renderLaluFokus("tc-dry-" + t.id);
  let hasil;
  try {
    const r = await fetch(jiraProxy() + "/testcases/preview", {
      method: "POST", headers: { "Content-Type": "application/json", ...headerAkses() },
      body: JSON.stringify({ issueKey: key, cases: kirimanTestCase(cases) }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d && Array.isArray(d.plan)) hasil = { data: d };
    else {
      const rinci = [...(Array.isArray(d.errors) ? d.errors : [])];
      (Array.isArray(d.cases) ? d.cases : []).forEach((c, i) => {
        for (const e of (c && Array.isArray(c.errors) ? c.errors : [])) rinci.push("“" + ((cases[i] && cases[i].title) || "#" + (i + 1)) + "”: " + e);
      });
      hasil = { error: "Dry run gagal: " + (d.error || "HTTP " + r.status), rinci };
    }
  } catch (e) {
    hasil = { error: "Dry run gagal: " + ((e && e.message) || "koneksi"), rinci: [] };
  }
  if (!masihSama()) return; // pilihan/isi berubah selama request — hasil lama dibuang
  testcaseDry = { taskId: t.id, sig, loading: false, error: hasil.error || "", rinci: hasil.rinci || [], data: hasil.data || null };
  if (testcaseTaskId === t.id) renderLaluFokus("tc-dry-" + t.id);
}

function rencanaTestCase(d) {
  const wrap = el("div", "testcase-plan");
  wrap.setAttribute("role", "status");
  const n = d.counts || { create: 0, skip: 0 };
  const proj = d.project || {};
  wrap.append(el("p", "testcase-status ok",
    "Dry run OK — " + n.create + " test case akan dibuat di project " + (proj.key || "?") +
    " dan di-link “" + (d.linkType || "QAlity Test") + "” ke " + d.issueKey +
    (n.skip ? "; " + n.skip + " dilewati karena sudah ada." : ".")));
  const ol = el("ol", "testcase-list");
  for (const p of d.plan) {
    const buat = p.action === "create";
    const li = el("li", "testcase-card" + (buat ? "" : " excluded"));
    const head = el("div", "testcase-plan-head");
    head.append(el("span", "testcase-badge" + (buat ? " create" : ""), buat ? "Create" : "Skip"),
      el("strong", "testcase-title", p.title || ""));
    li.append(head);
    if (p.reason) li.append(el("p", "testcase-hint", p.reason));
    if (buat && p.testCase && Array.isArray(p.testCase.testSteps)) li.append(barisStepQality(p.testCase.testSteps));
    ol.append(li);
  }
  wrap.append(ol);
  if (Array.isArray(d.existing) && d.existing.length) {
    wrap.append(el("p", "testcase-hint", "Sudah ter-link ke " + d.issueKey + ": " + d.existing.map((x) => x.key).join(", ") + "."));
  }
  wrap.append(el("p", "testcase-hint", "Dry run tidak membuat apa pun di Jira/QAlity. Push ke QAlity belum tersedia di versi ini."));
  return wrap;
}

// Baris QAlity persis seperti yang akan dibuat: Step / Test data / Expected.
function barisStepQality(rows) {
  const ol = el("ol", "testcase-steps");
  rows.forEach((r, i) => {
    const li = el("li", "testcase-step");
    li.append(el("span", "testcase-no mono", "Step " + (i + 1)));
    const f = (label, val) => {
      const x = el("div", "testcase-field");
      x.append(el("span", "testcase-label", label), val ? el("span", "testcase-pre", val) : el("span", "testcase-empty", "—"));
      return x;
    };
    li.append(f("Step", r.step), f("Test data", r.data), f("Expected", r.result));
    ol.append(li);
  });
  return ol;
}

/* ---------- token QAlity (Settings → Account) ---------- */

// Dipanggil renderSignedIn (jira.js). Token disimpan di server per akun dan
// tidak pernah dikirim balik — browser hanya tahu tersimpan/tidak + kedaluwarsa.
function qalitySettingsForm() {
  const wrap = el("div", "qality-settings");
  wrap.append(el("div", "cap-label", "QAlity token"));
  const ada = !!(profil && profil.qality_tersimpan);
  const exp = (profil && profil.qality_expires_at) || "";
  let status = !profil ? "Memeriksa…"
    : ada ? "✓ Tersimpan di server" + (exp ? " — berlaku sampai " + fmtDayName(exp) : "") + "."
    : "Belum diisi — dibutuhkan untuk Dry run test case.";
  let kelas = "cap-hint";
  if (ada && exp) {
    const sisa = Math.round((Date.parse(exp) - Date.parse(localDateStr(new Date()))) / 86400000);
    if (sisa < 0) { status = "⚠ Token QAlity sudah kedaluwarsa (" + fmtDayName(exp) + ") — buat token baru."; kelas += " qality-warn"; }
    else if (sisa <= 14) { status = "⚠ Token QAlity kedaluwarsa " + (sisa ? "dalam " + sisa + " hari" : "hari ini") + " (" + fmtDayName(exp) + ")."; kelas += " qality-warn"; }
  }
  wrap.append(el("div", kelas, status));

  const form = el("div", "routine-form");
  const tokenIn = document.createElement("input");
  tokenIn.type = "password"; tokenIn.autocomplete = "off";
  tokenIn.placeholder = ada ? "QAlity API token (isi untuk ganti)" : "QAlity API token";
  tokenIn.setAttribute("aria-label", "QAlity API token");
  const expIn = document.createElement("input");
  expIn.type = "date"; expIn.value = exp;
  expIn.title = "Tanggal kedaluwarsa token (opsional) — untuk pengingat 14 hari sebelumnya";
  expIn.setAttribute("aria-label", "Tanggal kedaluwarsa token QAlity");
  const kirim = async (btn, body, pesan) => {
    btn.disabled = true;
    try {
      const r = await fetch(jiraProxy() + "/me/qality", {
        method: "POST", headers: { "Content-Type": "application/json", ...headerAkses() }, body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
      tokenIn.value = "";
      alert(pesan);
      tarikProfil(true);
    } catch (e) {
      alert("Gagal menyimpan token QAlity: " + ((e && e.message) || "koneksi"));
    }
    btn.disabled = false;
  };
  const simpan = el("button", "btn-solid", ada ? "Update" : "Save QAlity token");
  simpan.onclick = () => {
    if (!tokenIn.value.trim()) { alert("Isi token QAlity dulu."); return; }
    kirim(simpan, { token: tokenIn.value, expiresAt: expIn.value }, "Token QAlity tersimpan di server.");
  };
  form.append(tokenIn, expIn, simpan);
  if (ada) {
    const hapus = el("button", "btn-line", "Remove");
    hapus.onclick = () => {
      if (!confirm("Hapus token QAlity dari server? Dry run tidak bisa dipakai sampai token diisi lagi.")) return;
      kirim(hapus, { token: "" }, "Token QAlity dihapus.");
    };
    form.append(hapus);
  }
  wrap.append(form);
  wrap.append(el("div", "cap-hint",
    "Buat token di Jira → sidebar QAlity → Other → QAlity API Tokens (maks 1 tahun). Disimpan di server per akun dan tidak pernah ditampilkan lagi."));
  return wrap;
}

function kartuTestCase(t, c, i, pilih, isu) {
  const kelas = !pilih[i] ? " excluded" : isu.errors.length ? " has-error" : isu.warnings.length ? " has-warning" : "";
  const li = el("li", "testcase-card" + kelas);
  const head = el("label", "testcase-card-head");
  const cb = document.createElement("input");
  cb.type = "checkbox"; cb.checked = !!pilih[i];
  cb.id = "tc-pick-" + t.id + "-" + i;
  cb.onchange = () => { pilih[i] = cb.checked; renderLaluFokus(cb.id); };
  head.append(cb, el("span", "testcase-no mono", "#" + (i + 1)),
    el("strong", "testcase-title" + (c.title ? "" : " empty"), c.title || "(tanpa judul)"));
  if (!pilih[i]) head.append(el("span", "testcase-badge", "Excluded"));
  li.append(head);

  const blok = (label, items, tag) => {
    const f = el("div", "testcase-field");
    f.append(el("span", "testcase-label", label));
    if (items.length) {
      const list = el(tag);
      for (const x of items) list.append(el("li", null, x));
      f.append(list);
    } else f.append(el("span", "testcase-empty", "—"));
    return f;
  };
  li.append(blok("Precondition", c.preconditions, "ul"), blok("Steps", c.steps, "ol"), blok("Expected", c.expected, "ol"));
  if (isu && isu.errors.length) li.append(daftarIsuTestCase(isu.errors, "err"));
  if (isu && isu.warnings.length) li.append(daftarIsuTestCase(isu.warnings, "warn"));
  return li;
}
