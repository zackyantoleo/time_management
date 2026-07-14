// worklog.js — tab "Log kerja": pengelompokan per hari, salin sebagai teks,
// dan kirim worklog ke Jira lewat proxy (tombol "→ Jira").
"use strict";

const PR_LABEL = { urgent: "urgent", tinggi: "tinggi", sedang: "sedang", rendah: "rendah", rutin: "rutin" };

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
  const byDate = new Map();
  for (const e of worklog) {
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
      const m = fmtMins(e.mins);
      if (m) li.append(el("span", "log-mins mono", "fokus ±" + m));
      const ticketKey = (e.text.match(JIRA_RE) || [null])[0];
      if (jiraProxy() && ticketKey && e.priority !== "rutin") {
        if (e.jiraLogged) {
          li.append(el("span", "log-mins mono", "✓ Jira"));
        } else {
          const send = el("button", "btn-ghost", "→ Jira");
          send.title = "Kirim sebagai worklog ke " + ticketKey +
            " (durasi: " + (e.mins ? "±" + e.mins + " mnt fokus" : "1 mnt minimum") + ")";
          send.onclick = async () => {
            send.disabled = true; send.textContent = "mengirim…";
            try {
              const r = await fetch(jiraProxy() + "/worklog", {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Catet-Key": jira.key || "" },
                body: JSON.stringify({
                  key: ticketKey, started: e.ts,
                  timeSpentSeconds: Math.max(60, (e.mins || 0) * 60),
                  comment: e.text,
                }),
              });
              const data = await r.json().catch(() => ({}));
              if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
              e.jiraLogged = true; saveWorklog(); render();
            } catch (err) {
              alert("Gagal mengirim worklog ke " + ticketKey + ":\n" + (err && err.message ? err.message : "koneksi"));
              send.disabled = false; send.textContent = "→ Jira";
            }
          };
          li.append(send);
        }
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
