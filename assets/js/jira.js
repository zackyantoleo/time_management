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
// Skema lama (sebelum ada sinkronisasi proxy) tidak punya field-field ini.
jira.proxy = jira.proxy || "";
jira.key = jira.key || "";
jira.dismissed = jira.dismissed || [];
function saveJira() { localStorage.setItem(JIRA_KEY_STORE, JSON.stringify(jira)); if (typeof syncDirty === "function") syncDirty(); }
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

/* ---------- sinkronisasi otomatis lewat proxy (Cloudflare Worker) ---------- */
function jiraProxy() { return (jira.proxy || "").trim().replace(/\/+$/, ""); }
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
    const r = await fetch(jiraProxy() + "/tickets", { headers: { "X-Catet-Key": jira.key || "" } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
    if (typeof data.site === "string" && data.site) jira.site = data.site;
    const feed = Array.isArray(data.items) ? data.items : [];
    const feedKeys = new Set(feed.map((f) => f.key));
    for (const f of feed) {
      if (jira.dismissed.includes(f.key)) continue;
      if (tasks.some((t) => t.status !== "selesai" && t.text.includes(f.key))) continue;
      const ex = jira.items.find((x) => x.key === f.key);
      if (ex) { ex.summary = f.summary; ex.status = f.status; }
      else jira.items.push({ id: uid(), key: f.key, summary: f.summary, status: f.status, src: "sync", addedAt: new Date().toISOString() });
    }
    // Tiket hasil sinkron yang sudah tidak muncul di Jira (selesai/di-reassign)
    // ikut hilang; tiket hasil impor manual dibiarkan.
    jira.items = jira.items.filter((x) => x.src !== "sync" || feedKeys.has(x.key));
    jira.lastSync = new Date().toISOString();
    jiraSyncMsg = "";
    saveJira();
  } catch (e) {
    jiraSyncMsg = "gagal: " + (e && e.message ? e.message : "koneksi");
  }
  jiraSyncing = false;
  if (view === "papan" || view === "jira") render();
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
      keluar.onclick = () => { t.sprintId = null; save(); render(); };
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
    const card = el("div", "routine-card");
    for (const item of shown) {
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

  // Sinkronisasi otomatis via proxy (Cloudflare Worker — lihat worker/README.md)
  const proxyForm = el("div", "routine-form");
  const proxyIn = document.createElement("input");
  proxyIn.type = "url"; proxyIn.value = jira.proxy || "";
  proxyIn.placeholder = "Alamat proxy: https://catet-jira-proxy.….workers.dev";
  proxyIn.title = "URL Cloudflare Worker kamu (panduan: worker/README.md di repo)";
  const keyIn = document.createElement("input");
  keyIn.type = "password"; keyIn.value = jira.key || "";
  keyIn.placeholder = "Kunci (CATET_KEY)";
  keyIn.title = "Kunci rahasia yang kamu set sebagai CATET_KEY di Worker";
  const saveBtn = el("button", "btn-line", "Simpan & tarik");
  saveBtn.onclick = () => {
    jira.proxy = proxyIn.value.trim();
    jira.key = keyIn.value;
    saveJira();
    if (jiraProxy()) syncJira(true); else render();
  };
  proxyForm.append(proxyIn, keyIn, saveBtn);
  editor.append(proxyForm);
  editor.append(el("div", "cap-hint",
    "Dengan proxy terpasang, tiket ditarik otomatis tiap 5 menit dan Log kerja bisa dikirim sebagai worklog (tombol → Jira)."));

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
}
