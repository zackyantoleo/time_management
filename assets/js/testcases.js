// testcases.js — tempel test case hasil AI ke task bertiket Jira, parse
// (markdown standar Zack atau JSON catet.testcases.v1), validasi, dan pratinjau.
// Parse lokal; Dry run minta Worker mengecek tiket, project QAlity, dan duplikat
// (read-only). Push (setelah dry run + konfirmasi) membuat test case di QAlity
// dan me-link-nya ke tiket; Worker hanya menerimanya bila flag push menyala.
// Tab Jira → Test cases: satu tempelan JSON berisi beberapa tiket, dipecah per
// tiket lalu Dry run/Push satu tiket per request, berurutan.
// Token QAlity diatur di Settings.
"use strict";

const TESTCASE_FORMAT = "catet.testcases.v1";
const TESTCASE_MAX_BATCH = 20;   // batas subrequest Worker saat push (plan §6)
const TESTCASE_MAX_TIKET = 10;   // tiket per Dry run all / Push all
const TESTCASE_TITLE_MAX = 255;  // batas Summary issue Jira
// Draft tempelan per task — sengaja TIDAK ikut /state maupun backup.
const TESTCASE_DRAFT_KEY = "catet.testcaseDrafts.v1";
// Draft tempelan banyak tiket { text, updatedAt } — juga lokal saja.
const TESTCASE_BULK_DRAFT_KEY = "catet.testcaseBulkDraft.v1";
const TC_KEY = /^[A-Z][A-Z0-9]{1,9}-\d+$/; // sama dengan Worker

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

const rapikanBarisTestCase = (text) => String(text == null ? "" : text).replace(/\r\n?/g, "\n");
// Seluruh tempelan dibungkus satu blok kode (```json / ```markdown) dari AI.
function bukaPagarTestCase(isi) {
  const pagar = isi.trim().match(/^(```|~~~)[\w-]*[ \t]*\n([\s\S]*?)\n[ \t]*\1[ \t]*$/);
  return pagar ? pagar[2] : isi;
}

function parseTestCases(text) {
  const out = { format: TESTCASE_FORMAT, source: null, cases: [], errors: [] };
  let isi = rapikanBarisTestCase(text);
  if (!isi.trim()) { out.errors.push("Belum ada teks — tempel test case dulu."); return out; }
  isi = bukaPagarTestCase(isi);
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
  // Case rusak tetap didorong supaya nomor case sejajar dengan input.
  data.cases.forEach((c, i) => out.cases.push(kasusJsonTestCase(c, "Case #" + (i + 1), TC_FIELD_V1, [], out.errors)));
}

// Field JSON → bentuk internal. catet.testcases.v1 memakai nama internal;
// JSON banyak tiket dari AI memakai nama lain + alias. id & scenario_type
// diabaikan tanpa warning (K3); field lain dilaporkan lewat `ignored`.
const TC_FIELD_V1 = { title: ["title"], preconditions: ["preconditions"], steps: ["steps"], expected: ["expected"] };
const TC_FIELD_TIKET = { title: ["title"], preconditions: ["precondition", "preconditions"], steps: ["test_steps", "steps"], expected: ["expected_result", "expected"] };
const TC_DIAM_TIKET = ["id", "scenario_type"];

function kasusJsonTestCase(c, no, peta, diam, errors) {
  const kasus = { title: "", preconditions: [], steps: [], expected: [], ignored: [] };
  if (!c || typeof c !== "object" || Array.isArray(c)) { errors.push(no + " bukan objek { title, preconditions, steps, expected }."); return kasus; }
  for (const [f, sumber] of Object.entries(peta)) {
    const ada = sumber.filter((k) => c[k] != null);
    if (ada.length > 1) { errors.push(no + ": “" + ada.join("” dan “") + "” dua-duanya diisi — pakai salah satu."); continue; }
    if (!ada.length) continue;
    const k = ada[0], v = c[k];
    if (f === "title") {
      if (typeof v === "string") kasus.title = rapikanJudulTestCase(v);
      else errors.push(no + ": “" + k + "” harus berupa teks.");
    } else if (typeof v === "string") kasus[f] = v.trim() ? [v.trim()] : [];
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) kasus[f] = v.map((x) => x.trim()).filter(Boolean);
    else errors.push(no + ": “" + k + "” harus berupa teks atau daftar teks.");
  }
  const dikenal = [...Object.values(peta).flat(), ...diam];
  kasus.ignored = Object.keys(c).filter((k) => !dikenal.includes(k));
  return kasus;
}

/* ---------- tempelan banyak tiket ---------- */

const TC_BUKAN_BUNDLE = "Tempelan tidak berisi task_id. Mode ini butuh JSON daftar tiket " +
  "[{ \"task_id\": \"ABC-123\", \"test_cases\": [...] }]; format markdown / " + TESTCASE_FORMAT +
  " (satu tiket) dipakai lewat tombol 🧪 di task tiketnya.";
const objekTiketTestCase = (x) => !!x && typeof x === "object" && !Array.isArray(x) && ("task_id" in x || "test_cases" in x);

// [{ task_id, task_name, endpoint, test_cases: [...] }] atau satu objek tiket →
// satu kelompok per tiket. Error kelompok hanya memblokir tiket itu; `errors`
// (JSON rusak, bukan format banyak tiket) memblokir semuanya.
function parseTestCaseBundle(text) {
  const out = { bundle: false, groups: [], errors: [] };
  const awal = bukaPagarTestCase(rapikanBarisTestCase(text)).trim();
  if (!awal) { out.errors.push("Belum ada teks — tempel test case dulu."); return out; }
  if (!/^[[{]/.test(awal)) { out.errors.push(TC_BUKAN_BUNDLE); return out; }
  let data;
  try { data = JSON.parse(awal); } catch (e) {
    // "[Positive] …" = markdown, bukan JSON patah — kecuali jelas berisi field tiket.
    out.errors.push(awal.startsWith("{") || /"(task_id|test_cases)"/.test(awal) ? "JSON tidak valid: " + e.message : TC_BUKAN_BUNDLE);
    return out;
  }
  const daftar = Array.isArray(data) ? data : [data];
  if (!daftar.some(objekTiketTestCase)) { out.errors.push(TC_BUKAN_BUNDLE); return out; }
  out.bundle = true;
  const teks = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
  daftar.forEach((x, i) => {
    const g = { key: "", taskName: "", endpoint: "", cases: [], errors: [] };
    out.groups.push(g);
    if (!objekTiketTestCase(x)) { g.errors.push("Item #" + (i + 1) + " bukan objek tiket { task_id, test_cases }."); return; }
    g.taskName = teks(x.task_name);
    g.endpoint = teks(x.endpoint);
    const id = typeof x.task_id === "string" ? x.task_id.trim() : x.task_id;
    if (id == null || id === "") g.errors.push("task_id kosong — isi key tiket Jira (contoh: ABC-123).");
    else if (typeof id !== "string") g.errors.push("task_id harus berupa teks (contoh: ABC-123).");
    else {
      g.key = id.toUpperCase();
      if (!TC_KEY.test(g.key)) g.errors.push("task_id “" + id + "” bukan key tiket Jira (contoh: ABC-123).");
    }
    if (!Array.isArray(x.test_cases)) g.errors.push("test_cases harus berupa daftar case.");
    else if (!x.test_cases.length) g.errors.push("test_cases kosong.");
    else x.test_cases.forEach((c, j) => g.cases.push(kasusJsonTestCase(c, "Case #" + (j + 1), TC_FIELD_TIKET, TC_DIAM_TIKET, g.errors)));
  });
  // Tiket ganda tidak digabung diam-diam: semua kemunculannya error.
  const jumlah = new Map();
  for (const g of out.groups) if (g.key) jumlah.set(g.key, (jumlah.get(g.key) || 0) + 1);
  for (const g of out.groups) {
    if (jumlah.get(g.key) > 1) g.errors.push(g.key + " muncul " + jumlah.get(g.key) + " kali di tempelan — gabungkan case-nya jadi satu tiket.");
  }
  return out;
}

// Panel 🧪 per task: tempelan banyak tiket → hanya kelompok tiket task ini;
// format lama tetap lewat parseTestCases.
function parseTestCasesUntukTiket(text, key) {
  const b = parseTestCaseBundle(text);
  if (!b.bundle) return parseTestCases(text);
  const out = { format: TESTCASE_FORMAT, source: "bundle", cases: [], errors: [], info: "" };
  const lain = [...new Set(b.groups.map((g) => g.key).filter((k) => k && k !== key))];
  const g = b.groups.find((x) => x.key === key);
  if (!g) {
    out.errors.push("Tempelan tidak berisi " + key + ". Tiket di tempelan: " + (lain.join(", ") || "—") + ".");
    return out;
  }
  out.cases = g.cases;
  out.errors.push(...g.errors);
  out.info = "Tempelan berisi " + b.groups.length + " tiket; panel ini memakai " + key + " (" + g.cases.length + " case)." +
    (lain.length ? " Tiket lain: " + lain.join(", ") + " — pakai Jira → Test cases." : "");
  return out;
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

// Mode banyak tiket: validasi per tiket dari case yang dicentang (error parse +
// batas 20 + validateTestCases) dan error tempelan (maks 10 tiket dicentang).
// Tiket "siap" = dicentang dan bebas error.
function cekBundleTestCase(parsed, pilihTiket, pilih) {
  const groups = parsed.groups.map((g, i) => {
    const dipilih = g.cases.filter((_, j) => pilih[i] && pilih[i][j]);
    const v = validateTestCases(dipilih);
    const errors = [...g.errors, ...(g.cases.length ? v.errors : [])];
    return { dipilih, v, errors, siap: !!pilihTiket[i] && !errors.length && v.ok };
  });
  const errors = [...parsed.errors];
  const n = pilihTiket.filter(Boolean).length;
  if (n > TESTCASE_MAX_TIKET) errors.push(n + " tiket dicentang; maksimal " + TESTCASE_MAX_TIKET + " per Dry run/Push. Hapus centang sebagian.");
  return { ok: !errors.length, errors, groups };
}

// Tiket yang ikut Push all: siap, Dry run-nya masih berlaku (sig = key + isi
// case yang dicentang sekarang) dan ada case baru. Sisanya + alasan → konfirmasi.
function rencanaPushBundle(parsed, pilihTiket, pilih, dry) {
  const cek = cekBundleTestCase(parsed, pilihTiket, pilih);
  const siap = [], kecuali = [];
  if (!cek.ok) return { siap, kecuali, cek };
  parsed.groups.forEach((g, i) => {
    const c = cek.groups[i];
    const key = g.key || "Tiket #" + (i + 1);
    const d = dry[g.key];
    let alasan = null;
    if (!pilihTiket[i]) alasan = "tidak dicentang";
    else if (!c.siap) alasan = "masih ada error";
    else if (!d || d.loading || d.sig !== sigTestCase(g.key, c.dipilih)) alasan = "belum Dry run, atau isinya berubah sejak Dry run";
    else if (d.error || !d.data) alasan = "Dry run gagal";
    else if (!(d.data.counts && d.data.counts.create > 0)) alasan = "tidak ada case baru (semua Skip)";
    if (alasan) kecuali.push({ key, alasan });
    else siap.push({ key: g.key, cases: c.dipilih, d: d.data, n: d.data.counts.create });
  });
  return { siap, kecuali, cek };
}

// K2: task_name dari AI vs judul Jira, dibandingkan longgar (huruf kecil, tanda
// baca diabaikan; sama atau salah satu memuat yang lain, mis. prefiks "[BE]").
function judulMiripTestCase(a, b) {
  const n = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const x = n(a), y = n(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
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

function bacaDraftBulkTestCase() {
  try {
    const v = JSON.parse(localStorage.getItem(TESTCASE_BULK_DRAFT_KEY));
    return v && typeof v.text === "string" ? v.text : "";
  } catch { return ""; }
}
function simpanDraftBulkTestCase(text) {
  try {
    if (String(text || "").trim()) localStorage.setItem(TESTCASE_BULK_DRAFT_KEY, JSON.stringify({ text: String(text), updatedAt: new Date().toISOString() }));
    else localStorage.removeItem(TESTCASE_BULK_DRAFT_KEY);
  } catch {}
}

/* ---------- panel ---------- */

let testcaseTaskId = null; // task yang panel Test cases-nya terbuka
let testcaseHasil = null;  // { taskId, text, parsed, pilih: [bool] } — parse terakhir
// Dry run terakhir: { taskId, sig, loading, error, rinci, data }. sig = isi case
// terpilih saat dikirim; hasil hanya tampil selama pilihan/isi masih sama.
let testcaseDry = null;
// Push terakhir: { taskId, loading, error, data } — tetap tampil walau draft
// sudah dibersihkan setelah push sukses.
let testcasePush = null;
// Riwayat dari Worker: { taskId, key, loading, error, data: { existing, history } }.
let testcaseRiwayat = null;

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
  btn.onclick = () => {
    testcaseTaskId = terbuka ? null : t.id;
    renderLaluFokus(btn.id);
    if (!terbuka) muatRiwayatTestCase(t);
  };
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
    "atau JSON " + TESTCASE_FORMAT + ". Parse hanya di perangkat ini; Dry run mengecek ke Jira/QAlity tanpa membuat apa pun; " +
    "Push baru menulis ke QAlity setelah dikonfirmasi."));

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
    const parsed = parseTestCasesUntukTiket(ta.value, key);
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

  const push = testcasePush && testcasePush.taskId === t.id ? testcasePush : null;
  if (push && (push.error || push.data)) panel.append(hasilPushTestCase(t, push));
  if (hasil) panel.append(pratinjauTestCase(t, hasil));
  panel.append(riwayatTestCase(t));
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
  if (parsed.info) wrap.append(el("p", "testcase-hint testcase-bundle-info", parsed.info));
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
  if (d && d.data) box.append(rencanaTestCase(d.data, t, dipilih));
  return box;
}

// Satu request Dry run untuk satu tiket → { data } atau { error, rinci }.
async function previewTestCase(key, cases) {
  try {
    const r = await fetch(jiraProxy() + "/testcases/preview", {
      method: "POST", headers: { "Content-Type": "application/json", ...headerAkses() },
      body: JSON.stringify({ issueKey: key, cases: kirimanTestCase(cases) }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d && Array.isArray(d.plan)) return { data: d };
    const rinci = [...(Array.isArray(d.errors) ? d.errors : [])];
    (Array.isArray(d.cases) ? d.cases : []).forEach((c, i) => {
      for (const e of (c && Array.isArray(c.errors) ? c.errors : [])) rinci.push("“" + ((cases[i] && cases[i].title) || "#" + (i + 1)) + "”: " + e);
    });
    return { error: "Dry run gagal: " + (d.error || "HTTP " + r.status), rinci };
  } catch (e) {
    return { error: "Dry run gagal: " + ((e && e.message) || "koneksi"), rinci: [] };
  }
}

async function jalankanDryRun(t, key, cases, sig) {
  const masihSama = () => testcaseDry && testcaseDry.taskId === t.id && testcaseDry.sig === sig;
  testcaseDry = { taskId: t.id, sig, loading: true, error: "", rinci: [], data: null };
  renderLaluFokus("tc-dry-" + t.id);
  const hasil = await previewTestCase(key, cases);
  if (!masihSama()) return; // pilihan/isi berubah selama request — hasil lama dibuang
  testcaseDry = { taskId: t.id, sig, loading: false, error: hasil.error || "", rinci: hasil.rinci || [], data: hasil.data || null };
  if (testcaseTaskId === t.id) renderLaluFokus("tc-dry-" + t.id);
}

function rencanaTestCase(d, t, dipilih) {
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
    head.append(el("span", "testcase-badge" + (buat ? " create" : ""), buat ? "Create" : p.action === "skip_busy" ? "Busy" : "Skip"),
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
  wrap.append(el("p", "testcase-hint", "Dry run tidak membuat apa pun di Jira/QAlity."));
  if (t && n.create > 0) {
    const p = testcasePush && testcasePush.taskId === t.id ? testcasePush : null;
    const bar = el("div", "testcase-actions");
    const btn = el("button", "btn-solid", p && p.loading ? "Pushing…" : "Push " + n.create + " to QAlity");
    btn.type = "button"; btn.id = "tc-push-" + t.id;
    btn.title = "Buat test case di QAlity lalu link ke " + d.issueKey;
    btn.disabled = !jiraProxy() || !!(p && p.loading);
    btn.onclick = () => jalankanPushTestCase(t, d, dipilih);
    bar.append(btn);
    wrap.append(bar);
  }
  return wrap;
}

/* ---------- push (Worker menulis ke QAlity + Jira) ---------- */

const TC_STATUS = {
  created_linked: ["Linked", " create"], created_unlinked: ["Unlinked", " warn"], link_unverified: ["Unverified", " warn"],
  pending: ["Pending", " warn"], failed: ["Failed", " err"], skipped_duplicate: ["Skipped", ""], skipped_busy: ["Busy", " warn"],
};
const TC_PERLU_LINK = ["created_unlinked", "link_unverified"];
const TC_BERES = ["created_linked", "skipped_duplicate"];
const pushBeresTestCase = (data) => data.results.every((x) => TC_BERES.includes(x.status));

// Satu request Push untuk satu tiket → { data } atau { error }. `saran` =
// langkah aman bila jaringan putus (hasil import tidak diketahui).
async function pushTestCase(key, cases, previewHash, saran) {
  try {
    const r = await fetch(jiraProxy() + "/testcases/push", {
      method: "POST", headers: { "Content-Type": "application/json", ...headerAkses() },
      body: JSON.stringify({ issueKey: key, cases: kirimanTestCase(cases), previewHash }),
    });
    const b = await r.json().catch(() => ({}));
    if (r.ok && b && Array.isArray(b.results)) return { data: b };
    if (r.status === 404) return { error: "Push belum diaktifkan di Worker (flag TESTCASE_PUSH_ENABLED mati). Dry run tetap bisa dipakai." };
    return { error: "Push gagal: " + (b.error || "HTTP " + r.status) };
  } catch (e) {
    return { error: "Push gagal: " + ((e && e.message) || "koneksi") + ". " + saran };
  }
}

async function jalankanPushTestCase(t, d, cases) {
  const key = d.issueKey;
  const n = (d.counts && d.counts.create) || 0;
  if (!confirm("Buat " + n + " test case di QAlity (project " + ((d.project && d.project.key) || "?") + ") lalu link “" +
    (d.linkType || "QAlity Test") + "” ke " + key + "?\n\nIni menulis ke Jira/QAlity dan tidak dihapus otomatis.")) return;
  testcasePush = { taskId: t.id, loading: true, error: "", data: null };
  renderLaluFokus("tc-push-" + t.id);
  const hasil = await pushTestCase(key, cases, d.previewHash, "Cek History sebelum mencoba lagi — bisa saja sebagian sudah terbuat.");
  testcasePush = { taskId: t.id, loading: false, error: hasil.error || "", data: hasil.data || null };
  if (hasil.data) {
    // Rencana lama sudah dipakai; Dry run ulang akan menunjukkan sisanya.
    if (testcaseDry && testcaseDry.taskId === t.id) testcaseDry = null;
    if (pushBeresTestCase(hasil.data)) {
      simpanDraftTestCase(t.id, "");
      if (testcaseHasil && testcaseHasil.taskId === t.id) testcaseHasil = null;
    }
  }
  if (testcaseTaskId === t.id) renderLaluFokus("tc-pushres-" + t.id);
  if (hasil.data) muatRiwayatTestCase(t);
}

function tautanTiket(key) {
  if (!key) return el("span", "testcase-empty", "—");
  if (!jiraSite()) return el("span", "jira-key", key);
  const a = el("a", "jira-key", key);
  a.href = jiraUrl(key); a.target = "_blank"; a.rel = "noopener";
  return a;
}

function barisStatusTestCase(status, title, testKey, error) {
  const li = el("li", "testcase-row");
  const [label, kelas] = TC_STATUS[status] || [status || "?", ""];
  li.append(el("span", "testcase-badge" + kelas, label), tautanTiket(testKey), el("span", "testcase-title", title || ""));
  if (error) li.append(el("p", "testcase-hint", error));
  return li;
}

function hasilPushTestCase(t, p) {
  const wrap = el("div", "testcase-pushres");
  wrap.id = "tc-pushres-" + t.id;
  wrap.tabIndex = -1;
  wrap.setAttribute("role", "status");
  if (p.error) { wrap.append(daftarIsuTestCase([p.error], "err")); return wrap; }
  const d = p.data;
  const n = d.counts || {};
  const bagian = Object.keys(TC_STATUS).filter((s) => n[s]).map((s) => n[s] + " " + TC_STATUS[s][0].toLowerCase());
  const ok = pushBeresTestCase(d);
  wrap.append(el("p", "testcase-status" + (ok ? " ok" : ""), "Push selesai — " + bagian.join(", ") + "." +
    (ok ? " Draft dibersihkan." : " Draft disimpan; yang Unlinked/Unverified bisa di-Retry link di History.")));
  const ul = el("ul", "testcase-rows");
  for (const x of d.results) ul.append(barisStatusTestCase(x.status, x.title, x.testKey, x.error));
  wrap.append(ul);
  if (Array.isArray(d.unmappedKeys) && d.unmappedKeys.length) {
    wrap.append(el("p", "testcase-hint", "QAlity juga mengembalikan " + d.unmappedKeys.join(", ") +
      " yang tidak cocok ke case mana pun — sudah di-link ke " + d.issueKey + "; cek di Jira."));
  }
  return wrap;
}

/* ---------- riwayat (GET /testcases) + Retry link ---------- */

async function muatRiwayatTestCase(t) {
  const key = keyTestCase(t);
  if (!key || !jiraProxy()) return;
  const lama = testcaseRiwayat && testcaseRiwayat.taskId === t.id ? testcaseRiwayat.data : null;
  testcaseRiwayat = { taskId: t.id, key, loading: true, error: "", data: lama };
  gantiRiwayatTestCase(t);
  let hasil;
  try {
    const r = await fetch(jiraProxy() + "/testcases?issue=" + encodeURIComponent(key), { headers: headerAkses() });
    const d = await r.json().catch(() => ({}));
    hasil = r.ok && d && Array.isArray(d.history) ? { data: d } : { error: d.error || "HTTP " + r.status };
  } catch (e) {
    hasil = { error: (e && e.message) || "koneksi" };
  }
  if (!testcaseRiwayat || testcaseRiwayat.taskId !== t.id) return;
  testcaseRiwayat = { taskId: t.id, key, loading: false, error: hasil.error || "", data: hasil.data || lama };
  gantiRiwayatTestCase(t);
}

// Hanya bagian History yang diganti — render() penuh akan membuang fokus/
// kursor textarea yang mungkin sedang dipakai saat riwayat selesai dimuat.
function gantiRiwayatTestCase(t) {
  const n = document.getElementById("tc-hist-" + t.id);
  if (n) n.replaceWith(riwayatTestCase(t));
}

// POST /testcases/relink → { data: { status, error, … } } atau { error }.
async function relinkTestCase(key, testKey) {
  try {
    const r = await fetch(jiraProxy() + "/testcases/relink", {
      method: "POST", headers: { "Content-Type": "application/json", ...headerAkses() },
      body: JSON.stringify({ issueKey: key, testKey }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d || typeof d.status !== "string") return { error: d.error || "HTTP " + r.status };
    return { data: d };
  } catch (e) {
    return { error: (e && e.message) || "koneksi" };
  }
}

async function ulangLinkTestCase(t, key, testKey, btn) {
  btn.disabled = true; btn.textContent = "Linking…";
  const h = await relinkTestCase(key, testKey);
  if (h.error) alert("Retry link gagal: " + h.error);
  else if (h.data.status !== "created_linked") alert("Link " + testKey + " belum terverifikasi: " + (h.data.error || h.data.status));
  await muatRiwayatTestCase(t);
}

function riwayatTestCase(t) {
  const key = keyTestCase(t);
  const st = testcaseRiwayat && testcaseRiwayat.taskId === t.id ? testcaseRiwayat : null;
  const box = el("div", "testcase-history");
  box.id = "tc-hist-" + t.id;
  const head = el("div", "testcase-plan-head");
  head.append(el("strong", "testcase-title", "History"));
  const muat = el("button", "btn-line", st && st.loading ? "Loading…" : "Refresh");
  muat.type = "button";
  muat.disabled = !jiraProxy() || !!(st && st.loading);
  muat.onclick = () => muatRiwayatTestCase(t);
  head.append(muat);
  box.append(head);
  if (!jiraProxy()) { box.append(el("p", "testcase-hint", "Riwayat push butuh sign in (Settings → Account).")); return box; }
  if (st && st.error) box.append(daftarIsuTestCase(["Riwayat gagal dimuat: " + st.error], "err"));
  const d = st && st.data;
  if (!d) {
    if (!st) box.append(el("p", "testcase-hint", "Klik Refresh untuk melihat test case yang sudah ter-link ke " + key + "."));
    return box;
  }
  if (Array.isArray(d.existing) && d.existing.length) {
    const p = el("p", "testcase-hint", "Ter-link ke " + d.issueKey + ": ");
    d.existing.forEach((x, i) => { if (i) p.append(", "); p.append(tautanTiket(x.key)); });
    box.append(p);
  }
  if (!d.history.length) {
    box.append(el("p", "testcase-hint", "Belum ada push dari CATET untuk " + d.issueKey + "."));
    return box;
  }
  const ul = el("ul", "testcase-rows");
  for (const h of d.history) {
    const li = barisStatusTestCase(h.status, h.title, h.test_key, h.error);
    if (h.test_key && TC_PERLU_LINK.includes(h.status)) {
      const btn = el("button", "btn-line", "Retry link");
      btn.type = "button";
      btn.title = "Link ulang " + h.test_key + " ke " + d.issueKey + " lalu baca balik";
      btn.onclick = () => ulangLinkTestCase(t, d.issueKey, h.test_key, btn);
      li.insertBefore(btn, li.querySelector(".testcase-hint"));
    }
    ul.append(li);
  }
  box.append(ul);
  return box;
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
    : "Belum diisi — dibutuhkan untuk Dry run & Push test case.";
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
      if (!confirm("Hapus token QAlity dari server? Dry run & Push tidak bisa dipakai sampai token diisi lagi.")) return;
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

/* ---------- mode banyak tiket: tab Jira → Test cases ---------- */

// { text, parsed, pilihTiket: [bool], pilih: [[bool]],
//   dry: { key → { sig, loading, error, rinci, data } },
//   push: { key → { loading, error, data, notTried } }, urutan: [key] (urutan hasil push),
//   jalan: null | "dry" | "push", progres: "Checking 2/3 — …" }
let testcaseBulk = null;
function resetTestCaseBulk() { testcaseBulk = null; } // sign out / ganti akun

function renderTestCaseBulk(wrap) {
  const b = testcaseBulk;
  const sec = el("section", "section s-jira testcase-bulk");
  sec.id = "tcb";
  const head = el("div", "section-head");
  head.append(el("h2", null, "Test cases — multiple tickets"));
  sec.append(head);
  sec.append(el("p", "testcase-hint",
    "Tempel JSON hasil AI berisi beberapa tiket: [{ task_id, task_name, endpoint, test_cases: [...] }]. Parse hanya di perangkat ini; " +
    "Dry run all mengecek tiap tiket ke Jira/QAlity tanpa membuat apa pun; Push all baru menulis setelah dikonfirmasi, satu tiket per request, berurutan."));

  const ta = document.createElement("textarea");
  ta.className = "testcase-input";
  ta.id = "tcb-input";
  ta.rows = 10; ta.spellcheck = false;
  ta.setAttribute("aria-label", "JSON test case banyak tiket");
  ta.placeholder = '[\n  {\n    "task_id": "ABC-101",\n    "task_name": "…",\n    "test_cases": [\n' +
    '      { "title": "Verify …", "precondition": "…", "test_steps": ["…"], "expected_result": ["…"] }\n    ]\n  }\n]';
  ta.value = bacaDraftBulkTestCase();
  const basi = el("p", "testcase-stale", "Teks berubah sejak Parse terakhir — klik Parse lagi supaya pratinjau sesuai.");
  basi.setAttribute("role", "status");
  const cekBasi = () => basi.classList.toggle("hidden", !(b && b.parsed) || ta.value === b.text);
  ta.oninput = () => { simpanDraftBulkTestCase(ta.value); cekBasi(); };
  cekBasi();
  sec.append(ta, basi);

  const sibuk = !!(b && b.jalan);
  const aksi = el("div", "testcase-actions");
  const parseBtn = el("button", "btn-solid", "Parse");
  parseBtn.type = "button"; parseBtn.id = "tcb-parse"; parseBtn.disabled = sibuk;
  parseBtn.onclick = () => {
    const lama = testcaseBulk;
    if (lama && lama.jalan) return;
    const parsed = parseTestCaseBundle(ta.value);
    simpanDraftBulkTestCase(ta.value);
    const sama = !!lama && lama.text === ta.value;
    testcaseBulk = {
      text: ta.value, parsed,
      pilihTiket: parsed.groups.map(() => true),
      pilih: parsed.groups.map((g) => g.cases.map(() => true)),
      // Dry run lama tetap dipakai selama sig-nya sama; hasil push hanya untuk tempelan yang sama.
      dry: lama ? lama.dry : {}, push: sama ? lama.push : {}, urutan: sama ? lama.urutan : [],
      jalan: null, progres: "",
    };
    renderLaluFokus(parseBtn.id);
  };
  const clearBtn = el("button", "btn-line", "Clear");
  clearBtn.type = "button"; clearBtn.id = "tcb-clear"; clearBtn.disabled = sibuk;
  clearBtn.onclick = () => {
    if (testcaseBulk && testcaseBulk.jalan) return;
    if (ta.value.trim() && !confirm("Kosongkan teks, pratinjau, dan hasil test case banyak tiket?")) return;
    simpanDraftBulkTestCase("");
    testcaseBulk = null;
    renderLaluFokus(ta.id);
  };
  aksi.append(parseBtn, clearBtn);
  sec.append(aksi);

  if (b && b.urutan.length) sec.append(hasilPushBulkTestCase(b));
  if (b && b.parsed) sec.append(pratinjauBulkTestCase(b));
  wrap.append(sec);
}

function pratinjauBulkTestCase(b) {
  const { parsed } = b;
  const wrap = el("div", "testcase-preview");
  wrap.setAttribute("aria-live", "polite");
  const cek = cekBundleTestCase(parsed, b.pilihTiket, b.pilih);
  if (cek.errors.length) wrap.append(daftarIsuTestCase(cek.errors, "err"));
  if (!parsed.groups.length) return wrap;

  const nPilih = b.pilihTiket.filter(Boolean).length;
  const siapList = cek.groups.filter((c) => c.siap);
  const nTahan = nPilih - siapList.length;
  const ringkas = el("div", "testcase-summary");
  ringkas.append(
    el("span", "testcase-chip", parsed.groups.length + (parsed.groups.length === 1 ? " ticket" : " tickets")),
    el("span", "testcase-chip", nPilih + " selected"),
    el("span", "testcase-chip" + (nTahan ? " err" : ""), nTahan + " blocked"));
  wrap.append(ringkas);

  const ol = el("ol", "testcase-groups");
  parsed.groups.forEach((g, i) => ol.append(kelompokBulkTestCase(b, g, i, cek.groups[i])));
  wrap.append(ol);

  const siap = cek.ok && siapList.length > 0;
  const nCase = siapList.reduce((s, c) => s + c.dipilih.length, 0);
  wrap.append(el("p", "testcase-status" + (siap ? " ok" : ""), !cek.ok
    ? "Perbaiki error di atas dulu — semua tiket tertahan."
    : siap ? siapList.length + " tiket siap (" + nCase + " case)." + (nTahan ? " " + nTahan + " tiket bertanda Error tidak ikut." : "") +
      " Dry run all mengecek project, duplikat, dan judul Jira tiap tiket."
    : "Belum ada tiket yang siap — perbaiki yang bertanda Error atau hapus centangnya."));
  if (siap) {
    const rencana = rencanaPushBundle(parsed, b.pilihTiket, b.pilih, b.dry);
    const bar = el("div", "testcase-actions");
    // aria-disabled (bukan disabled) selama berjalan supaya fokus keyboard tidak hilang.
    const dry = el("button", "btn-solid", b.jalan === "dry" ? "Checking…" : "Dry run all");
    dry.type = "button"; dry.id = "tcb-dry";
    dry.title = "Cek tiap tiket ke Jira & QAlity tanpa membuat apa pun";
    dry.disabled = !jiraProxy();
    dry.setAttribute("aria-disabled", String(!!b.jalan));
    dry.onclick = () => dryRunSemuaTestCase();
    bar.append(dry);
    if (rencana.siap.length || b.jalan === "push") {
      const push = el("button", "btn-solid", b.jalan === "push" ? "Pushing…" : "Push all");
      push.type = "button"; push.id = "tcb-push";
      push.title = "Buat test case di QAlity lalu link ke tiketnya, satu tiket per request";
      push.disabled = !jiraProxy();
      push.setAttribute("aria-disabled", String(!!b.jalan));
      push.onclick = () => pushSemuaTestCase();
      bar.append(push);
    }
    wrap.append(bar);
    if (rencana.siap.length && !b.jalan) {
      wrap.append(el("p", "testcase-hint", "Siap push: " + rencana.siap.map((x) => x.key + " (" + x.n + " case)").join(", ") + "."));
    }
    if (!jiraProxy()) wrap.append(el("p", "testcase-hint", "Dry run butuh sign in (Settings → Account) dan token QAlity."));
  }
  if (b.jalan) {
    const p = el("p", "testcase-hint testcase-progress", b.progres);
    p.setAttribute("role", "status");
    wrap.append(p);
  }
  return wrap;
}

function kelompokBulkTestCase(b, g, i, c) {
  const aktif = !!b.pilihTiket[i];
  const li = el("li", "testcase-group" + (!aktif ? " excluded" : c.siap ? "" : " has-error"));
  li.id = "tcb-group-" + i;
  const head = el("label", "testcase-group-head");
  const cb = document.createElement("input");
  cb.type = "checkbox"; cb.checked = aktif; cb.id = "tcb-tiket-" + i; cb.disabled = !!b.jalan;
  cb.setAttribute("aria-label", "Ikutkan " + (g.key || "tiket #" + (i + 1)));
  cb.onchange = () => { b.pilihTiket[i] = cb.checked; renderLaluFokus(cb.id); };
  head.append(cb, el("span", "jira-key", g.key || "?"),
    el("span", "testcase-group-name" + (g.taskName ? "" : " empty"), g.taskName || "(tanpa task_name)"));
  if (!aktif) head.append(el("span", "testcase-badge", "Excluded"));
  li.append(head);
  if (g.endpoint) li.append(el("p", "testcase-hint mono", g.endpoint));

  const pilih = b.pilih[i];
  let j = 0;
  const isu = g.cases.map((_, k) => (pilih[k] ? c.v.cases[j++] : null));
  const nErr = c.errors.length + isu.filter((x) => x && x.errors.length).length;
  const nWarn = isu.filter((x) => x && x.warnings.length).length;
  const chips = el("div", "testcase-summary");
  chips.append(
    el("span", "testcase-chip", g.cases.length + (g.cases.length === 1 ? " case" : " cases")),
    el("span", "testcase-chip", c.dipilih.length + " selected"),
    el("span", "testcase-chip" + (nErr ? " err" : ""), nErr + (nErr === 1 ? " error" : " errors")),
    el("span", "testcase-chip" + (nWarn ? " warn" : ""), nWarn + (nWarn === 1 ? " warning" : " warnings")));
  li.append(chips);
  if (c.errors.length) li.append(daftarIsuTestCase(c.errors, "err"));
  if (g.cases.length) {
    const ol = el("ol", "testcase-list");
    g.cases.forEach((x, k) => ol.append(kartuTestCase({ id: "tcb" + i }, x, k, pilih, isu[k])));
    if (b.jalan) ol.querySelectorAll("input").forEach((n) => { n.disabled = true; });
    li.append(ol);
  }
  // Hasil Dry run hanya tampil selama isi + centang tiket ini masih sama.
  const d = aktif && b.dry[g.key];
  if (d && d.sig === sigTestCase(g.key, c.dipilih)) {
    if (d.loading) li.append(el("p", "testcase-hint", "Checking…"));
    if (d.error) li.append(daftarIsuTestCase([d.error, ...d.rinci], "err"));
    if (d.data) li.append(judulJiraTestCase(d.data, g.taskName), rencanaTestCase(d.data, null, c.dipilih));
  }
  return li;
}

// K2: judul tiket asli dari Jira di samping task_name dari AI.
function judulJiraTestCase(d, taskName) {
  const box = el("div", "testcase-jira-title");
  if (typeof d.issueSummary !== "string") {
    box.append(el("p", "testcase-hint", "Judul Jira belum tersedia (Worker belum diperbarui)."));
    return box;
  }
  const p = el("p", "testcase-hint");
  p.append("Judul Jira: ", el("strong", null, d.issueSummary || "(kosong)"));
  box.append(p);
  if (taskName && !judulMiripTestCase(taskName, d.issueSummary)) {
    box.append(daftarIsuTestCase(["Judul Jira beda dengan task_name dari AI (“" + taskName + "”) — pastikan task_id-nya benar."], "warn"));
  }
  return box;
}

// Dry run all: satu POST /testcases/preview per tiket siap, berurutan. Tiket
// yang gagal hanya menahan dirinya sendiri.
async function dryRunSemuaTestCase() {
  const b = testcaseBulk;
  if (!b || !b.parsed || b.jalan || !jiraProxy()) return;
  const cek = cekBundleTestCase(b.parsed, b.pilihTiket, b.pilih);
  if (!cek.ok) return;
  const antre = b.parsed.groups.map((g, i) => ({ key: g.key, cases: cek.groups[i].dipilih })).filter((_, i) => cek.groups[i].siap);
  if (!antre.length) return;
  b.jalan = "dry";
  for (const [n, x] of antre.entries()) {
    const sig = sigTestCase(x.key, x.cases);
    b.progres = "Checking " + (n + 1) + "/" + antre.length + " — " + x.key + "…";
    b.dry[x.key] = { sig, loading: true, error: "", rinci: [], data: null };
    render();
    const h = await previewTestCase(x.key, x.cases);
    if (testcaseBulk !== b) return; // Clear / ganti akun selama request
    b.dry[x.key] = { sig, loading: false, error: h.error || "", rinci: h.rinci || [], data: h.data || null };
  }
  b.jalan = null; b.progres = "";
  render();
}

// Push all: satu konfirmasi, lalu satu POST /testcases/push per tiket (dengan
// previewHash miliknya), berurutan. Berhenti — sisanya Not tried — bila respons
// bukan 200/jaringan putus, atau ada hasil failed/pending.
async function pushSemuaTestCase() {
  const b = testcaseBulk;
  if (!b || !b.parsed || b.jalan || !jiraProxy()) return;
  const { siap, kecuali } = rencanaPushBundle(b.parsed, b.pilihTiket, b.pilih, b.dry);
  if (!siap.length) return;
  const total = siap.reduce((s, x) => s + x.n, 0);
  if (!confirm("Buat " + total + " test case di QAlity lalu link “QAlity Test” ke tiketnya?\n\n" +
    siap.map((x) => x.key + ": " + x.n + " case (project " + ((x.d.project && x.d.project.key) || "?") + ")").join("\n") +
    (kecuali.length ? "\n\nTidak ikut:\n" + kecuali.map((x) => x.key + ": " + x.alasan).join("\n") : "") +
    "\n\nSatu tiket per request, berurutan; berhenti bila ada yang gagal. Ini menulis ke Jira/QAlity dan tidak dihapus otomatis.")) return;
  b.jalan = "push";
  let henti = null;
  for (const [n, x] of siap.entries()) {
    if (!b.urutan.includes(x.key)) b.urutan.push(x.key);
    if (henti) {
      b.push[x.key] = { notTried: true, error: "Tidak dicoba — Push all berhenti setelah " + henti + " gagal atau hasilnya belum pasti." };
      continue;
    }
    b.progres = "Pushing " + (n + 1) + "/" + siap.length + " — " + x.key + "…";
    b.push[x.key] = { loading: true };
    render();
    const h = await pushTestCase(x.key, x.cases, x.d.previewHash, "Dry run all lagi sebelum mencoba — bisa saja sebagian sudah terbuat.");
    if (testcaseBulk !== b) return;
    b.push[x.key] = { error: h.error || "", data: h.data || null };
    if (h.data) delete b.dry[x.key]; // rencana sudah dipakai; Dry run ulang menunjukkan sisanya
    if (!h.data || h.data.results.some((r) => r.status === "failed" || r.status === "pending")) henti = x.key;
  }
  b.jalan = null; b.progres = "";
  // Draft dibersihkan hanya bila SEMUA tiket di tempelan beres.
  if (b.parsed.groups.every((g) => b.push[g.key] && b.push[g.key].data && pushBeresTestCase(b.push[g.key].data))) {
    simpanDraftBulkTestCase("");
    b.text = ""; b.parsed = null; b.pilihTiket = []; b.pilih = [];
  }
  renderLaluFokus("tcb-pushres");
}

function hasilPushBulkTestCase(b) {
  const wrap = el("div", "testcase-pushres");
  wrap.id = "tcb-pushres";
  wrap.tabIndex = -1;
  wrap.setAttribute("role", "status");
  const head = el("div", "testcase-plan-head");
  head.append(el("strong", "testcase-title", "Push results"));
  wrap.append(head);
  const hasil = b.urutan.map((key) => [key, b.push[key] || {}]);
  if (b.jalan !== "push") {
    const beres = hasil.filter(([, p]) => p.data && pushBeresTestCase(p.data)).length;
    const lewat = hasil.filter(([, p]) => p.notTried).length;
    const masalah = hasil.length - beres - lewat;
    wrap.append(el("p", "testcase-status" + (masalah || lewat ? "" : " ok"),
      "Push selesai — " + beres + " tiket beres" + (masalah ? ", " + masalah + " bermasalah" : "") + (lewat ? ", " + lewat + " tidak dicoba" : "") + "." +
      (b.parsed ? " Draft disimpan; perbaiki lalu Dry run all + Push all lagi untuk sisanya." : " Semua tiket beres — draft dibersihkan.")));
  }
  for (const [key, p] of hasil) {
    const box = el("div", "testcase-push-ticket");
    const st = p.data ? p.data.results.map((x) => x.status) : [];
    const [label, kelas] = p.loading ? ["Pushing…", ""] : p.notTried ? ["Not tried", " not-tried"]
      : p.error || st.includes("failed") ? ["Failed", " err"] : p.data && pushBeresTestCase(p.data) ? ["Done", " create"] : ["Check", " warn"];
    const h = el("div", "testcase-plan-head");
    h.append(tautanTiket(key), el("span", "testcase-badge" + kelas, label));
    box.append(h);
    if (p.error) box.append(p.notTried ? el("p", "testcase-hint", p.error) : daftarIsuTestCase([p.error], "err"));
    if (p.data) {
      const ul = el("ul", "testcase-rows");
      for (const x of p.data.results) {
        const li = barisStatusTestCase(x.status, x.title, x.testKey, x.error);
        if (x.testKey && TC_PERLU_LINK.includes(x.status)) {
          const btn = el("button", "btn-line", "Retry link");
          btn.type = "button";
          btn.disabled = !!b.jalan || !jiraProxy();
          btn.title = "Link ulang " + x.testKey + " ke " + key + " lalu baca balik";
          btn.onclick = () => ulangLinkBulkTestCase(b, key, x, btn);
          li.insertBefore(btn, li.querySelector(".testcase-hint"));
        }
        ul.append(li);
      }
      box.append(ul);
      if (Array.isArray(p.data.unmappedKeys) && p.data.unmappedKeys.length) {
        box.append(el("p", "testcase-hint", "QAlity juga mengembalikan " + p.data.unmappedKeys.join(", ") +
          " yang tidak cocok ke case mana pun — sudah di-link ke " + key + "; cek di Jira."));
      }
    }
    wrap.append(box);
  }
  return wrap;
}

// Retry link di hasil Push all — tiketnya belum tentu ada sebagai task CATET,
// jadi status baris diperbarui di sini, bukan lewat History panel per task.
async function ulangLinkBulkTestCase(b, key, x, btn) {
  btn.disabled = true; btn.textContent = "Linking…";
  const h = await relinkTestCase(key, x.testKey);
  if (h.data) { x.status = h.data.status; x.error = h.data.error || null; }
  else x.error = "Retry link gagal: " + h.error;
  if (testcaseBulk === b) renderLaluFokus("tcb-pushres");
}
