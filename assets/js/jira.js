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
function renderSprintBar() {
  const sec = el("section", "section s-jira");
  sec.style.marginBottom = "18px";
  const head = el("div", "section-head");
  head.append(el("h2", null, "Sprint"));
  sec.append(head);

  if (sprints.list.length) {
    const card = el("div", "routine-card");
    for (const s of sprints.list) {
      const row = el("div", "jira-row");
      const radio = el("button", "check", "✓");
      const isAktif = sprintAktif() && sprintAktif().id === s.id;
      if (isAktif) {
        radio.style.background = "var(--accent)"; radio.style.borderColor = "var(--accent)";
        radio.style.color = "var(--accent-ink)";
      }
      radio.title = isAktif ? "Sprint aktif (target tombol ＋ Sprint)" : "Jadikan sprint aktif";
      radio.setAttribute("aria-label", radio.title);
      radio.onclick = () => { sprints.aktif = s.id; saveSprints(); render(); };
      row.append(radio);
      const body = el("span", "jira-summary");
      body.append(el("strong", null, s.nama));
      row.append(body);
      const sisa = fmtSisaSprint(s);
      const badge = el("span", "due-badge mono" + (sprintPtsUntukBadge(s) >= 3 ? " late" : ""),
        "🏁 " + fmtDayName(s.selesai) + " · " + sisa);
      row.append(badge);
      row.append(el("span", "jira-status", jumlahTugasSprint(s.id) + " tugas"));
      const del = el("button", "icon-btn danger", "✕");
      del.title = "Hapus sprint (tugasnya tetap ada, hanya lepas dari sprint)";
      del.setAttribute("aria-label", "Hapus sprint");
      del.onclick = () => {
        if (confirm("Hapus sprint “" + s.nama + "”?\nTugas-tugasnya tetap ada di papan, hanya lepas dari sprint.")) {
          sprints.list = sprints.list.filter((x) => x.id !== s.id);
          if (sprints.aktif === s.id) sprints.aktif = null;
          tasks.forEach((t) => { if (t.sprintId === s.id) t.sprintId = null; });
          saveSprints(); save(); render();
        }
      };
      row.append(del);
      card.append(row);
    }
    sec.append(card);
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
      const sAktif = sprintAktif();
      if (sAktif) {
        const takeSprint = el("button", "btn-line", "🏃 Sprint");
        takeSprint.title = "Ambil ke papan sebagai bagian “" + sAktif.nama + "” (" + fmtSisaSprint(sAktif) + ")";
        takeSprint.onclick = () => { takeJiraItem(item, sAktif.id); render(); };
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
