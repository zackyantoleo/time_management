// calendar.js — jadwal meeting dari Google Calendar (secret iCal URL).
// Ditarik lewat Worker (GET /calendar), ditampilkan sebagai section
// "Today's meetings" di Board. Read-only; kelola acaranya tetap di Google.
"use strict";

const CAL_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } })();
// Rentang tarikan: 7 hari ke belakang sampai 31 hari ke depan (38 hari, di
// bawah batas 62 hari Worker). Board "Today's meetings" tetap menyaring hari
// ini dari data ini; tab Calendar menampilkan seluruh rentang.
const CAL_BACK = 7, CAL_AHEAD = 31;
let calEvents = null;   // { from, to, events:[] } hasil tarikan
let calAt = 0;
let calLoading = false;
let calMsg = "";
let calAktif = false;   // kalender terpasang untuk user ini
let calNeedScroll = false; // gulir ke hari ini sekali saat tab dibuka

async function tarikKalender(paksa) {
  if (!jiraProxy() || calLoading) return;
  if (!paksa && Date.now() - calAt < 10 * 60 * 1000) return; // throttle 10 mnt
  calLoading = true; calMsg = "";
  if (view === "papan" || view === "kalender") render();
  try {
    const from = localDateStr(new Date(Date.now() - CAL_BACK * 86400000));
    const to = localDateStr(new Date(Date.now() + CAL_AHEAD * 86400000));
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
  if (view === "papan" || view === "kalender") render();
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

// Satu baris acara kalender.
function calRow(e) {
  const row = el("div", "cal-row" + (acaraLewat(e) ? " lewat" : ""));
  if (acaraLewat(e)) row.title = "Sudah lewat";
  row.append(el("span", "cal-time mono", jamAcara(e)));
  row.append(el("span", "cal-text", e.summary || "(tanpa judul)"));
  if (e.location) {
    const loc = el("span", "cal-loc");
    loc.textContent = /^https?:\/\//.test(e.location) ? "🔗 link" : "· " + e.location;
    row.append(loc);
  }
  return row;
}

// Section "Meeting" di Board (dipanggil dari renderSections via frag).
// Fokus ke yang masih akan datang; meeting yang sudah lewat dilipat supaya
// tidak memenuhi layar (masih bisa dibuka).
function renderMeetings(frag) {
  if (jiraProxy()) tarikKalender(false);
  const hari = acaraTanggal(localDateStr(new Date()))
    .sort((a, b) => (a.allDay ? -1 : b.allDay ? 1 : a.start.localeCompare(b.start)));
  if (!calAktif && !hari.length) return; // kalender tak dipakai → jangan tampil
  const lewat = hari.filter(acaraLewat);
  const aktif = hari.filter((e) => !acaraLewat(e)); // all-day + sedang/akan datang

  const sec = el("section", "section s-cal");
  sec.style.marginBottom = "18px";
  const head = el("div", "section-head");
  head.append(el("h2", null, "📅 Today’s meetings"));
  if (aktif.length) head.append(el("span", "count mono", String(aktif.length))); // hitung sisa hari saja
  if (calLoading) head.append(el("span", "count", "…"));
  sec.append(head);

  if (!hari.length) {
    sec.append(el("div", "empty-note", calMsg
      ? "Gagal menarik kalender: " + calMsg
      : "Tidak ada meeting terjadwal hari ini 🎉"));
  } else {
    const card = el("div", "routine-card");
    if (aktif.length) for (const e of aktif) card.append(calRow(e));
    else card.append(el("div", "cal-empty", "Tidak ada meeting lagi hari ini 🎉"));
    if (lewat.length) {
      const det = el("details", "cal-past");
      det.append(el("summary", null, lewat.length + " earlier"));
      const list = el("div", "cal-past-list");
      for (const e of lewat) list.append(calRow(e));
      det.append(list);
      card.append(det);
    }
    sec.append(card);
  }
  frag.append(sec);
}

// Tab "Calendar" — agenda 7 hari ke belakang s/d 31 hari ke depan, dikelompokkan
// per hari (hanya hari yang ada acaranya). Hari lampau diredupkan, hari ini
// disorot. Read-only; kelola acara tetap di Google.
function renderCalendar() {
  const wrap = $("#calview");
  wrap.innerHTML = "";
  if (jiraProxy()) tarikKalender(false);
  const q = searchQuery.trim().toLowerCase();

  const head = el("div", "section-head");
  head.append(el("h2", null, "📅 Calendar"));
  if (calLoading) head.append(el("span", "count", "…"));
  const ref = el("button", "clear-done", "⟳ refresh");
  ref.disabled = calLoading;
  ref.onclick = () => { calAt = 0; tarikKalender(true); };
  head.append(ref);
  wrap.append(head);

  if (!calAktif) {
    wrap.append(el("div", "empty-note", calMsg
      ? "Gagal menarik kalender: " + calMsg
      : "Kalender belum diisi. Buka ⚙ Settings → Account → Google Calendar untuk memasang secret iCal URL."));
    return;
  }

  const events = ((calEvents && calEvents.events) || []).filter((e) =>
    !q || (e.summary || "").toLowerCase().includes(q) || (e.location || "").toLowerCase().includes(q));
  const byDay = new Map();
  for (const e of events) {
    const day = e.allDay ? e.date : localDateStr(new Date(e.start));
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  }
  const days = [...byDay.keys()].sort();
  if (!days.length) {
    wrap.append(el("div", "empty-note",
      q ? "Tidak ada acara yang cocok." : "Tidak ada acara terjadwal dalam rentang ini 🎉"));
    return;
  }
  const hariIni = localDateStr(new Date());
  let elHariIni = null;
  for (const day of days) {
    const evs = byDay.get(day).sort((a, b) => (a.allDay ? -1 : b.allDay ? 1 : a.start.localeCompare(b.start)));
    const sec = el("section", "cal-day" +
      (day < hariIni ? " lampau" : "") + (day === hariIni ? " ini" : ""));
    const dh = el("div", "cal-day-head");
    dh.append(el("h3", null, fmtDayHeading(day)));
    dh.append(el("span", "count mono", evs.length + (evs.length > 1 ? " events" : " event")));
    sec.append(dh);
    const card = el("div", "routine-card");
    for (const e of evs) card.append(calRow(e));
    sec.append(card);
    wrap.append(sec);
    if (!elHariIni && day >= hariIni) elHariIni = sec; // hari ini / hari mendatang pertama
  }
  // Gulir ke hari ini sekali saat tab dibuka (7 hari lampau ada di atas).
  if (calNeedScroll && elHariIni) {
    calNeedScroll = false;
    setTimeout(() => elHariIni.scrollIntoView({ block: "start", behavior: "auto" }), 0);
  }
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
