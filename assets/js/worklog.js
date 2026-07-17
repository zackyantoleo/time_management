// worklog.js — tab "Log kerja": pengelompokan per hari, salin sebagai teks,
// dan kirim worklog ke Jira lewat proxy (tombol "→ Jira").
"use strict";

const PR_LABEL = { urgent: "urgent", tinggi: "tinggi", sedang: "sedang", rendah: "rendah", rutin: "rutin", sprint: "sprint" };

// Badge menit fokus. Saat editable (belum terkirim ke Jira & proxy aktif),
// jadi tombol: klik → input angka, supaya durasi worklog bisa dikoreksi atau
// diisi manual sebelum dikirim (menit fokus otomatis hanya terisi kalau
// tombol ▶ dipakai).
function minsBadge(e, editable) {
  const m = fmtMins(e.mins);
  if (!editable) {
    return m ? el("span", "log-mins mono", "fokus ±" + m) : document.createDocumentFragment();
  }
  const b = el("button", "log-mins mono", m ? "±" + m + " ✎" : "＋ menit");
  b.title = "Ubah durasi — dipakai saat worklog dikirim ke Jira";
  b.onclick = () => {
    const input = document.createElement("input");
    input.type = "number"; input.min = "0"; input.step = "5";
    input.value = String(Math.round(e.mins || 0));
    input.className = "log-mins-input mono";
    input.setAttribute("aria-label", "Durasi dalam menit");
    b.replaceWith(input);
    input.focus(); input.select();
    const commit = () => {
      e.mins = Math.max(0, Math.round(Number(input.value) || 0));
      saveWorklog(); render();
    };
    input.onblur = commit;
    input.onkeydown = (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
      if (ev.key === "Escape") { input.onblur = null; render(); }
    };
  };
  return b;
}

/* ---------- laporan worklog Jira per tanggal ----------
   "Hari X sudah ter-log berapa jam di Jira?" — ditarik dari Worker
   (GET /worklog-report, 14 hari terakhir), ditampilkan sebagai badge di
   kepala tiap hari pada tab Log kerja. Kurang dari target harian → badge
   menyala, biar kelihatan mana yang perlu disesuaikan. */
const LAPORAN_HARI = 14;      // rentang tarikan: hari ini + 13 hari ke belakang
const TARGET_LOG_JAM = 8;     // target jam ter-log per hari kerja
let lapJira = null;           // { from, to, days: { "YYYY-MM-DD": {total, items} } }
let lapJiraAt = 0;
let lapJiraLoading = false;
let lapJiraMsg = "";

async function tarikLaporanJira(paksa) {
  if (!jiraProxy() || lapJiraLoading) return;
  if (!paksa && Date.now() - lapJiraAt < 10 * 60 * 1000) return; // throttle 10 mnt
  lapJiraLoading = true;
  lapJiraMsg = "";
  if (view === "log") render();
  try {
    const to = localDateStr(new Date());
    const from = localDateStr(new Date(Date.now() - (LAPORAN_HARI - 1) * 86400000));
    const r = await fetch(jiraProxy() + "/worklog-report?from=" + from + "&to=" + to);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
    lapJira = data;
  } catch (e) {
    lapJiraMsg = "gagal: " + (e && e.message ? e.message : "koneksi");
  }
  // Selalu diisi (sukses ataupun gagal) — render() di bawah memicu
  // renderWorklog → tarikLaporanJira(false) lagi; tanpa stempel ini,
  // kegagalan akan berputar fetch tanpa henti.
  lapJiraAt = Date.now();
  lapJiraLoading = false;
  if (view === "log") render();
}

// Badge "☁ Jira …" untuk satu tanggal. null = tanggal di luar rentang laporan.
function jiraJamBadge(dateStr) {
  if (!lapJira || dateStr < lapJira.from || dateStr > lapJira.to) return null;
  const d = lapJira.days[dateStr];
  const total = d ? d.total : 0;
  const kurang = total < TARGET_LOG_JAM * 3600;
  const b = el("span", "jira-jam mono" + (kurang ? " kurang" : ""),
    "☁ Jira " + (fmtMins(Math.round(total / 60)) || "0 j"));
  const rincian = d && d.items.length
    ? d.items.map((x) => x.key + " " + (fmtMins(Math.round(x.seconds / 60)) || "<1 mnt")).join(" · ")
    : "belum ada worklog";
  b.title = "Ter-log di Jira pada tanggal ini (target " + TARGET_LOG_JAM + " j): " + rincian;
  return b;
}

function dayLogText(dateStr, entries) {
  const lines = entries.map((e) => {
    let line = "- " + fmtClock(new Date(e.ts)) + " " + e.text + " [" + PR_LABEL[e.priority] + "]";
    const m = fmtMins(e.mins);
    if (m) line += " (fokus ±" + m + ")";
    return line;
  });
  return "Log kerja " + fmtDayName(dateStr) + "\n" + lines.join("\n");
}

function renderWorklog() {
  const wrap = $("#worklog");
  wrap.innerHTML = "";
  if (!worklog.length) {
    wrap.append(el("div", "empty-note",
      "Log masih kosong. Setiap tugas yang kamu tandai ✓ selesai otomatis tercatat di sini per hari — lengkap dengan jam selesai dan lama fokus. Cocok untuk mengisi worklog/standup."));
    return;
  }
  const q = searchQuery.trim().toLowerCase();
  const shown = !q ? worklog : worklog.filter((e) => e.text.toLowerCase().includes(q));
  if (q && !shown.length) {
    wrap.append(el("div", "empty-note", "Tidak ada entri log yang cocok dengan “" + searchQuery.trim() + "”."));
    return;
  }
  // Laporan jam ter-log di Jira (14 hari terakhir) — tarik di latar,
  // badge-nya menempel di kepala tiap hari.
  if (jiraProxy()) {
    tarikLaporanJira(false);
    const bar = el("div", "log-jira-bar");
    const ref = el("button", "clear-done",
      lapJiraLoading ? "menarik laporan Jira…" : "⟳ segarkan laporan Jira");
    ref.disabled = lapJiraLoading;
    ref.onclick = () => tarikLaporanJira(true);
    bar.append(ref);
    if (lapJiraMsg) bar.append(el("span", "count", lapJiraMsg));
    else if (lapJira) bar.append(el("span", "count mono",
      "target " + TARGET_LOG_JAM + " j/hari · laporan " + fmtAgo(new Date(lapJiraAt).toISOString())));
    wrap.append(bar);
  }

  const byDate = new Map();
  for (const e of shown) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  const dates = [...byDate.keys()].sort().reverse();
  for (const dateStr of dates) {
    const entries = byDate.get(dateStr).sort((a, b) => new Date(a.ts) - new Date(b.ts));
    const day = el("section", "log-day");
    const head = el("div", "log-day-head");
    head.append(el("h3", null, fmtDayHeading(dateStr)));
    const totalMins = Math.round(entries.reduce((s, e) => s + (e.mins || 0), 0));
    let sum = entries.length + " tugas";
    if (fmtMins(totalMins)) sum += " · fokus " + fmtMins(totalMins);
    head.append(el("span", "log-sum mono", sum));
    const jb = jiraJamBadge(dateStr);
    if (jb) head.append(jb);
    const copyBtn = el("button", "btn-ghost", "Salin");
    copyBtn.title = "Salin log hari ini sebagai teks";
    copyBtn.onclick = () => copyText(dayLogText(dateStr, entries), copyBtn);
    head.append(copyBtn);
    day.append(head);

    const ul = el("ul", "log-entries");
    for (const e of entries) {
      const li = el("li", "log-entry");
      li.append(el("span", "log-time mono", fmtClock(new Date(e.ts))));
      const dot = el("span", "log-dot p-" + e.priority);
      dot.title = "prioritas " + PR_LABEL[e.priority];
      li.append(dot);
      const ltext = el("span", "log-text");
      ltext.append(linkify(e.text));
      li.append(ltext);
      // Tujuan worklog: key tiket eksplisit di teks, atau topik BAU (pilihan
      // manual e.bauKey menang atas pencocokan otomatis cocokBau). Entri
      // "sprint" (catatan penutupan sprint) tidak dikirim ke mana-mana;
      // rutinitas boleh ke topik BAU (mis. daily standup → tiket meeting).
      const ticketKey = (e.priority !== "rutin" && e.priority !== "sprint")
        ? (e.text.match(JIRA_RE) || [null])[0] : null;
      const bau = (!ticketKey && e.priority !== "sprint")
        ? (e.bauKey ? bauByKey(e.bauKey) : cocokBau(e.text)) : null;
      const target = ticketKey || (bau && bau.key) || null;
      const bolehKirim = !!jiraProxy() && e.priority !== "sprint" && !e.jiraLogged;
      li.append(minsBadge(e, bolehKirim && !!target));
      if (jiraProxy() && target && e.jiraLogged) {
        li.append(el("span", "log-mins mono", "✓ Jira"));
      } else if (jiraProxy() && target) {
        const label = ticketKey ? "→ Jira" : "→ " + target;
        const send = el("button", "btn-ghost", label);
        send.title = "Kirim sebagai worklog ke " + target +
          (bau ? " (" + bau.summary + ")" : "") +
          " — durasi: " + (e.mins ? "±" + Math.round(e.mins) + " mnt" : "1 mnt minimum, klik badge menit untuk mengubah");
        send.onclick = async () => {
          send.disabled = true; send.textContent = "mengirim…";
          try {
            const r = await fetch(jiraProxy() + "/worklog", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                key: target, started: e.ts,
                timeSpentSeconds: Math.max(60, (e.mins || 0) * 60),
                comment: e.text,
              }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
            e.jiraLogged = true; saveWorklog(); render();
          } catch (err) {
            alert("Gagal mengirim worklog ke " + target + ":\n" + (err && err.message ? err.message : "koneksi"));
            send.disabled = false; send.textContent = label;
          }
        };
        li.append(send);
      }
      // Tombol 🏢: pilih/ganti topik BAU untuk entri tanpa key eksplisit.
      // Pilihan diingat sebagai alias teks → entri berulang (rutinitas) cukup
      // dipilihkan sekali.
      if (bolehKirim && !ticketKey && jira.bau && Array.isArray(jira.bau.items) && jira.bau.items.length) {
        const pick = el("button", "icon-btn" + (bau ? " in-sprint" : ""), "🏢");
        pick.title = bau ? "Topik BAU: " + bau.key + " — " + bau.summary + " (klik untuk ganti)"
          : "Pilih topik BAU untuk worklog ini";
        pick.setAttribute("aria-label", pick.title);
        pick.onclick = (ev) => {
          ev.stopPropagation();
          bukaBauMenu(pick, (bau && bau.key) || null, (key) => {
            const lo = e.text.trim().toLowerCase();
            if (key) { e.bauKey = key; jira.bau.alias[lo] = key; }
            else { delete e.bauKey; delete jira.bau.alias[lo]; }
            saveWorklog(); saveJira(); render();
          });
        };
        li.append(pick);
      }
      const del = el("button", "icon-btn danger", "✕");
      del.title = "Hapus dari log"; del.setAttribute("aria-label", "Hapus dari log");
      del.onclick = () => {
        if (confirm("Hapus entri log ini?\n\n“" + e.text + "”")) {
          worklog = worklog.filter((x) => x.id !== e.id); saveWorklog(); render();
        }
      };
      li.append(del);
      ul.append(li);
    }
    day.append(ul);
    wrap.append(day);
  }
}
