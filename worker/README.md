# Proxy Jira untuk Catet (Cloudflare Worker)

Perantara kecil supaya Catet bisa menarik tiket Jira secara otomatis dan
mengirim worklog, dan membuat issue link + chip description pasangan QA↔dev hanya setelah tombol **Upload ke Jira** diklik — Jira Cloud memblokir panggilan langsung dari browser
(CORS), jadi butuh satu "jembatan" yang berjalan di luar browser. Worker ini
gratis di paket Free Cloudflare (100.000 request/hari — Catet hanya butuh
ratusan).

### Upload ticket pairing ke Jira

CATET tetap read-only selama sync dan proses pencocokan. Write hanya terjadi saat
pengguna sudah memilih satu kandidat lalu menekan **Upload ke Jira**. Worker akan:

1. memvalidasi kedua issue key;
2. memastikan keduanya berada di active sprint yang sama (hanya jika Relates
   belum ada);
3. menghindari duplicate link dan duplicate chip;
4. membuat native issue link bertipe **Relates** (simetris, bukan menebak arah
   Blocks/Depends);
5. menempel **chip/button** tiket dev (`inlineCard`) di **description tiket QA**,
   tanpa menimpa isi description yang sudah ada;
6. membaca tiket QA kembali dan baru melaporkan sukses setelah link **dan**
   chip description terverifikasi.

**Keamanan singkat:** setiap endpoint data **wajib kode akses valid**
(header `X-Catet-Key`); kode kosong atau salah selalu `401`, tanpa memanggil
Jira dan tanpa menyentuh storage. Kredensial Jira, QAlity, dan kalender
disimpan per akun di D1, bukan di frontend/repo — tidak ada user `default`
anonim dan tidak ada secret Jira global. Allowlist **Origin hanya lapisan CORS
browser**, bukan login: klien non-browser dapat mengirim header Origin sendiri.
Pengecualian hanya `/admin/users` (butuh `ADMIN_KEY`) dan `POST /signup`
(butuh `SIGNUP_SECRET`). Sejak perubahan ini variabel `REQUIRE_AUTH` tidak
dipakai lagi — keamanan tidak bergantung pada variabel Worker.

Origin tambahan diatur melalui `ALLOWED_ORIGINS`. API token tetap membawa
izin akun Jira pemiliknya; pastikan kebijakan kantor mengizinkan integrasi
ini dan gunakan izin minimum yang diperlukan.

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

wrangler secret put ADMIN_KEY   # string acak (openssl rand -hex 16), pegangan admin saja

wrangler deploy --keep-vars
```
Catat URL yang tercetak, bentuknya:
`https://catet-jira-proxy.<subdomain-kamu>.workers.dev`

> **Tanpa terminal?** Bisa juga lewat dashboard: Workers & Pages → Create →
> paste isi `worker.js` → Deploy, lalu tab **Settings → Variables and
> Secrets** untuk mengisi `ADMIN_KEY`. Worker butuh D1 (lihat bagian
> sinkronisasi) karena kode akses disimpan di sana.

> **Penting — alamat proxy bawaan.** Aplikasi (`assets/js/jira.js`, konstanta
> `DEFAULT_PROXY`) menunjuk ke satu URL Worker bawaan. Kalau URL Worker-mu
> berbeda, ganti `DEFAULT_PROXY` agar cocok. Dan kalau kamu memakai domain
> selain GitHub Pages default, tambahkan origin-nya lewat variabel
> `ALLOWED_ORIGINS` di Worker.

### 4. Hubungkan akun
Alamat proxy default sudah tertanam. Buat kode akses melalui admin/self-service
seperti bagian multi-user, sign in di Settings pada tiap perangkat, lalu isi
**Jira credentials** (site, email, API token dari langkah 1) sekali di akun itu.
Tiket assigned diperbarui tiap 5 menit selama Catet terbuka; tombol **→ Jira**
mengirim worklog hanya setelah aksi pengguna.

## Sinkronisasi antar perangkat (opsional, gratis)

Supaya data Catet di laptop dan HP sama, Worker yang sama jadi tempat
penitipan state. Penyimpanannya **Cloudflare D1** (SQLite; kuota tulis
gratis 100rb/hari — cukup untuk banyak pengguna).

Snapshot prioritas harian scheduler disimpan lewat endpoint terpisah
`GET/PUT /priority-snapshot`, bukan di blob `/state`. Dengan begitu cron tidak
pernah menimpa edit task browser. Baca dan tulis wajib membawa kode akses
pemilik snapshot (`CATET_ACCESS_KEY` di host scheduler, file mode 0600).
`PRIORITY_SERVICE_TOKEN` tidak diperiksa lagi; pemanggil lama yang masih
mengirim header `Authorization` tetap jalan.

```bash
cd worker
wrangler d1 create catet-db
```

Salin `database_id` dari output-nya, buka `wrangler.toml`, buka komentar
blok `[[d1_databases]]` dan tempel id-nya, lalu:

```bash
wrangler deploy
```

Tabel dasar dibuat otomatis saat pertama dipakai. D1 wajib: tanpa D1 kode
akses tidak bisa dicek, jadi semua endpoint data menjawab `401`. KV lama
hanya pernah menyimpan blob user `default` tanpa kode; Worker tidak membacanya
lagi dan blok `[[kv_namespaces]]` di `wrangler.toml` boleh dihapus.

### Schema v2 persistence

Schema v2 bersifat **additive**: tabel `states` lama tetap tersedia selama
client browser dimigrasikan bertahap. Terapkan migration sebelum memakai
endpoint v2:

```bash
cd worker
wrangler d1 migrations apply catet-db --remote
wrangler deploy
```

Endpoint baru (seperti semua endpoint data) membutuhkan access code valid:

- `GET/PUT /v2/state/:kind` — dokumen `tasks`, `routines`, `sprints`, atau
  `jira_overrides`; setiap PUT membawa `revision`, stale writer mendapat `409`.
- `GET/POST /v2/worklogs` — histori append-only; ID duplikat mendapat `409`.

Jangan dual-write dari client sebelum alur migrasi data dan rollback sudah
diverifikasi. Endpoint `/state` tetap source of truth untuk client v1.

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

1. Set kunci admin (kode akses selalu wajib, tidak perlu variabel tambahan):
   ```bash
   wrangler secret put ADMIN_KEY      # string acak, pegangan admin saja
   ```
2. Buat kode per orang (kode hanya ditampilkan sekali — langsung kirim ke
   orangnya):
   ```bash
   curl -s -X POST https://<worker-mu>.workers.dev/admin/users \
     -H "X-Admin-Key: ADMIN_KEY_KAMU" -H "Content-Type: application/json" \
     -d '{"name":"Budi"}'
   ```
   Daftar user: `curl -s .../admin/users -H "X-Admin-Key: …"`.
   Hapus (beserta datanya): `curl -X DELETE .../admin/users/<id> -H "X-Admin-Key: …"`.
3. Tiap orang membuka aplikasi → **⚙ Settings** → **Account** → **Sign in**
   → isi kode → Sign in. Data lokal yang sudah ada terunggah otomatis ke
   akunnya, dan kredensial Jira/kalender ikut dari server — **di perangkat
   baru cukup kode ini, tak perlu isi ulang**.
   (Pemilik lama: buat kode untuk dirimu juga; begitu di-sign-in, state lokalmu
   pindah ke akun itu.)

### Pendaftaran mandiri (opsional — tim buat akun sendiri)

Supaya ±20 orang bisa **buat akun sendiri** tanpa kamu jalankan curl per orang,
set satu passphrase bersama lalu bagikan sekali ke tim:

```
wrangler secret put SIGNUP_SECRET    # mis. "tim-catet-2026"
```

Lalu tiap orang: **⚙ Settings → Account → + create account** → isi nama +
passphrase → **Create account**. Sistem membuat akun & menampilkan **kode
akses sekali** (mereka simpan di password manager). Tanpa `SIGNUP_SECRET`,
pendaftaran mandiri tertutup dan kode tetap dibuat admin lewat `/admin/users`.
Endpoint `POST /signup` di-origin-gate (hanya dari app) + butuh passphrase itu.

4. Kredensial Jira per orang: setelah kode terisi, di section **Access**
   muncul kolom **Jira credentials** — isi alamat Jira Cloud
   (`https://….atlassian.net`), email Atlassian, dan API token milik
   masing-masing (buat di id.atlassian.com → Security → API tokens).
   Tiket yang tampil dan worklog yang terkirim jadi atas nama tiap orang.
   Jira antar orang boleh beda instance; hanya Jira Cloud yang didukung.
   Tanpa kredensial sendiri, rute Jira menjawab `400` — tidak pernah memakai
   kredensial orang lain atau secret global.

## Endpoint (untuk referensi)

| Method | Path | Fungsi |
|---|---|---|
| GET | `/tickets` | Tiket terbuka yang di-assign ke pemilik token; pagination lengkap. Test case QAlity (tipe `QAlity Test`) tidak masuk inbox, dependensi, maupun kandidat pairing; jumlah yang disaring di `excludedQality` |
| GET | `/missing-worklog` | Semua tiket assigned tanpa worklog milik pemilik token, termasuk Done; exclude jenis tiket QAlity, read-only |
| GET | `/bau?project=TDBU` | Daftar tiket "topik" project BAU — wadah worklog non-sprint (meeting, deployment, dst.) |
| GET | `/worklog-report?from=…&to=…` | Total worklog pemilik token per tanggal (maks 31 hari) — panel "sudah ter-log berapa" |
| POST | `/worklog` | Kirim worklog: `{key, started, timeSpentSeconds, comment}` |
| POST | `/transition` | `{key, target:"inprogress"\|"done"}` → geser status tiket (tak pernah mundur) — In Progress saat difokuskan, Done saat diselesaikan |
| GET/PUT | `/state` | Simpan/ambil state Catet untuk sinkron antar perangkat (butuh KV) |
| POST | `/me/qality` | `{token, expiresAt?}` simpan token QAlity Plus milik akun (`""` = hapus); token tidak pernah dikembalikan |
| GET | `/testcases?issue=KEY` | Test case QAlity yang sudah ter-link ke tiket + riwayat push dari D1 + `issueSummary` (judul tiket), read-only |
| POST | `/testcases/preview` | Dry run import test case: validasi, project aktif di QAlity, duplikat, rencana per case + `previewHash` + `issueSummary`; read-only |
| POST | `/testcases/push` | `{issueKey, cases, previewHash}` → import QAlity + link `QAlity Test` + baca balik; status per case. **Hanya bila `TESTCASE_PUSH_ENABLED=on`**, selain itu 404 |
| POST | `/testcases/relink` | `{issueKey, testKey}` → link ulang case `created_unlinked`/`link_unverified`; flag sama dengan push |

Semua endpoint di atas memeriksa Origin **dan** wajib access code valid
(`401` bila kosong/salah). Origin bukan pengganti autentikasi.

## Import test case QAlity

Butuh access code (token QAlity disimpan per akun di tabel D1
`qality_credentials`, dibuat otomatis lewat auto-schema; file
`migrations/0003_testcase_import.sql` berisi tabel yang sama). Dry run hanya
GET ke Jira (`project,issuetype,issuelinks,summary` tiket, tanpa description) dan
`GET /api/qalitySettings` QAlity — tidak ada write. Project yang tidak
terdaftar aktif di pengaturan QAlity ditolak. Body error QAlity/Jira tidak
diteruskan ke browser. `issueSummary` (judul tiket) dipakai mode banyak tiket
di app untuk membandingkan dengan `task_name` dari AI; app tetap jalan dengan
Worker lama tanpa field ini ("Judul Jira belum tersedia"). Mode banyak tiket
memanggil `preview`/`push` satu tiket per request, berurutan — rute Worker
tidak berubah.

**Push (feature flag).** `push`/`relink` mengembalikan 404 kecuali variabel
Worker `TESTCASE_PUSH_ENABLED` = `on`. Nyalakan/matikan tanpa redeploy Pages:

```bash
cd worker
wrangler deploy --keep-vars --var TESTCASE_PUSH_ENABLED:on    # nyalakan
wrangler deploy --keep-vars --var TESTCASE_PUSH_ENABLED:off   # rollback cepat
```

(`--keep-vars` menjaga variabel yang tidak ada di `wrangler.toml`, mis.
`TESTCASE_PUSH_ENABLED`; tanpa flag itu, deploy menghapusnya.)
Alur push: `previewHash` wajib sama dengan dry run (409 bila beda) → klaim
atomik per case di `testcase_pushes` (status `pending`; klik ganda/dua tab
tidak membuat kembar) → satu `POST /api/testCases/import` → link `QAlity Test`
per test case (`inwardIssue` = test case, `outwardIssue` = tiket) → baca balik
kedua sisi lewat satu bulkfetch. Status per case: `created_linked`,
`created_unlinked` (link ditolak → Retry link), `link_unverified`, `failed`
(QAlity 4xx/429, aman diulang), `pending` (hasil import tidak pasti, mis. 5xx),
`skipped_duplicate`, `skipped_busy`. Case `pending` tidak pernah dibuat ulang
membabi buta: setelah ±10 menit, push berikutnya mencari dulu judulnya di Jira
(project + tipe QAlity Test + rentang waktu) dan cukup me-link bila ketemu;
bila Jira tidak bisa dicek, tetap `pending`. Test case yang sudah terbuat
tidak pernah dihapus otomatis; daftarnya ada di `testcase_pushes`.
Subrequest per push: 2 baca + 1 import + N link + 1 bulkfetch (≤ 24 untuk 20
case; +1 pencarian bila ada `pending` basi).

## Pengiriman worklog aman

Client baru mengirim `entryId` stabil bersama key, started, durasi detik integer,
dan note. Worker mencatat claim atomik di tabel additive `worklog_requests`
(D1, dibuat lewat auto-schema existing), menempel property Jira `catet.entry`
berupa hash, lalu membaca worklog kembali sebelum memberi `ok` + `worklogId`.

Request ID sama dengan payload sama tidak POST lagi. Isi berbeda ditolak 409.
Jika respons POST hilang, retry merekonsiliasi property Jira, maksimal 10
halaman. Bila hasil belum pasti, Worker menolak pengiriman baru, bukan menebak
request pertama gagal. Operator perlu memeriksa Jira untuk request ambigu
permanen; tidak ada expiry lock otomatis yang dapat menduplikasi remote write.

Client lama tanpa `entryId` tetap dapat mengirim dengan read-back, tetapi tidak
memiliki jaminan dedupe lintas retry. Client baru butuh D1 untuk safe send.
Deploy Worker dahulu, frontend kemudian; rollback frontend aman, rollback
Worker lama menghilangkan perlindungan retry. Migrasi v2 state dan aktivasi auth
bukan bagian rollout ini.

## Kode akses wajib — migrasi & rollback

Versi Worker sebelum perubahan ini memperlakukan request tanpa kode (atau
kode salah) sebagai user `default` dengan secret `JIRA_*` global. Sebelum
deploy: pastikan tiap perangkat menampilkan nama akun di Settings → Account
(bukan error), dan script host mengirim `CATET_ACCESS_KEY` yang valid. Deploy
dengan `wrangler deploy --keep-vars`; rollback cepat:
`wrangler rollback <version-id-sebelumnya>`. Data tidak diubah, jadi rollback
bersih. Secret lama yang tidak dipakai kode lagi (`CATET_KEY`, `JIRA_SITE`,
`JIRA_EMAIL`, `JIRA_API_TOKEN`, `PRIORITY_SERVICE_TOKEN`) boleh dihapus
dengan `wrangler secret delete <NAMA>` setelah versi baru stabil; menghapusnya
membuat rollback ke versi lama kehilangan fallback anonim (itu memang tujuannya).

## Mencabut akses
- Hapus API token di https://id.atlassian.com/manage-profile/security/api-tokens → akses Jira akun itu langsung mati.
- Hapus user (beserta datanya) lewat `DELETE /admin/users/<id>` → kodenya langsung ditolak.
- Atau hapus Worker-nya di dashboard Cloudflare.
