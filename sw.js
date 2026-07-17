// Service worker Catet: network-first dengan cache fallback, supaya aplikasi
// tetap bisa dibuka di HP saat tidak ada koneksi. Versi cache dinaikkan saat
// daftar aset berubah.
const CACHE = "catet-v14";
const ASSETS = [
  "./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png",
  "assets/css/styles.css",
  "assets/js/util.js", "assets/js/tasks.js", "assets/js/sprints.js",
  "assets/js/capture.js", "assets/js/routines.js", "assets/js/jira.js",
  "assets/js/board.js", "assets/js/worklog.js", "assets/js/reminders.js",
  "assets/js/sync.js", "assets/js/backup.js", "assets/js/app.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  // Jangan cache permintaan lintas-origin (mis. proxy Jira /tickets, /state) —
  // data itu harus selalu segar dari jaringan.
  if (new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
