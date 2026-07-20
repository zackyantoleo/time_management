// Catet ⇄ Jira proxy — Cloudflare Worker.
//
// Jira Cloud memblokir panggilan API langsung dari browser (CORS), jadi Worker
// ini jadi perantara: Catet memanggil Worker, Worker memanggil Jira memakai
// API token yang tersimpan sebagai secret di Cloudflare (tidak pernah sampai
// ke browser atau repo).
//
// Secrets yang wajib di-set (lihat worker/README.md):
//   JIRA_SITE      mis. https://erafone.atlassian.net
//   JIRA_EMAIL     email akun Atlassian pemilik API token
//   JIRA_API_TOKEN dari id.atlassian.com/manage-profile/security/api-tokens
//
// Akses TIDAK lagi pakai kunci rahasia. Otorisasi berbasis Origin: hanya
// halaman dari origin yang diizinkan (GitHub Pages, localhost, file://) yang
// boleh memakai proxy ini. Efeknya: perangkat baru langsung tersinkron tanpa
// menempel apa pun — cukup buka aplikasinya. (Origin dikunci oleh browser,
// jadi halaman di origin lain tak bisa memalsukannya.)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  // PUT wajib ada di sini — sinkronisasi state pakai PUT /state; tanpa PUT,
  // preflight CORS gagal dan browser memblokir permintaannya.
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Catet-Key, X-Admin-Key",
  "Access-Control-Max-Age": "86400",
};

// Origin yang boleh memakai proxy ini. Tambahan bisa diset lewat variabel
// ALLOWED_ORIGINS (dipisah koma) tanpa mengubah kode — mis. kalau dipasang di
// domain lain. localhost & file:// diizinkan untuk pengembangan.
const DEFAULT_ORIGINS = [
  "https://zackyantoleo.github.io", // GitHub Pages (produksi)
  "null",                            // dibuka langsung dari file:// → Origin: null
];
function originOk(origin, env) {
  if (!origin) return false; // permintaan non-browser (mis. curl polos) ditolak
  const extra = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (DEFAULT_ORIGINS.includes(origin) || extra.includes(origin)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin); // dev lokal
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    // no-store: respons /state & /tickets tidak boleh diambil dari cache
    // browser — data sinkronisasi harus selalu segar.
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
  });
}

// Jira menuntut format started "2026-07-14T09:00:00.000+0000" — ISO 8601
// tanpa huruf Z dan tanpa titik dua di offset.
function toJiraDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return d.toISOString().replace("Z", "+0000");
}

// Query D1 dengan auto-buat tabel & auto-tambah kolom baru saat pertama
// dipakai (tanpa langkah migrasi manual). mode: first|run|all.
const SKEMA = [
  "CREATE TABLE IF NOT EXISTS states (user_id TEXT PRIMARY KEY, blob TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, jira_site TEXT, jira_email TEXT, jira_token TEXT, cal_ics_url TEXT, created_at TEXT NOT NULL)",
];
// Kolom yang ditambahkan setelah tabel pertama dibuat (instalasi lama).
const MIGRASI = ["ALTER TABLE users ADD COLUMN cal_ics_url TEXT"];
async function d1q(env, sql, params, mode) {
  const jalan = () => {
    const st = env.CATET_DB.prepare(sql).bind(...params);
    return mode === "first" ? st.first() : mode === "all" ? st.all() : st.run();
  };
  try { return await jalan(); }
  catch (e) {
    const m = String(e && e.message);
    if (/no such table/i.test(m)) {
      for (const s of SKEMA) await env.CATET_DB.exec(s);
    } else if (/no such column/i.test(m)) {
      for (const s of MIGRASI) { try { await env.CATET_DB.exec(s); } catch { /* sudah ada */ } }
    } else throw e;
    return await jalan();
  }
}

async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function kodeAcak() {
  return [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Pemilik kode akses di header X-Catet-Key, atau null.
async function userDariKode(env, request) {
  if (!env.CATET_DB) return null;
  const kode = (request.headers.get("X-Catet-Key") || "").trim();
  if (!kode) return null;
  return await d1q(env,
    "SELECT id, name, jira_site, jira_email, jira_token, cal_ics_url FROM users WHERE token_hash = ?1",
    [await sha256hex(kode)], "first");
}

/* ---------- iCalendar (Google Calendar "secret iCal URL") ---------- */
// Validasi URL iCal Google — hanya host calendar.google.com & path /ical/…ics
// (mencegah proxy dipakai fetch alamat sembarang/SSRF). → URL bersih | null.
function gcalUrlOk(raw) {
  let u; try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== "https:") return null;
  if (u.hostname !== "calendar.google.com") return null;
  if (!u.pathname.startsWith("/calendar/ical/") || !u.pathname.endsWith(".ics")) return null;
  return u.toString();
}
// Buang line-folding RFC5545 (baris lanjutan diawali spasi/tab).
function unfoldICS(t) { return t.replace(/\r?\n[ \t]/g, ""); }
// Pisah properti "NAME;PARAM=VAL:VALUE" → {name, params, value}.
function parseProp(line) {
  const c = line.indexOf(":");
  if (c < 0) return null;
  const kiri = line.slice(0, c), value = line.slice(c + 1);
  const bagian = kiri.split(";");
  const name = bagian[0].toUpperCase();
  const params = {};
  for (const b of bagian.slice(1)) {
    const eq = b.indexOf("=");
    if (eq > 0) params[b.slice(0, eq).toUpperCase()] = b.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name, params, value };
}
function unescapeText(s) {
  return s.replace(/\\n/gi, " ").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\").trim();
}
// Wall-clock (di zona tz) → instant UTC. Koreksi offset sekali; zona tanpa DST
// (mis. Asia/Jakarta) selalu tepat.
function wallToUTC(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  try {
    const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const p = {}; for (const x of dtf.formatToParts(new Date(guess))) p[x.type] = x.value;
    const asIf = Date.UTC(+p.year, +p.month - 1, +p.day, p.hour === "24" ? 0 : +p.hour, +p.minute, +p.second);
    return new Date(guess - (asIf - guess));
  } catch { return new Date(guess); }
}
// Parse nilai DTSTART/DTEND. tzFallback dipakai untuk waktu "mengambang".
// → { allDay, date:"YYYY-MM-DD", instant:Date, wall:{y,mo,d,h,mi,s} }
function parseDT(prop, tzFallback) {
  const v = prop.value.trim();
  if (prop.params.VALUE === "DATE" || /^\d{8}$/.test(v)) {
    const y = +v.slice(0, 4), mo = +v.slice(4, 6), d = +v.slice(6, 8);
    return { allDay: true, date: v.slice(0, 4) + "-" + v.slice(4, 6) + "-" + v.slice(6, 8),
      instant: new Date(Date.UTC(y, mo - 1, d)), wall: { y, mo, d, h: 0, mi: 0, s: 0 } };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  const [, ys, mos, ds, hs, mis, ss, z] = m;
  const wall = { y: +ys, mo: +mos, d: +ds, h: +hs, mi: +mis, s: +ss };
  let instant;
  if (z) instant = new Date(Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s));
  else instant = wallToUTC(wall.y, wall.mo, wall.d, wall.h, wall.mi, wall.s, prop.params.TZID || tzFallback);
  return { allDay: false, date: null, instant, wall };
}
function ymd(dt) { return dt.getUTCFullYear() * 10000 + (dt.getUTCMonth() + 1) * 100 + dt.getUTCDate(); }
// Perluas satu VEVENT (termasuk RRULE sederhana) ke daftar occurrence dalam
// [winA, winB]. Menangani FREQ DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT,
// UNTIL, BYDAY (WEEKLY), dan EXDATE. Cukup untuk meeting rutin lazim.
const HARI_KODE = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
function expandEvent(ev, winA, winB, tz) {
  const durMs = ev.end && ev.start ? (ev.end.instant - ev.start.instant) : 0;
  const buat = (inst, wall) => ({
    summary: ev.summary, location: ev.location, allDay: ev.start.allDay,
    start: inst.toISOString(), date: ev.start.allDay ? isoDate(wall) : null,
    end: new Date(inst.getTime() + durMs).toISOString(),
  });
  const isoDate = (w) => String(w.y).padStart(4, "0") + "-" + String(w.mo).padStart(2, "0") + "-" + String(w.d).padStart(2, "0");
  const dalam = (inst) => inst >= winA && inst <= winB;
  if (!ev.rrule) {
    return dalam(ev.start.instant) ? [buat(ev.start.instant, ev.start.wall)] : [];
  }
  const R = {}; for (const kv of ev.rrule.split(";")) { const [k, v] = kv.split("="); if (k) R[k.toUpperCase()] = v; }
  const freq = R.FREQ, interval = Math.max(1, +R.INTERVAL || 1);
  const count = R.COUNT ? +R.COUNT : Infinity;
  const until = R.UNTIL ? parseDT({ value: R.UNTIL, params: {} }, tz).instant : null;
  const byday = R.BYDAY ? R.BYDAY.split(",").map((x) => HARI_KODE[x.slice(-2).toUpperCase()]).filter((x) => x != null) : null;
  const exdate = new Set(ev.exdate.map((s) => s.slice(0, 8)));
  const out = []; const w0 = ev.start.wall; let n = 0, dibuat = 0;
  const maxIter = 1000;
  for (let i = 0; i < maxIter && dibuat < count; i++) {
    // tanggal dasar untuk langkah ke-i
    let dates = [];
    if (freq === "WEEKLY" && byday) {
      const base = new Date(Date.UTC(w0.y, w0.mo - 1, w0.d));
      const senin = new Date(base); senin.setUTCDate(base.getUTCDate() - ((base.getUTCDay() + 6) % 7)); // awal minggu (Senin)
      senin.setUTCDate(senin.getUTCDate() + i * interval * 7);
      for (const wd of byday) {
        const dd = new Date(senin); dd.setUTCDate(senin.getUTCDate() + ((wd + 6) % 7));
        dates.push({ y: dd.getUTCFullYear(), mo: dd.getUTCMonth() + 1, d: dd.getUTCDate() });
      }
    } else {
      const base = new Date(Date.UTC(w0.y, w0.mo - 1, w0.d));
      if (freq === "DAILY") base.setUTCDate(base.getUTCDate() + i * interval);
      else if (freq === "WEEKLY") base.setUTCDate(base.getUTCDate() + i * interval * 7);
      else if (freq === "MONTHLY") base.setUTCMonth(base.getUTCMonth() + i * interval);
      else if (freq === "YEARLY") base.setUTCFullYear(base.getUTCFullYear() + i * interval);
      else if (i > 0) break; // FREQ tak dikenal → anggap sekali saja
      dates.push({ y: base.getUTCFullYear(), mo: base.getUTCMonth() + 1, d: base.getUTCDate() });
    }
    for (const dt of dates) {
      if (dibuat >= count) break;
      const key = String(dt.y).padStart(4, "0") + String(dt.mo).padStart(2, "0") + String(dt.d).padStart(2, "0");
      const inst = ev.start.allDay
        ? new Date(Date.UTC(dt.y, dt.mo - 1, dt.d))
        : wallToUTC(dt.y, dt.mo, dt.d, w0.h, w0.mi, w0.s, ev.tzid || tz);
      if (until && inst > until) { i = maxIter; break; }
      dibuat++;
      if (exdate.has(key)) continue;
      if (dalam(inst)) out.push(buat(inst, { ...w0, y: dt.y, mo: dt.mo, d: dt.d }));
    }
    // berhenti kalau sudah jauh melewati jendela
    const cek = new Date(Date.UTC(w0.y, w0.mo - 1, w0.d));
    cek.setUTCDate(cek.getUTCDate() + i * interval * (freq === "WEEKLY" ? 7 : 1));
    if (cek > winB && freq !== "MONTHLY" && freq !== "YEARLY") break;
    if ((freq === "MONTHLY" || freq === "YEARLY") && new Date(Date.UTC(w0.y + (freq === "YEARLY" ? i : 0), w0.mo - 1 + (freq === "MONTHLY" ? i : 0), w0.d)) > winB) break;
  }
  return out;
}
// Parse ICS penuh → daftar occurrence dalam [from,to] (tanggal lokal tz).
function acaraDalamJendela(icsText, from, to, tz) {
  const lines = unfoldICS(icsText).split(/\r?\n/);
  const winA = wallToUTC(+from.slice(0, 4), +from.slice(5, 7), +from.slice(8, 10), 0, 0, 0, tz);
  const winB = wallToUTC(+to.slice(0, 4), +to.slice(5, 7), +to.slice(8, 10), 23, 59, 59, tz);
  const winApad = new Date(winA.getTime() - 2 * 86400000); // margin utk all-day/timezone
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = { exdate: [], summary: "", location: "" }; continue; }
    if (line === "END:VEVENT") {
      if (cur && cur.start && cur.status !== "CANCELLED") events.push(cur);
      cur = null; continue;
    }
    if (!cur) continue;
    const p = parseProp(line); if (!p) continue;
    if (p.name === "DTSTART") { cur.start = parseDT(p, tz); cur.tzid = p.params.TZID || null; }
    else if (p.name === "DTEND") cur.end = parseDT(p, tz);
    else if (p.name === "SUMMARY") cur.summary = unescapeText(p.value).slice(0, 200);
    else if (p.name === "LOCATION") cur.location = unescapeText(p.value).slice(0, 200);
    else if (p.name === "RRULE") cur.rrule = p.value.trim();
    else if (p.name === "EXDATE") cur.exdate.push(...p.value.split(",").map((s) => s.trim()));
    else if (p.name === "STATUS") cur.status = p.value.trim().toUpperCase();
  }
  const out = [];
  for (const ev of events) {
    if (!ev.rrule && ev.start.instant < winApad) continue;
    for (const oc of expandEvent(ev, winA, winB, tz)) out.push(oc);
    if (out.length > 500) break;
  }
  out.sort((a, b) => a.start.localeCompare(b.start));
  return out;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    // Pagar terluar: exception apa pun harus tetap balik lewat json() (yang
    // membawa header CORS). Tanpa ini, error mentah → 500 default Cloudflare
    // TANPA CORS → browser salah lapor sebagai "CORS error".
    try {
      return await tangani(request, env);
    } catch (e) {
      return json({ error: "Worker error: " + (e && e.message ? e.message : String(e)) }, 500);
    }
  },
};

async function tangani(request, env) {
    const url0 = new URL(request.url);

    // /admin/users — kelola kode akses (POST buat, GET daftar, DELETE hapus).
    // Dilindungi ADMIN_KEY sendiri & dipakai lewat curl (tanpa Origin), jadi
    // sengaja SEBELUM pagar originOk.
    if (url0.pathname === "/admin/users" || url0.pathname.startsWith("/admin/users/")) {
      if (!env.ADMIN_KEY) return json({ error: "Set secret ADMIN_KEY dulu (wrangler secret put ADMIN_KEY)." }, 500);
      if (request.headers.get("X-Admin-Key") !== env.ADMIN_KEY) return json({ error: "X-Admin-Key salah." }, 401);
      if (!env.CATET_DB) return json({ error: "Multi-user butuh D1 (lihat worker/README.md)." }, 500);
      if (request.method === "POST" && url0.pathname === "/admin/users") {
        let b; try { b = await request.json(); } catch { return json({ error: "Body harus JSON." }, 400); }
        const name = (b && typeof b.name === "string" ? b.name.trim() : "").slice(0, 60);
        if (!name) return json({ error: "Field name wajib." }, 400);
        const id = crypto.randomUUID();
        const code = kodeAcak();
        await d1q(env, "INSERT INTO users (id, name, token_hash, created_at) VALUES (?1, ?2, ?3, ?4)",
          [id, name, await sha256hex(code), new Date().toISOString()], "run");
        return json({ id, name, code }); // kode hanya ditampilkan sekali ini
      }
      if (request.method === "GET" && url0.pathname === "/admin/users") {
        const rs = await d1q(env,
          "SELECT id, name, created_at, jira_site, CASE WHEN jira_token IS NULL OR jira_token = '' THEN 0 ELSE 1 END AS punya_jira FROM users ORDER BY created_at",
          [], "all");
        return json({ users: (rs && rs.results) || [] });
      }
      if (request.method === "DELETE" && url0.pathname.startsWith("/admin/users/")) {
        const id = decodeURIComponent(url0.pathname.slice("/admin/users/".length));
        await d1q(env, "DELETE FROM states WHERE user_id = ?1", [id], "run");
        await d1q(env, "DELETE FROM users WHERE id = ?1", [id], "run");
        return json({ ok: true });
      }
      return json({ error: "Rute admin tidak dikenal." }, 404);
    }

    if (!originOk(request.headers.get("Origin"), env)) {
      return json({ error: "Origin tidak diizinkan untuk mengakses proxy ini." }, 403);
    }

    // Identitas: kode akses → user. Saat REQUIRE_AUTH=1, semua endpoint data
    // wajib kode valid; tanpa mode itu, tanpa kode = user "default" (mode lama).
    const user = await userDariKode(env, request);
    if (env.REQUIRE_AUTH === "1" && !user) {
      return json({ error: "Kode akses tidak valid atau belum diisi — masukkan kode dari admin (tab Jira → Access)." }, 401);
    }
    const uid = user ? user.id : "default";

    // GET /me · POST /me/jira · POST /me/calendar — profil & kredensial user.
    if (url0.pathname.startsWith("/me")) {
      if (!user) return json({ error: "Butuh kode akses (tab Jira → Access)." }, 401);
      if (request.method === "GET" && url0.pathname === "/me") {
        return json({ name: user.name, jira_site: user.jira_site || "",
          jira_email: user.jira_email || "", jira_tersimpan: !!user.jira_token,
          cal_tersimpan: !!user.cal_ics_url });
      }
      if (request.method === "POST" && url0.pathname === "/me/jira") {
        let b; try { b = await request.json(); } catch { return json({ error: "Body harus JSON." }, 400); }
        const s = (b && String(b.site || "")).trim().replace(/\/+$/, "");
        const email = (b && String(b.email || "")).trim();
        const token = (b && String(b.token || "")).trim();
        // hanya Jira Cloud — mencegah proxy dipakai fetch alamat sembarang
        if (!/^https:\/\/[a-z0-9-]+\.atlassian\.net$/.test(s)) {
          return json({ error: "Site harus https://<nama>.atlassian.net (Jira Cloud)." }, 400);
        }
        if (!email || !token) return json({ error: "Field email dan token wajib." }, 400);
        await d1q(env, "UPDATE users SET jira_site = ?2, jira_email = ?3, jira_token = ?4 WHERE id = ?1",
          [user.id, s, email, token], "run");
        return json({ ok: true });
      }
      if (request.method === "POST" && url0.pathname === "/me/calendar") {
        let b; try { b = await request.json(); } catch { return json({ error: "Body harus JSON." }, 400); }
        const raw = (b && String(b.url || "")).trim();
        const url = raw ? gcalUrlOk(raw) : ""; // "" = hapus; null = tidak valid
        if (raw && url === null) {
          return json({ error: "URL harus 'secret iCal URL' Google Calendar (calendar.google.com/.../basic.ics)." }, 400);
        }
        await d1q(env, "UPDATE users SET cal_ics_url = ?2 WHERE id = ?1", [user.id, url || null], "run");
        return json({ ok: true });
      }
      return json({ error: "Rute tidak dikenal." }, 404);
    }

    // GET /calendar?from=&to=&tz= — acara kalender user dalam rentang tanggal.
    if (request.method === "GET" && url0.pathname === "/calendar") {
      const icsUrl = user ? user.cal_ics_url : env.CAL_ICS_URL;
      if (!icsUrl) return json({ error: "Kalender belum diisi (tab Jira → Access → Google Calendar)." }, 400);
      const from = url0.searchParams.get("from") || "";
      const to = url0.searchParams.get("to") || "";
      const tz = url0.searchParams.get("tz") || "UTC";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
        return json({ error: "from/to harus YYYY-MM-DD dan from ≤ to." }, 400);
      }
      if ((new Date(to) - new Date(from)) / 86400000 > 62) return json({ error: "Rentang maks 62 hari." }, 400);
      if (!gcalUrlOk(icsUrl)) return json({ error: "URL kalender tersimpan tidak valid." }, 400);
      const r = await fetch(icsUrl, { headers: { Accept: "text/calendar" } });
      if (!r.ok) return json({ error: "Google menolak (" + r.status + ") — URL iCal mungkin sudah diganti." }, 502);
      let text = await r.text();
      if (text.length > 4 * 1024 * 1024) text = text.slice(0, 4 * 1024 * 1024); // batasi kalender raksasa
      const events = acaraDalamJendela(text, from, to, tz);
      return json({ from, to, events });
    }

    // Kredensial Jira: user ber-kode WAJIB punya kredensial sendiri (fallback
    // ke secrets global akan membocorkan tiket/worklog pemilik); secrets
    // global hanya untuk mode pribadi tanpa kode.
    const pakaiUser = !!(user && user.jira_site && user.jira_email && user.jira_token);
    const jiraSiap = user ? pakaiUser : !!(env.JIRA_SITE && env.JIRA_EMAIL && env.JIRA_API_TOKEN);
    const url = new URL(request.url);
    if (!jiraSiap && url.pathname !== "/state") {
      return json({ error: "Kredensial Jira belum diisi — tab Jira → Access → Jira credentials." }, 400);
    }
    const site = (pakaiUser ? user.jira_site : (env.JIRA_SITE || "")).trim().replace(/\/+$/, "");
    const authHeaders = {
      Authorization: "Basic " + btoa(
        (pakaiUser ? user.jira_email : env.JIRA_EMAIL) + ":" + (pakaiUser ? user.jira_token : env.JIRA_API_TOKEN)),
      Accept: "application/json",
    };

    // GET /tickets — tiket terbuka yang di-assign ke pemilik token.
    if (request.method === "GET" && url.pathname === "/tickets") {
      const jql = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
      const r = await fetch(
        site + "/rest/api/3/search/jql?jql=" + encodeURIComponent(jql) +
          "&fields=summary,status,created&maxResults=100",
        { headers: authHeaders }
      );
      if (!r.ok) return json({ error: "Jira menolak (" + r.status + "): " + (await r.text()).slice(0, 300) }, 502);
      const data = await r.json();
      return json({
        site,
        items: (data.issues || []).map((i) => ({
          key: i.key,
          summary: (i.fields && i.fields.summary) || "",
          status: (i.fields && i.fields.status && i.fields.status.name) || null,
          created: (i.fields && i.fields.created) || null,
        })),
      });
    }

    // GET /bau?project=TDBU — daftar tiket "topik" di project BAU (Business
    // as Usual), untuk worklog di luar task sprint. Semua tiket yang belum
    // Done ikut; Catet yang mencocokkan judul tugas ke topiknya.
    if (request.method === "GET" && url.pathname === "/bau") {
      const proj = (url.searchParams.get("project") || "").trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9]{1,9}$/.test(proj)) {
        return json({ error: "Parameter project tidak valid (contoh: TDBU)." }, 400);
      }
      const jql = "project = " + proj + " AND statusCategory != Done ORDER BY key ASC";
      const r = await fetch(
        site + "/rest/api/3/search/jql?jql=" + encodeURIComponent(jql) +
          "&fields=summary,issuetype&maxResults=100",
        { headers: authHeaders }
      );
      if (!r.ok) return json({ error: "Jira menolak (" + r.status + "): " + (await r.text()).slice(0, 300) }, 502);
      const data = await r.json();
      return json({
        items: (data.issues || []).map((i) => ({
          key: i.key,
          summary: (i.fields && i.fields.summary) || "",
          type: (i.fields && i.fields.issuetype && i.fields.issuetype.name) || null,
        })),
      });
    }

    // GET /worklog-report?from=YYYY-MM-DD&to=YYYY-MM-DD — total worklog milik
    // pemilik token per tanggal (semua project), untuk panel "sudah ter-log
    // berapa hari ini" di Catet. Dua tahap: JQL worklogAuthor mencari tiket
    // yang memuat worklog-ku pada rentang itu, lalu worklog tiap tiket
    // diambil dan dijumlahkan per tanggal (tanggal lokal penulisnya — Jira
    // menyimpan started lengkap dengan offset zona waktu).
    if (request.method === "GET" && url.pathname === "/worklog-report") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
        return json({ error: "Parameter from/to harus YYYY-MM-DD dan from ≤ to." }, 400);
      }
      if ((new Date(to) - new Date(from)) / 86400000 > 31) {
        return json({ error: "Rentang maksimal 31 hari." }, 400);
      }
      const meR = await fetch(site + "/rest/api/3/myself", { headers: authHeaders });
      if (!meR.ok) return json({ error: "Jira menolak (" + meR.status + ")" }, 502);
      const me = (await meR.json()).accountId;

      const jql = 'worklogAuthor = currentUser() AND worklogDate >= "' + from + '" AND worklogDate <= "' + to + '"';
      const sR = await fetch(
        site + "/rest/api/3/search/jql?jql=" + encodeURIComponent(jql) + "&fields=summary&maxResults=50",
        { headers: authHeaders }
      );
      if (!sR.ok) return json({ error: "Jira menolak (" + sR.status + "): " + (await sR.text()).slice(0, 300) }, 502);
      // Maks 40 tiket per permintaan — di bawah kuota 50 subrequest Worker.
      const issues = ((await sR.json()).issues || []).slice(0, 40);

      // Pagar zona waktu: filter startedAfter/Before dilonggarkan ±1 hari,
      // penyaring pastinya tetap perbandingan tanggal lokal di bawah.
      const afterMs = new Date(from + "T00:00:00Z").getTime() - 86400000;
      const beforeMs = new Date(to + "T23:59:59Z").getTime() + 86400000;
      const hasil = await Promise.all(issues.map(async (i) => {
        const r = await fetch(
          site + "/rest/api/3/issue/" + encodeURIComponent(i.key) + "/worklog" +
            "?startedAfter=" + afterMs + "&startedBefore=" + beforeMs + "&maxResults=1000",
          { headers: authHeaders }
        );
        if (!r.ok) return { key: i.key, logs: [] };
        return { key: i.key, logs: (await r.json()).worklogs || [] };
      }));

      // Teks polos dari comment ADF (dipangkas 200 huruf).
      const adfText = (n) => !n ? "" :
        (typeof n.text === "string" ? n.text : (n.content || []).map(adfText).join(" ").trim());

      const days = {};
      for (const { key, logs } of hasil) {
        for (const w of logs) {
          if (!w.author || w.author.accountId !== me) continue;
          const tgl = String(w.started || "").slice(0, 10); // tanggal lokal penulis
          if (tgl < from || tgl > to) continue;
          const d = (days[tgl] = days[tgl] || { total: 0, items: {}, entries: [] });
          d.total += w.timeSpentSeconds || 0;
          d.items[key] = (d.items[key] || 0) + (w.timeSpentSeconds || 0);
          d.entries.push({
            key, started: w.started, seconds: w.timeSpentSeconds || 0,
            comment: adfText(w.comment).replace(/\s+/g, " ").slice(0, 200),
          });
        }
      }
      // items: objek → array tersortir jam terbesar, biar enak ditampilkan.
      for (const tgl of Object.keys(days)) {
        days[tgl].items = Object.entries(days[tgl].items)
          .map(([key, seconds]) => ({ key, seconds }))
          .sort((a, b) => b.seconds - a.seconds);
        days[tgl].entries.sort((a, b) => String(a.started).localeCompare(String(b.started)));
      }
      const summaries = {};
      for (const i of issues) summaries[i.key] = (i.fields && i.fields.summary) || "";
      return json({ from, to, days, summaries });
    }

    // POST /worklog — { key, started (ISO), timeSpentSeconds, comment }
    if (request.method === "POST" && url.pathname === "/worklog") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "Body harus JSON." }, 400); }
      const { key, started, timeSpentSeconds, comment } = body || {};
      if (!key || !timeSpentSeconds) return json({ error: "Field key dan timeSpentSeconds wajib diisi." }, 400);
      if (!/^[A-Z][A-Z0-9]{1,9}-\d+$/.test(key)) return json({ error: "Format key tidak valid." }, 400);

      const payload = { timeSpentSeconds: Math.max(60, Math.round(Number(timeSpentSeconds))) };
      const startedJira = started ? toJiraDate(started) : null;
      if (startedJira) payload.started = startedJira;
      if (comment) {
        payload.comment = {
          type: "doc", version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: String(comment).slice(0, 2000) }] }],
        };
      }
      const r = await fetch(site + "/rest/api/3/issue/" + encodeURIComponent(key) + "/worklog", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) return json({ error: "Jira menolak (" + r.status + "): " + (await r.text()).slice(0, 300) }, 502);
      return json({ ok: true });
    }

    // GET/PUT /state — sinkronisasi data antar perangkat. Satu blob JSON per
    // pengguna, last-write-wins di klien. Penyimpanan: D1 (kuota tulis besar,
    // siap multi-user); KV lama tetap didukung dan datanya dimigrasi otomatis
    // saat akses pertama.
    if (url.pathname === "/state") {
      if (!env.CATET_DB && !env.CATET_KV) {
        return json({ error: "Storage belum dikonfigurasi — buat D1 (wrangler d1 create catet-db), isi database_id di wrangler.toml, deploy ulang. Lihat worker/README.md." }, 500);
      }
      if (request.method === "GET") {
        if (env.CATET_DB) {
          let row = await d1q(env, "SELECT blob FROM states WHERE user_id = ?1", [uid], "first");
          if (!row && env.CATET_KV && uid === "default") {
            const raw = await env.CATET_KV.get("state"); // migrasi sekali dari KV
            if (raw) {
              await d1q(env,
                "INSERT INTO states (user_id, blob, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(user_id) DO UPDATE SET blob = ?2, updated_at = ?3",
                [uid, raw, new Date().toISOString()], "run");
              row = { blob: raw };
            }
          }
          return json(row ? JSON.parse(row.blob) : { updatedAt: null, stores: null });
        }
        const raw = await env.CATET_KV.get("state");
        return json(raw ? JSON.parse(raw) : { updatedAt: null, stores: null });
      }
      if (request.method === "PUT") {
        let body;
        try { body = await request.json(); } catch { return json({ error: "Body harus JSON." }, 400); }
        if (!body || typeof body.updatedAt !== "string" || typeof body.stores !== "object") {
          return json({ error: "Field updatedAt dan stores wajib ada." }, 400);
        }
        const raw = JSON.stringify({ updatedAt: body.updatedAt, stores: body.stores });
        if (raw.length > 512 * 1024) return json({ error: "Data terlalu besar (maks 512 KB)." }, 413);
        if (env.CATET_DB) {
          await d1q(env,
            "INSERT INTO states (user_id, blob, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(user_id) DO UPDATE SET blob = ?2, updated_at = ?3",
            [uid, raw, body.updatedAt], "run");
        } else {
          await env.CATET_KV.put("state", raw);
        }
        return json({ ok: true, updatedAt: body.updatedAt });
      }
    }

    return json({ error: "Endpoint tidak dikenal. Yang ada: GET /tickets, POST /worklog, GET/PUT /state." }, 404);
}
