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
function saveJira() { localStorage.setItem(JIRA_KEY_STORE, JSON.stringify(jira)); }
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
function takeJiraItem(item) {
  tasks.push({
    id: uid(), text: item.key + " — " + item.summary, priority: "sedang", due: null,
    createdAt: new Date().toISOString(),
    status: "aktif", doneAt: null, focusedAt: null, notified: false,
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
  if (view === "papan") render();
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
  if (view === "papan") render();
}

/* ---------- Jira inbox rendering ---------- */
let jiraImportOpen = false;
function renderJiraInbox(frag) {
  const sec = el("section", "section s-jira");
  sec.style.marginBottom = "18px";
  const head = el("div", "section-head");
  head.append(el("h2", null, "Tiket Jira — belum diambil"));
  if (jira.items.length) head.append(el("span", "count mono", String(jira.items.length)));
  if (jiraProxy()) {
    const refresh = el("button", "clear-done", jiraSyncing ? "menarik…" : "⟳ tarik sekarang");
    refresh.onclick = () => syncJira(true);
    head.append(refresh);
    if (jiraSyncMsg && !jiraSyncing) head.append(el("span", "count", jiraSyncMsg));
    else if (jira.lastSync && !jiraSyncing) head.append(el("span", "count mono", "sinkron " + fmtAgo(jira.lastSync)));
  }
  sec.append(head);

  if (jira.items.length) {
    const card = el("div", "routine-card");
    for (const item of jira.items) {
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

  det.append(editor);
  sec.append(det);
  frag.append(sec);
}
