// jira.js — integrasi Jira: autolink kode tiket, inbox "belum diambil",
// impor tempel-manual, dan sinkronisasi otomatis lewat proxy Cloudflare Worker
// (lihat worker/README.md). Kunci localStorage: catet.jira.v1.
"use strict";

/* ---------- Jira: autolink + inbox tiket ---------- */
const JIRA_KEY_STORE = "catet.jira.v1";
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
  j.dismissed = j.dismissed || [];
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

/* ---------- sinkronisasi otomatis lewat proxy (Cloudflare Worker) ---------- */
// Alamat proxy bawaan — semua perangkat otomatis tersambung tanpa setup apa
// pun. Otorisasi di Worker berbasis Origin, jadi tidak ada kunci rahasia di
// sini. (jira.proxy hanya dipakai kalau seseorang sengaja memasang Worker
// sendiri dan mengisinya lewat konsol.)
const DEFAULT_PROXY = "https://catet-jira-proxy.zackyanto-leo.workers.dev";
function jiraProxy() { return (jira.proxy || DEFAULT_PROXY).trim().replace(/\/+$/, ""); }
let jiraSyncMsg = "";
let jiraSyncing = false;
async function syncJira(manual) {
  if (!jiraProxy()) {
    if (manual) alert("Isi dulu alamat proxy + kunci di panel “impor tiket” (lihat worker/README.md di repo).");
    return;
  }
  if (jiraSyncing) return;
  jiraSyncing = true;
  jiraSyncMsg = "menarik…";
  if (view === "papan" || view === "jira") render();
  try {
    const r = await fetch(jiraProxy() + "/tickets");
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
    jira.lastSync = new Date().toISOString();
    jiraSyncMsg = "";
    saveJira(true); // penyegaran mesin — jangan klaim dirty
    syncBau(false); // topik BAU ikut segar (throttle 6 jam di dalamnya)
  } catch (e) {
    jiraSyncMsg = "gagal: " + (e && e.message ? e.message : "koneksi");
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
  bauSyncMsg = "menarik…";
  if (view === "jira") render();
  try {
    const r = await fetch(jiraProxy() + "/bau?project=" + encodeURIComponent(proj));
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
    jira.bau.items = Array.isArray(data.items) ? data.items : [];
    jira.bau.lastSync = new Date().toISOString();
    bauSyncMsg = "";
    saveJira(true); // penyegaran mesin — jangan klaim dirty
  } catch (e) {
    bauSyncMsg = "gagal: " + (e && e.message ? e.message : "koneksi");
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
  cari.type = "search"; cari.placeholder = "Cari topik…";
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
    reset.append(el("span", null, "↺ Kembali ke pencocokan otomatis"));
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
  head.append(el("h2", null, "Topik BAU — worklog non-sprint"));
  if (jira.bau.items.length) head.append(el("span", "count mono", String(jira.bau.items.length)));
  if (jiraProxy() && jira.bau.project) {
    const refresh = el("button", "clear-done", bauSyncing ? "menarik…" : "⟳ tarik topik");
    refresh.onclick = () => syncBau(true);
    head.append(refresh);
    if (bauSyncMsg && !bauSyncing) head.append(el("span", "count", bauSyncMsg));
    else if (jira.bau.lastSync && !bauSyncing) head.append(el("span", "count mono", "sinkron " + fmtAgo(jira.bau.lastSync)));
  }
  sec.append(head);

  const det = document.createElement("details");
  det.className = "routine-manage";
  det.open = !jira.bau.project; // belum diset → langsung terbuka
  const sum = document.createElement("summary");
  sum.textContent = jira.bau.project ? "pengaturan topik BAU" :
    "+ set project BAU (mis. TDBU) — worklog meeting/deployment/dll. di luar sprint";
  det.append(sum);
  const editor = el("div", "routine-editor");
  const form = el("div", "routine-form");
  const projIn = document.createElement("input");
  projIn.type = "text"; projIn.value = jira.bau.project || "";
  projIn.placeholder = "Key project BAU… mis. TDBU";
  projIn.title = "Project Jira berisi tiket topik (Team Meeting, Deployment, dst.)";
  const setBtn = el("button", "btn-solid", "Simpan & tarik topik");
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
    sum2.append("daftar topik ", el("span", "count mono", String(jira.bau.items.length)));
    det2.append(sum2, card);
    sec.append(det2);
  }
  wrap.append(sec);
}

/* ---------- sprint bar (di atas daftar tiket) ---------- */
let sprintFormOpen = false;
let sprintEditId = null; // satu sprint yang panel editnya terbuka (biar tak ambigu)

// Baris satu sprint + panel edit (nama, tanggal, daftar task, selesai/hapus).
function sprintRow(s, sec) {
  const row = el("div", "jira-row");
  const body = el("span", "jira-summary");
  body.append(el("strong", null, s.nama));
  row.append(body);
  const badge = el("span", "due-badge mono" + (sprintPtsUntukBadge(s) >= 3 ? " late" : ""),
    "🏁 " + fmtDayName(s.selesai) + " · " + fmtSisaSprint(s));
  row.append(badge);
  const jml = jumlahTugasSprint(s.id);
  row.append(el("span", "jira-status", jml + " tugas"));

  const edit = el("button", "icon-btn" + (sprintEditId === s.id ? " in-sprint" : ""), "✎");
  edit.title = "Ubah sprint / lihat isinya"; edit.setAttribute("aria-label", edit.title);
  edit.onclick = () => { sprintEditId = sprintEditId === s.id ? null : s.id; render(); };
  row.append(edit);
  sec.append(row);

  if (sprintEditId !== s.id) return;

  // ----- panel edit sprint -----
  const ed = el("div", "task-editor");
  ed.style.borderLeft = "3px solid var(--p-tinggi)";
  ed.style.paddingLeft = "10px";

  const grpNama = el("div", "cap-group");
  grpNama.append(el("span", "cap-label", "Nama"));
  const namaIn = document.createElement("input");
  namaIn.type = "text"; namaIn.value = s.nama; namaIn.className = "sprint-edit-nama";
  const simpanNama = () => { const v = namaIn.value.trim(); if (v && v !== s.nama) { s.nama = v; saveSprints(); render(); } };
  namaIn.onblur = simpanNama;
  namaIn.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); namaIn.blur(); } };
  grpNama.append(namaIn);
  ed.append(grpNama);

  const grpTgl = el("div", "cap-group");
  grpTgl.append(el("span", "cap-label", "Selesai"));
  const tglIn = document.createElement("input");
  tglIn.type = "date"; tglIn.value = s.selesai;
  tglIn.onchange = (e) => { if (e.target.value) { s.selesai = e.target.value; saveSprints(); render(); } };
  grpTgl.append(tglIn);
  ed.append(grpTgl);

  // daftar task di sprint ini
  const anggota = tasks.filter((t) => t.sprintId === s.id);
  const lbl = el("div", "cap-label"); lbl.style.marginTop = "2px";
  lbl.textContent = "Isi sprint (" + anggota.length + ")";
  ed.append(lbl);
  if (anggota.length) {
    const ul = el("ul", "sprint-tasks");
    anggota.sort(bandingkanTugas).forEach((t) => {
      const li = el("li");
      li.append(el("span", "sprint-task-dot p-" + t.priority));
      const tx = el("span", "sprint-task-text" + (t.status === "selesai" ? " done" : ""));
      tx.append(linkify(t.text));
      li.append(tx);
      const keluar = el("button", "icon-btn danger", "✕");
      keluar.title = "Keluarkan dari sprint"; keluar.setAttribute("aria-label", keluar.title);
      keluar.onclick = () => { setTaskSprint(t, null); render(); };
      li.append(keluar);
      ul.append(li);
    });
    ed.append(ul);
  } else {
    ed.append(el("div", "cap-hint", "Belum ada tugas. Tambahkan lewat panel edit tugas (tombol ✎) atau tombol 🏃 di tiket Jira."));
  }

  const aksi = el("div", "cap-group");
  const selesaiBtn = el("button", "btn-solid", "✓ Selesai sprint");
  selesaiBtn.title = "Tutup sprint & catat ke Log kerja";
  selesaiBtn.onclick = () => {
    const belum = anggota.filter((t) => t.status !== "selesai").length;
    const pesan = "Tutup sprint “" + s.nama + "”?" +
      (belum ? "\n\nMasih ada " + belum + " tugas belum selesai (tetap di papan, hanya lepas tekanan sprint)." : "") +
      "\n\nAkan dicatat di Log kerja.";
    if (confirm(pesan)) { sprintEditId = null; completeSprint(s); render(); }
  };
  aksi.append(selesaiBtn);
  const hapusBtn = el("button", "btn-line", "Hapus sprint");
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
    sum2.append("Sprint selesai ", el("span", "count mono", String(selesai.length)));
    det2.append(sum2);
    const card2 = el("div", "routine-card");
    for (const s of selesai) {
      const row = el("div", "jira-row");
      row.append(el("span", "jira-summary", "🏁 " + s.nama));
      row.append(el("span", "jira-status", "ditutup " + (s.selesaiPada ? fmtAgo(s.selesaiPada) : "")));
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
  sum.textContent = sprints.list.length ? "+ sprint baru" :
    "+ buat sprint (kelompokkan tiket + tanggal selesai — makin mepet, skor tiketnya makin naik)";
  det.append(sum);
  const editor = el("div", "routine-editor");
  const form = el("div", "routine-form");
  const nama = document.createElement("input");
  nama.type = "text"; nama.id = "sprint-nama";
  nama.placeholder = "Nama sprint… mis. “Sprint 12”";
  const tgl = document.createElement("input");
  tgl.type = "date"; tgl.id = "sprint-tgl";
  tgl.title = "Tanggal sprint berakhir";
  const buat = el("button", "btn-solid", "Buat sprint");
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
  head.append(el("h2", null, "Tiket Jira — belum diambil"));
  if (jira.items.length) {
    head.append(el("span", "count mono",
      q ? shown.length + "/" + jira.items.length : String(jira.items.length)));
  }
  if (jiraProxy()) {
    const refresh = el("button", "clear-done", jiraSyncing ? "menarik…" : "⟳ tarik sekarang");
    refresh.onclick = () => syncJira(true);
    head.append(refresh);
    if (jiraSyncMsg && !jiraSyncing) head.append(el("span", "count", jiraSyncMsg));
    else if (jira.lastSync && !jiraSyncing) head.append(el("span", "count mono", "sinkron " + fmtAgo(jira.lastSync)));
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
    for (const k of [...perBulan.keys()].sort().reverse()) {
      const grup = perBulan.get(k).sort((a, b) => tglItem(b).localeCompare(tglItem(a)));
      const label = k === "0000-00" ? "Tanpa tanggal"
        : NAMA_BULAN[Number(k.slice(5, 7)) - 1] + " " + k.slice(0, 4) +
          (k === bulanIni ? " — bulan ini" : "");
      const bl = el("div", "bulan-label");
      bl.append(label + " ", el("span", "count mono", String(grup.length)));
      sec.append(bl);
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
      const take = el("button", "btn-line", "＋ Ambil");
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
      sec.append(card);
    }
  }

  const det = document.createElement("details");
  det.className = "routine-manage jira-import";
  det.open = jiraImportOpen;
  det.addEventListener("toggle", () => { jiraImportOpen = det.open; });
  const sum = document.createElement("summary");
  sum.textContent = jira.items.length ? "impor tiket" : "+ impor tiket (tempel daftar dari Claude / Jira)";
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
  const impBtn = el("button", "btn-solid", "Impor");
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
      "♻ pulihkan " + terkunci.length + " tiket yang pernah dibuang/dihapus");
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
