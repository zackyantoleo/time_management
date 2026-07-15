# Catet — catatan cepat berprioritas

Aplikasi catatan cepat untuk kerja di kantor: saat kamu sedang mengerjakan satu
tiket lalu tiba-tiba diinterupsi (rekan minta bantuan, tiket baru masuk,
meeting dadakan), catat interupsinya dalam hitungan detik — lengkap dengan
**prioritas** dan **kapan harus dikerjakan** — tanpa kehilangan jejak tiket
yang sedang kamu kerjakan.

Satu file HTML, tanpa server, tanpa install, tanpa internet. Data tersimpan di
`localStorage` browser dan tidak dikirim ke mana pun.

## Fitur

- **Slot "Sedang dikerjakan"** — tandai satu tugas sebagai fokus (tombol ▶).
  Tugas itu terpampang di paling atas beserta durasi fokus, jadi setelah
  interupsi selesai kamu langsung ingat tadi sedang mengerjakan apa.
- **Catat cepat** — ketik, pilih prioritas, Enter. Selesai.
- **Bantu nilai (skoring)** — bingung ini urgent atau bukan? Klik **🧮 Bantu
  nilai**, jawab dua hal: *kalau ditunda kenapa?* (aman / mengganggu /
  memblokir orang-produksi) dan *perkiraan usaha* (≤1 jam / ±½ hari / ≥1
  hari). Digabung dengan tenggat, Catet menghitung skor 1–10, menyarankan
  prioritas (chip-nya di-set otomatis, tetap bisa diubah), dan kapan harus
  mulai — termasuk aturan penting: tugas **lama** bertenggat dekat disuruh
  dicicil dari sekarang, bukan ditunda. Badge usaha + skor tampil di baris
  tugas, dan skor jadi penentu urutan di dalam prioritas yang sama.
- **Cari** — satu kolom cari untuk semua tab: tugas di papan, tiket Jira,
  dan entri log kerja.
- **Tab Jira terpisah** — tiket yang belum diambil punya tab sendiri (🎫,
  dengan penghitung), jadi papan utama tetap pendek dan fokus.
- **Prioritas terpisah dari waktu** — bisa mencatat "tiket ini prioritasnya
  tinggi tapi bisa dikerjakan nanti" atau "kabari orang ini besok pagi":
  - Prioritas: Urgent / Tinggi / Sedang / Rendah
  - Kapan: Bebas / Hari ini / Besok pagi / pilih tanggal-jam sendiri
- **Papan fokus "Kerjakan hari ini"** — setiap tugas dinilai ulang terus-
  menerus dengan **skor dinamis 0–10** (dampak/prioritas + kedekatan tenggat +
  perkiraan usaha; tenggat yang makin dekat menaikkan skor otomatis). Yang
  tampil di papan hanya yang memang perlu dikerjakan hari ini — skor tinggi,
  tenggat hari ini/terlambat, urgent, atau memblokir orang — terurut dari
  skor tertinggi. Sisanya terlipat rapi di bagian **"Nanti"** (tetap ada,
  sekali klik untuk membuka), jadi kamu cuma melihat yang penting sekarang.
- **Pengingat** — saat waktunya tiba, muncul pemberitahuan di dalam halaman
  (toast + bunyi bip) — ini selalu jalan, bahkan saat notifikasi browser
  diblokir atau halaman dibuka dari `file://`. Tugas yang lewat tenggat diberi
  tanda ⚠ "terlambat" dan jumlah tugas urgent/terlambat muncul di judul tab.
  Tombol 🔔 di kanan atas menyalakan/mematikan pengingat; kalau browser
  mengizinkan, notifikasi sistem ikut dikirim sebagai lapisan tambahan.
  Catatan: sekali izin notifikasi ditolak, browser tidak akan menampilkan
  prompt-nya lagi — buka bloknya lewat ikon gembok di address bar →
  Notifikasi → Izinkan.
- **Edit tugas** — tombol ✎ di baris tugas membuka panel untuk mengubah
  **judul**, **prioritas**, **tenggat** (Bebas / Hari ini / Besok pagi /
  pilih sendiri), **perkiraan usaha**, dan **sprint** — langsung tersimpan,
  dan tugas otomatis pindah ke "Kerjakan hari ini" begitu skornya naik.
  (Judul juga bisa diubah cepat dengan klik dua kali di teksnya.) Tugas
  selesai tersimpan di bagian "Selesai" yang bisa dibersihkan.
- **Rutinitas harian** — tugas berulang seperti daily standup, cek email,
  atau isi worklog cukup didefinisikan sekali (teks + jam pengingat opsional +
  pilihan hari, default Senin–Jumat). Setiap hari mereka muncul sebagai
  checklist "Rutinitas hari ini" di papan, otomatis kosong lagi keesokan
  harinya. Rutinitas berjam diingatkan (toast/notifikasi) pada jamnya sampai
  dicentang, dan yang dicentang ikut tercatat ke Log kerja dengan label
  [rutin].
- **Log kerja harian** — tab "🗒 Log kerja" berisi semua tugas yang selesai,
  dikelompokkan per hari lengkap dengan jam selesai dan total lama fokus
  (dihitung dari berapa lama tugas berada di slot "Sedang dikerjakan").
  Tombol **Salin** menyalin log satu hari sebagai teks siap tempel ke
  worklog Jira, laporan harian, atau standup. Log bersifat riwayat
  tersendiri: membersihkan bagian "Selesai" di papan tidak menghapusnya.
- **Integrasi Jira ringan** — kode tiket (mis. `ERA-1234`) di teks tugas,
  kartu fokus, dan log kerja otomatis jadi link ke Jira (alamat situs bisa
  diatur di panel impor). Section **"Tiket Jira — belum diambil"** menampung
  tiket hasil impor (tempel daftar dari Claude, atau baris `KODE-123
  ringkasan`); tombol **＋ Ambil** memindahkan tiket ke papan utama sebagai
  tugas biasa yang bisa diprioritaskan dan difokuskan. Catatan: Jira Cloud
  memblokir akses API langsung dari browser (CORS), jadi impor tempel-manual
  ini adalah jalur tanpa-backend yang paling aman.
- **Sprint** — kelompokkan pekerjaan ke sprint dengan tanggal selesai (buat
  di tab Jira). Tiket Jira masuk lewat tombol **🏃 Sprint** di tab Jira;
  tugas catatan biasa masuk lewat tombol 🏃 di baris tugas (toggle
  keluar/masuk) atau chip **🏃 [nama sprint]** di kolom catat cepat untuk
  tugas baru. Akhir sprint
  ikut menekan skor dinamis semua tugas anggotanya: ≤1 minggu mulai naik,
  ≤3 hari melonjak dan otomatis muncul di "Kerjakan hari ini", hari terakhir
  setara tenggat terlambat. Badge 🏃 di baris tugas memerah saat sprint
  mepet. Menghapus sprint tidak menghapus tugasnya.
  - **Kelola sprint** (tombol ✎ di bar sprint): ubah nama & tanggal selesai,
    lihat daftar tugas di dalamnya, keluarkan tugas, atau tekan **✓ Selesai
    sprint** untuk menutupnya — tercatat di Log kerja dan tekanan skornya
    berhenti. Sprint yang ditutup masuk area "Sprint selesai".
  - **Pilih sprint per tugas**: tombol 🏃 di baris tugas membuka menu pilih
    sprint langsung (masuk / pindah antar sprint / keluarkan) — sama juga di
    tombol 🏃 pada tiket Jira dan di chip 🏃 kolom catat cepat untuk tugas
    baru.
- **Sinkronisasi Jira otomatis (opsional)** — deploy proxy kecil di
  Cloudflare Worker (gratis; kode + panduan di [`worker/`](worker/)), isi
  alamat + kunci di panel impor, dan Catet menarik tiket assigned-mu otomatis
  tiap 5 menit (plus tombol ⟳). Tiket yang selesai/di-reassign di Jira hilang
  sendiri dari inbox; yang sudah di-Ambil atau dibuang (✕) tidak muncul lagi.
  Bonus dua-arah: entri Log kerja yang memuat kode tiket punya tombol
  **→ Jira** untuk mengirim worklog (durasi diambil dari waktu fokus).
- Tema terang & gelap mengikuti pengaturan sistem.

## Cara pakai

### Paling cepat
Buka `index.html` di browser apa pun:

```bash
xdg-open index.html
```

### Sebagai "aplikasi" Linux (window sendiri, ada di app launcher)

Browser berbasis Chromium (Chrome/Chromium/Brave/Edge) punya mode app —
jendela sendiri tanpa address bar:

```bash
chromium --app="file://$HOME/time_management/index.html"
```

Supaya muncul di application launcher (GNOME/KDE), buat file
`~/.local/share/applications/catet.desktop`:

```ini
[Desktop Entry]
Type=Application
Name=Catet
Comment=Catatan cepat berprioritas
Exec=chromium --app=file:///home/USERNAME/time_management/index.html
Icon=accessories-text-editor
Categories=Office;Utility;
```

Ganti `USERNAME` dengan user kamu (dan `chromium` dengan `google-chrome` /
`brave` kalau itu yang terpasang), lalu:

```bash
update-desktop-database ~/.local/share/applications/ 2>/dev/null || true
```

Setelah itu "Catet" bisa dicari di launcher dan di-pin ke taskbar/dock.

> Catatan: data `localStorage` terikat ke browser + lokasi file. Selama kamu
> membukanya dari path dan browser yang sama, datamu tetap ada.

### Sebagai website
File-nya statis, jadi bisa juga di-host di mana saja (GitHub Pages, Netlify,
server internal kantor). Ingat: data tetap tersimpan per-browser, bukan
di server.

## Alur kerja yang disarankan

1. Pagi hari: buka Catet, tekan ▶ pada tiket yang mau dikerjakan.
2. Ada yang mampir? Klik **"⚡ Ada interupsi? Catat dulu"**, ketik
   (mis. "bantu ABC — deploy staging"), pilih prioritas + kapan, Enter.
   Balik kerja. Fokus kamu tidak berubah.
3. Interupsi yang memang harus sekarang? Tekan ▶ pada catatan barunya —
   tiket lama otomatis kembali ke daftar, tidak hilang.
4. Selesai satu tugas → **✓ Selesai**, lalu ▶ tugas berikutnya dari
   kelompok prioritas teratas.
