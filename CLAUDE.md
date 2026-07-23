# Catet — panduan pengembangan

Aplikasi web statis berbahasa Indonesia: catatan cepat berprioritas +
rutinitas harian + log kerja + integrasi Jira. Tanpa build step, tanpa
dependensi, tanpa framework. Data pengguna di `localStorage`.

## Alur kerja git (WAJIB)

- **JANGAN pernah push langsung ke `main`.**
- Setiap perubahan dibuat di **branch baru sendiri** yang dibuat dari `main`
  terbaru (mis. `fitur/nama-fitur`, `fix/nama-bug`), lalu di-push ke branch itu.
- Pemilik repo yang memutuskan merge ke `main`. Merge ke `main` otomatis
  men-deploy ke GitHub Pages (https://zackyantoleo.github.io/time_management/)
  lewat `.github/workflows/pages.yml`.

## Struktur

- `index.html` — markup saja; memuat CSS + JS lewat tag `<link>`/`<script src>`
- `assets/css/styles.css` — seluruh style (token tema di `:root`, terang & gelap)
- `assets/js/` — satu file per fitur, **skrip klasik** (bukan ES module, supaya
  tetap jalan dari `file://`), berbagi state lewat global scope. Urutan muat
  di `index.html` penting:
  1. `util.js` — helper DOM (`$`, `el`), `uid`, format tanggal/waktu, salin teks
  2. `tasks.js` — state `tasks` + `worklog`; skor dinamis (`skorTugas`, `masukHariIni`); selesai/batal/fokus; tumpukan interupsi (`fokuskan`, `lanjutkanTumpukan` — field `ditumpuk` di tugas)
  3. `sprints.js` — sprint (nama + tanggal selesai); `sprintPts` menekan skor anggotanya (sadar-beban); `sprintKuotaHariIni` = jatah harian burn-down untuk "Do today"; `completeSprint` tutup + log. Sprint OTOMATIS dari Jira (`rekonsiliasiSprintJira` di syncJira; id `jira:<id>`, field `auto`) — dibuat/ditaut/dihapus dari sprint aktif tiket (field Sprint `customfield_*`); manual tetap didukung; penetapan manual (tombol 🏃/chip) boleh menyasar sprint auto juga — flag `sprintManual` di tugas membuat rekonsiliasi tidak melawannya
  4. `capture.js` — kolom catat cepat (prioritas, kapan, `addTask`)
  5. `routines.js` — rutinitas harian + render section-nya
  6. `jira.js` — autolink kode tiket, inbox tiket, impor, sinkron via proxy; topik BAU (`jira.bau`, `cocokBau`, `syncBau` — worklog non-sprint ke tiket topik, mis. project TDBU)
  6b. `calendar.js` — jadwal Google Calendar (secret iCal URL) → section "Today's meetings" di Board; tarik via proxy (`/calendar`), parse iCal + RRULE di Worker
  7. `board.js` — render papan (kartu fokus, "Kerjakan hari ini" terurut skor, "Nanti" terlipat)
  8. `worklog.js` — render tab Log kerja, salin per hari, kirim worklog → Jira
  9. `reminders.js` — toggle pengingat, toast + bip, notifikasi, `checkDue`
  10. `sync.js` — sinkron antar perangkat via Worker+KV (`syncDirty` dipanggil
      semua `save*()`); `backup.js` — ekspor/impor data ke file .json
      semua `save*()`; push debounce, pull saat buka/visible; last-write-wins)
  11. `settings.js` — render panel Settings (`renderSettings`), dibuka lewat
      tombol kecil ⚙️ di pojok kanan atas header (`#settings-btn`), bukan tab
      di `.tabs`. Hanya me-mount `renderAksesSection` (kode akses + kredensial
      Jira + Google Calendar, didefinisikan di `jira.js`/`calendar.js`) ke
      `#settings-access`. Baris Reminders & Backup di panel ini markup-nya
      statis di `index.html` (tombol `#notif-btn`/`#export-btn`/`#import-btn`
      sama persis, cuma pindah lokasi dari header lama) supaya binding sekali
      di `initReminders()`/`initBackup()` tidak perlu diulang saat panel
      dirender ulang.
  12. `app.js` — `view`/`render()`/`setView()` + `initApp()` (semua binding & timer)
- `sw.js` — service worker network-first + auto-update (reload saat SW baru aktif); **tambahkan file baru ke `ASSETS`
  dan naikkan versi `CACHE`** setiap daftar aset berubah
- `manifest.webmanifest` + `icon-*.png` — PWA (Add to Home Screen)
- `worker/` — proxy Cloudflare Worker untuk Jira (deploy manual oleh pemilik,
  bukan bagian dari Pages); panduan di `worker/README.md`
- Kunci localStorage: `catet.tasks.v1`, `catet.worklog.v1`, `catet.routines.v1`,
  `catet.routineday.v1`, `catet.reminders.v1`, `catet.jira.v1`,
  `catet.sprints.v1` — jaga
  kompatibilitas mundur; kalau skema berubah, tulis migrasi, jangan menghapus
  data pengguna.

## Konvensi kode

- Fungsi render membangun DOM dengan `el()`/`append` — **jangan pernah**
  merender teks pengguna lewat `innerHTML`.
- Setelah mengubah state: panggil fungsi `save*()` yang sesuai lalu `render()`.
- Binding event global dan `setInterval` hanya di `initApp()` (`app.js`),
  bukan di top-level file fitur.

## Verifikasi sebelum commit

1. `node --check assets/js/*.js` (loop semua file).
2. Uji end-to-end dengan Playwright + Chromium headless
   (`/opt/pw-browsers/.../chrome`): jalankan alur yang diubah lewat dua cara —
   `file://` langsung dan `python3 -m http.server` — pastikan tanpa error
   console, lalu screenshot tema terang & gelap.
3. Bahasa UI: label pendek (tombol, tab, judul section, chip, badge) berbahasa
   Inggris; teks penjelasan (hint, empty state, dialog/alert, tooltip) tetap
   berbahasa Indonesia. Nama hari/bulan tetap format Indonesia.
