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

// Query D1 dengan auto-buat tabel saat pertama dipakai. mode: first|run|all.
const SKEMA = [
  "CREATE TABLE IF NOT EXISTS states (user_id TEXT PRIMARY KEY, blob TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, jira_site TEXT, jira_email TEXT, jira_token TEXT, created_at TEXT NOT NULL)",
];
async function d1q(env, sql, params, mode) {
  const jalan = () => {
    const st = env.CATET_DB.prepare(sql).bind(...params);
    return mode === "first" ? st.first() : mode === "all" ? st.all() : st.run();
  };
  try { return await jalan(); }
  catch (e) {
    if (!/no such table/i.test(String(e && e.message))) throw e;
    for (const s of SKEMA) await env.CATET_DB.exec(s);
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
    "SELECT id, name, jira_site, jira_email, jira_token FROM users WHERE token_hash = ?1",
    [await sha256hex(kode)], "first");
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (!env.JIRA_SITE || !env.JIRA_EMAIL || !env.JIRA_API_TOKEN) {
      return json({ error: "Worker belum dikonfigurasi — set secrets JIRA_SITE, JIRA_EMAIL, JIRA_API_TOKEN." }, 500);
    }
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

    const site = env.JIRA_SITE.trim().replace(/\/+$/, "");
    const authHeaders = {
      Authorization: "Basic " + btoa(env.JIRA_EMAIL + ":" + env.JIRA_API_TOKEN),
      Accept: "application/json",
    };
    const url = new URL(request.url);

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
  },
};
