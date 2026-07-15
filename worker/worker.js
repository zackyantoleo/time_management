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
//   CATET_KEY      string acak; Catet harus mengirimkannya di header X-Catet-Key

const CORS = {
  "Access-Control-Allow-Origin": "*",
  // PUT wajib ada di sini — sinkronisasi state pakai PUT /state; tanpa PUT,
  // preflight CORS gagal dan browser memblokir permintaannya.
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Catet-Key",
  "Access-Control-Max-Age": "86400",
};

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

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (!env.JIRA_SITE || !env.JIRA_EMAIL || !env.JIRA_API_TOKEN || !env.CATET_KEY) {
      return json({ error: "Worker belum dikonfigurasi — set secrets JIRA_SITE, JIRA_EMAIL, JIRA_API_TOKEN, CATET_KEY." }, 500);
    }
    if (request.headers.get("X-Catet-Key") !== env.CATET_KEY) {
      return json({ error: "Kunci salah atau tidak dikirim (header X-Catet-Key)." }, 401);
    }

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
          "&fields=summary,status&maxResults=100",
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
        })),
      });
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

    // GET/PUT /state — sinkronisasi data Catet antar perangkat lewat KV.
    // Satu blob JSON per pengguna; strategi last-write-wins di sisi klien.
    if (url.pathname === "/state") {
      if (!env.CATET_KV) {
        return json({ error: "KV belum dikonfigurasi — buat namespace (wrangler kv namespace create CATET_KV), isi id-nya di wrangler.toml, lalu deploy ulang. Lihat worker/README.md." }, 500);
      }
      if (request.method === "GET") {
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
        await env.CATET_KV.put("state", raw);
        return json({ ok: true, updatedAt: body.updatedAt });
      }
    }

    return json({ error: "Endpoint tidak dikenal. Yang ada: GET /tickets, POST /worklog, GET/PUT /state." }, 404);
  },
};
