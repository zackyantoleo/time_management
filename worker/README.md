# Proxy Jira untuk Catet (Cloudflare Worker)

Perantara kecil supaya Catet bisa menarik tiket Jira secara otomatis dan
mengirim worklog — Jira Cloud memblokir panggilan langsung dari browser
(CORS), jadi butuh satu "jembatan" yang berjalan di luar browser. Worker ini
gratis di paket Free Cloudflare (100.000 request/hari — Catet hanya butuh
ratusan).

**Keamanan singkat:** API token Jira kamu disimpan sebagai *secret* di
Cloudflare — tidak pernah ada di browser, di repo, atau di URL. Akses ke Worker
dibatasi berdasarkan **Origin**: hanya halaman dari origin yang diizinkan
(GitHub Pages aplikasi ini, `localhost` untuk dev, dan `file://`) yang boleh
memakainya. Origin dikirim & dikunci oleh browser sehingga halaman di origin
lain tak bisa memalsukannya — jadi tidak ada kunci rahasia yang perlu ditempel
di aplikasi, dan perangkat baru langsung tersinkron begitu dibuka. (Origin
tambahan bisa diset lewat variabel `ALLOWED_ORIGINS`, dipisah koma.) Walau
begitu, API token = akses penuh akun Jira-mu — pastikan ini tidak melanggar
kebijakan IT kantor, dan cabut token kapan saja dari halaman yang sama tempat
membuatnya.

## Langkah deploy (±10 menit, sekali saja)

### 1. Buat API token Atlassian
1. Buka https://id.atlassian.com/manage-profile/security/api-tokens
2. **Create API token**, beri nama mis. `catet-proxy`, salin token-nya
   (hanya muncul sekali).

### 2. Siapkan Cloudflare + wrangler
1. Daftar akun gratis di https://dash.cloudflare.com (kalau belum punya).
2. Di terminal:
   ```bash
   npm install -g wrangler
   wrangler login          # membuka browser untuk otorisasi
   ```

### 3. Deploy Worker
Dari folder `worker/` di repo ini:
```bash
cd worker

# kunci rahasia untuk Catet — buat string acak, simpan, nanti dipakai di aplikasi
openssl rand -hex 16

wrangler secret put JIRA_SITE       # isi: https://erafone.atlassian.net
wrangler secret put JIRA_EMAIL      # isi: email Atlassian kamu
wrangler secret put JIRA_API_TOKEN  # isi: token dari langkah 1

wrangler deploy
```
Catat URL yang tercetak, bentuknya:
`https://catet-jira-proxy.<subdomain-kamu>.workers.dev`

> **Tanpa terminal?** Bisa juga lewat dashboard: Workers & Pages → Create →
> paste isi `worker.js` → Deploy, lalu tab **Settings → Variables and
> Secrets** untuk mengisi ketiga secret di atas.

> **Penting — alamat proxy bawaan.** Aplikasi (`assets/js/jira.js`, konstanta
> `DEFAULT_PROXY`) menunjuk ke satu URL Worker bawaan. Kalau URL Worker-mu
> berbeda, ganti `DEFAULT_PROXY` agar cocok. Dan kalau kamu memakai domain
> selain GitHub Pages default, tambahkan origin-nya lewat variabel
> `ALLOWED_ORIGINS` di Worker.

### 4. Selesai — tidak perlu menyambungkan apa pun
Karena alamat proxy sudah tertanam di aplikasi dan akses dibatasi per-Origin
(bukan kunci), tiap perangkat yang membuka aplikasi langsung tersinkron —
**tidak ada** alamat proxy atau kunci yang perlu ditempel. Tiket assigned-mu
muncul dan diperbarui otomatis tiap 5 menit selama Catet terbuka, dan entri
Log kerja yang memuat kode tiket punya tombol **→ Jira** untuk mengirim
worklog (durasi diambil dari waktu fokus).

## Sinkronisasi antar perangkat (opsional, gratis)

Supaya data Catet di laptop dan HP sama, Worker yang sama jadi tempat
penitipan state. Penyimpanannya **Cloudflare D1** (SQLite; kuota tulis
gratis 100rb/hari — cukup untuk banyak pengguna):

```bash
cd worker
wrangler d1 create catet-db
```

Salin `database_id` dari output-nya, buka `wrangler.toml`, buka komentar
blok `[[d1_databases]]` dan tempel id-nya, lalu:

```bash
wrangler deploy
```

Tabelnya dibuat otomatis saat pertama dipakai. Instalasi lama yang memakai
KV tidak perlu langkah ekstra: data di KV dimigrasi otomatis ke D1 saat
akses pertama, dan setelah itu blok `[[kv_namespaces]]` di `wrangler.toml`
boleh dihapus. (Tanpa D1, Worker tetap jalan memakai KV seperti dulu.)

Selesai — tidak ada pengaturan tambahan di aplikasi (Catet memakai alamat
proxy bawaan). Status sinkron tampil kecil di footer
("☁ tersinkron 10.42"). Cara kerjanya: `localStorage` tetap jadi sumber
utama (offline tetap jalan); perubahan didorong ke Worker beberapa detik
kemudian, dan data terbaru ditarik saat aplikasi dibuka/kembali aktif.
Konflik ditangani last-write-wins — hindari mengedit bersamaan di dua
perangkat dalam hitungan detik yang sama.

## Multi-user: kode akses (opsional, untuk dipakai bersama)

Satu Worker + satu D1 bisa dipakai ±20 orang; data tiap orang terpisah per
kode akses.

1. Set kunci admin dan wajibkan kode:
   ```bash
   wrangler secret put ADMIN_KEY      # string acak, pegangan admin saja
   ```
   Di `wrangler.toml` tambahkan:
   ```toml
   [vars]
   REQUIRE_AUTH = "1"
   ```
   lalu `wrangler deploy`.
2. Buat kode per orang (kode hanya ditampilkan sekali — langsung kirim ke
   orangnya):
   ```bash
   curl -s -X POST https://<worker-mu>.workers.dev/admin/users \
     -H "X-Admin-Key: ADMIN_KEY_KAMU" -H "Content-Type: application/json" \
     -d '{"name":"Budi"}'
   ```
   Daftar user: `curl -s .../admin/users -H "X-Admin-Key: …"`.
   Hapus (beserta datanya): `curl -X DELETE .../admin/users/<id> -H "X-Admin-Key: …"`.
3. Tiap orang membuka aplikasi → tab **Jira** → **Access — sync** → isi kode
   → Save. Data lokal yang sudah ada terunggah otomatis ke akunnya.
   (Pemilik lama: buat kode untuk dirimu juga; begitu diisi, state lokalmu
   pindah ke akun itu.)

4. Kredensial Jira per orang: setelah kode terisi, di section **Access**
   muncul kolom **Jira credentials** — isi alamat Jira Cloud
   (`https://….atlassian.net`), email Atlassian, dan API token milik
   masing-masing (buat di id.atlassian.com → Security → API tokens).
   Tiket yang tampil dan worklog yang terkirim jadi atas nama tiap orang.
   Jira antar orang boleh beda instance; hanya Jira Cloud yang didukung.
   Secrets `JIRA_*` global jadi fallback untuk mode pribadi tanpa kode.

## Endpoint (untuk referensi)

| Method | Path | Fungsi |
|---|---|---|
| GET | `/tickets` | Tiket terbuka yang di-assign ke pemilik token (max 100) |
| GET | `/bau?project=TDBU` | Daftar tiket "topik" project BAU — wadah worklog non-sprint (meeting, deployment, dst.) |
| GET | `/worklog-report?from=…&to=…` | Total worklog pemilik token per tanggal (maks 31 hari) — panel "sudah ter-log berapa" |
| POST | `/worklog` | Kirim worklog: `{key, started, timeSpentSeconds, comment}` |
| GET/PUT | `/state` | Simpan/ambil state Catet untuk sinkron antar perangkat (butuh KV) |

Semuanya hanya bisa diakses dari Origin yang diizinkan (lihat "Keamanan
singkat" di atas) — tanpa kunci rahasia.

## Mencabut akses
- Hapus API token di https://id.atlassian.com/manage-profile/security/api-tokens → proxy langsung mati.
- Atau hapus Worker-nya di dashboard Cloudflare.
