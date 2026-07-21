// calendar.js — jadwal meeting dari Google Calendar (secret iCal URL).
// Ditarik lewat Worker (GET /calendar), ditampilkan sebagai section
// "Today's meetings" di Board. Read-only; kelola acaranya tetap di Google.
"use strict";

const CAL_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } })();
let calEvents = null;   // { from, to, events:[] } hasil tarikan
let calAt = 0;
let calLoading = false;
let calMsg = "";
let calAktif = false;   // kalender terpasang untuk user ini

async function tarikKalender(paksa) {
  if (!jiraProxy() || calLoading) return;
  if (!paksa && Date.now() - calAt < 10 * 60 * 1000) return; // throttle 10 mnt
  calLoading = true; calMsg = "";
  if (view === "papan") render();
  try {
    const from = localDateStr(new Date());
    const to = localDateStr(new Date(Date.now() + 6 * 86400000)); // hari ini + 6
    // mode pribadi: URL iCal disimpan di perangkat, dikirim sebagai ?ics=
    const ics = jira.calIcs ? "&ics=" + encodeURIComponent(jira.calIcs) : "";
    const r = await fetch(jiraProxy() + "/calendar?from=" + from + "&to=" + to +
      "&tz=" + encodeURIComponent(CAL_TZ) + ics, { headers: headerAkses() });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
    if (!data || !Array.isArray(data.events)) throw new Error("format tak dikenal");
    calEvents = data; calAktif = true;
  } catch (e) {
    calMsg = (e && e.message ? e.message : "koneksi");
    if (/belum diisi/i.test(calMsg)) calAktif = false;
  }
  calAt = Date.now(); calLoading = false;
  if (view === "papan") render();
}

// Acara yang bertumpang-tindih dengan tanggal lokal tertentu.
function acaraTanggal(dateStr) {
  if (!calEvents || !calEvents.events) return [];
  return calEvents.events.filter((e) => {
    if (e.allDay) return e.date === dateStr;
    return localDateStr(new Date(e.start)) === dateStr;
  });
}

function jamAcara(e) {
  if (e.allDay) return "sepanjang hari";
  const t = fmtClock(new Date(e.start));
  return e.end ? t + "–" + fmtClock(new Date(e.end)) : t;
}

// Acara yang sudah selesai (waktu berakhir < sekarang). All-day tetap tampil
// sepanjang hari.
function acaraLewat(e) {
  if (e.allDay) return false;
  const akhir = e.end ? new Date(e.end) : new Date(e.start);
  return akhir.getTime() < Date.now();
}

// Acara yang sudah dinotifikasi (in-memory; reset saat reload — dijaga oleh
// jendela waktu di checkMeetingsDue supaya reload tak membangkitkan yang lama).
const meetingNotified = new Set();
function meetingKey(e) { return (e.start || "") + "|" + (e.summary || ""); }

// Meeting (timed) yang baru saja mulai & belum dinotifikasi. Jendela 5 menit
// supaya tab yang baru dibuka tak memunculkan pengingat meeting jam-jam lalu.
function checkMeetingsDue() {
  if (!calEvents || !Array.isArray(calEvents.events)) return [];
  const now = Date.now();
  const due = [];
  for (const e of calEvents.events) {
    if (e.allDay || !e.start) continue;
    const mulai = new Date(e.start).getTime();
    if (isNaN(mulai)) continue;
    const k = meetingKey(e);
    if (mulai <= now && now - mulai < 5 * 60 * 1000 && !meetingNotified.has(k)) {
      meetingNotified.add(k);
      due.push(e);
    }
  }
  return due;
}

// Section "Meeting" di Board (dipanggil dari renderSections via frag).
function renderMeetings(frag) {
  if (jiraProxy()) tarikKalender(false);
  const hari = acaraTanggal(localDateStr(new Date()))
    .sort((a, b) => (a.allDay ? -1 : b.allDay ? 1 : a.start.localeCompare(b.start)));
  if (!calAktif && !hari.length) return; // kalender tak dipakai → jangan tampil

  const sec = el("section", "section s-cal");
  sec.style.marginBottom = "18px";
  const head = el("div", "section-head");
  head.append(el("h2", null, "📅 Today’s meetings"));
  if (hari.length) head.append(el("span", "count mono", String(hari.length)));
  if (calLoading) head.append(el("span", "count", "…"));
  sec.append(head);

  if (!hari.length) {
    sec.append(el("div", "empty-note", calMsg
      ? "Gagal menarik kalender: " + calMsg
      : "Tidak ada meeting terjadwal hari ini 🎉"));
  } else {
    const card = el("div", "routine-card");
    for (const e of hari) {
      // Meeting yang sudah lewat tetap tampil tapi diredupkan.
      const row = el("div", "cal-row" + (acaraLewat(e) ? " lewat" : ""));
      if (acaraLewat(e)) row.title = "Sudah lewat";
      row.append(el("span", "cal-time mono", jamAcara(e)));
      row.append(el("span", "cal-text", e.summary || "(tanpa judul)"));
      if (e.location) {
        const loc = el("span", "cal-loc");
        loc.textContent = /^https?:\/\//.test(e.location) ? "🔗 link" : "· " + e.location;
        row.append(loc);
      }
      card.append(row);
    }
    sec.append(card);
  }
  frag.append(sec);
}

// Section pengaturan kalender di tab Jira (dipakai renderAksesSection).
function calSettingsForm() {
  const wrap = document.createDocumentFragment();
  wrap.append(el("div", "cap-label", "Google Calendar"));
  const form = el("div", "routine-form");
  const urlIn = document.createElement("input");
  urlIn.type = "url"; urlIn.value = jira.calIcs || "";
  urlIn.placeholder = "Secret iCal URL (…/basic.ics)";
  urlIn.title = "Google Calendar → Settings → kalendermu → Integrasikan kalender → Secret address in iCal format";
  const simpan = el("button", "btn-solid", "Save calendar");
  simpan.onclick = async () => {
    const val = urlIn.value.trim();
    if (val && !/^https:\/\/calendar\.google\.com\/calendar\/ical\/.+\.ics$/.test(val)) {
      alert("URL harus 'secret iCal URL' Google Calendar (calendar.google.com/…/basic.ics).");
      return;
    }
    simpan.disabled = true;
    // Sumber utama: perangkat + ?ics=. Ini yang membuat kalender jalan.
    jira.calIcs = val; saveJira(true);
    // Best-effort: user multi-user yang kodenya dikenal Worker ikut simpan di
    // server (biar sinkron antar perangkat). Gagal (mode pribadi / kode tak
    // dikenal) diabaikan — ?ics= tetap jalan, jadi jangan tampilkan error.
    if (jira.key) {
      try {
        await fetch(jiraProxy() + "/me/calendar", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headerAkses() },
          body: JSON.stringify({ url: val }),
        });
      } catch {}
    }
    calAt = 0; calAktif = false; // paksa tarik ulang
    if (val) await tarikKalender(true);
    // tarikKalender menaruh galat di calMsg; sukses kalau ada acara/aktif
    if (val && calMsg && !calAktif) {
      alert("Tersimpan, tapi jadwal gagal ditarik: " + calMsg);
    } else {
      alert(val ? "Tersimpan. Jadwal meeting muncul di Board." : "Kalender dihapus.");
    }
    simpan.disabled = false;
    render();
  };
  form.append(urlIn, simpan);
  wrap.append(form);
  wrap.append(el("div", "cap-hint",
    "Ambil di Google Calendar → Settings → pilih kalendermu → “Integrate calendar” → “Secret address in iCal format”. Read-only, disimpan di perangkat ini. Jadwal bisa telat beberapa menit (cache Google)."));
  return wrap;
}
