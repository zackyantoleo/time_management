# Catet — panduan pengembangan

Aplikasi web statis satu file (`index.html`) berbahasa Indonesia: catatan cepat
berprioritas + rutinitas harian + log kerja. Tanpa build step, tanpa dependensi;
semua CSS/JS inline. Data pengguna di `localStorage`.

## Alur kerja git (WAJIB)

- **JANGAN pernah push langsung ke `main`.**
- Setiap perubahan dibuat di **branch baru sendiri** yang dibuat dari `main`
  terbaru (mis. `fitur/nama-fitur`, `fix/nama-bug`), lalu di-push ke branch itu.
- Pemilik repo yang memutuskan merge ke `main`. Merge ke `main` otomatis
  men-deploy ke GitHub Pages (https://zackyantoleo.github.io/time_management/)
  lewat `.github/workflows/pages.yml`.

## Struktur

- `index.html` — seluruh aplikasi (CSS + HTML + JS inline)
- `sw.js` — service worker (network-first); `manifest.webmanifest` + `icon-*.png` — PWA
- Kunci localStorage: `catet.tasks.v1`, `catet.worklog.v1`, `catet.routines.v1`,
  `catet.routineday.v1`, `catet.reminders.v1` — jaga kompatibilitas mundur;
  kalau skema berubah, tulis migrasi, jangan menghapus data pengguna.

## Verifikasi sebelum commit

1. Cek sintaks JS inline: ekstrak isi `<script>` lalu `node --check`.
2. Uji end-to-end dengan Playwright + Chromium headless
   (`/opt/pw-browsers/.../chrome`): buka `index.html`, jalankan alur yang
   diubah, pastikan tanpa error console, lalu screenshot tema terang & gelap.
3. UI dan teks aplikasi berbahasa Indonesia.
