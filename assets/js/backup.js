// backup.js — ekspor/impor seluruh data ke/dari file .json. Jaring pengaman
// yang TIDAK bergantung ke sinkron cloud: pindah data antar browser/perangkat
// cukup dengan unduh di satu tempat lalu impor di tempat lain.
"use strict";

function exportData() {
  const payload = {
    catetBackup: 1,
    exportedAt: new Date().toISOString(),
    stores: kumpulkanStores(), // dari sync.js
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "catet-backup-" + localDateStr(new Date()) + ".json";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Restore penuh: menimpa data browser ini dengan isi file (termasuk alamat
// proxy + kunci, supaya perangkat baru langsung ikut tersambung ke sinkron).
function importDataFromText(text) {
  let data;
  try { data = JSON.parse(text); }
  catch { alert("File tidak valid (bukan JSON)."); return; }
  const s = data && data.stores ? data.stores : data;
  const dikenali = s && typeof s === "object" &&
    (Array.isArray(s.tasks) || Array.isArray(s.sprints) || (s.jira && Array.isArray(s.jira.items)));
  if (!dikenali) { alert("File ini bukan cadangan Catet yang dikenali."); return; }
  const n = Array.isArray(s.tasks) ? s.tasks.length : 0;
  if (!confirm("Impor akan MENGGANTI semua data di browser ini dengan isi file (" +
    n + " tugas). Data lama di sini akan hilang. Lanjutkan?")) return;
  const put = (k, v) => { if (v != null) localStorage.setItem(k, JSON.stringify(v)); };
  put("catet.tasks.v1", s.tasks);
  put("catet.worklog.v1", s.worklog);
  put("catet.routines.v1", s.routines);
  put("catet.routineday.v1", s.routineday);
  put("catet.sprints.v1", s.sprints);
  put("catet.jira.v1", s.jira);
  // Tandai perlu di-push kalau sinkron aktif, lalu muat ulang biar semua state
  // terbaca bersih dari localStorage.
  localStorage.setItem("catet.dirty.v1", "1");
  location.reload();
}

// Dipanggil sekali dari app.js.
function initBackup() {
  const btnE = $("#export-btn"), btnI = $("#import-btn"), file = $("#import-file");
  if (btnE) btnE.onclick = exportData;
  if (btnI && file) {
    btnI.onclick = () => file.click();
    file.onchange = (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => { importDataFromText(String(rd.result)); file.value = ""; };
      rd.readAsText(f);
    };
  }
}
