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
- **Prioritas terpisah dari waktu** — bisa mencatat "tiket ini prioritasnya
  tinggi tapi bisa dikerjakan nanti" atau "kabari orang ini besok pagi":
  - Prioritas: Urgent / Tinggi / Sedang / Rendah
  - Kapan: Bebas / Hari ini / Besok pagi / pilih tanggal-jam sendiri
- **Daftar terurut otomatis** — dikelompokkan per prioritas, di dalamnya
  diurutkan berdasarkan tenggat terdekat.
- **Pengingat** — saat waktunya tiba, muncul pemberitahuan di dalam halaman
  (toast + bunyi bip) — ini selalu jalan, bahkan saat notifikasi browser
  diblokir atau halaman dibuka dari `file://`. Tugas yang lewat tenggat diberi
  tanda ⚠ "terlambat" dan jumlah tugas urgent/terlambat muncul di judul tab.
  Tombol 🔔 di kanan atas menyalakan/mematikan pengingat; kalau browser
  mengizinkan, notifikasi sistem ikut dikirim sebagai lapisan tambahan.
  Catatan: sekali izin notifikasi ditolak, browser tidak akan menampilkan
  prompt-nya lagi — buka bloknya lewat ikon gembok di address bar →
  Notifikasi → Izinkan.
- **Edit & riwayat** — klik dua kali untuk mengedit teks; tugas selesai
  tersimpan di bagian "Selesai" yang bisa dibersihkan.
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
