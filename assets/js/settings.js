// settings.js — tab "⚙️ Settings": mengumpulkan kontrol yang sebelumnya
// tersebar di header (Reminders, Backup) dan tab Jira (Access/kredensial) ke
// satu tempat. Reminders & Backup markup-nya statis di index.html (tombolnya
// tetap sama, cuma pindah lokasi) supaya binding sekali di initReminders()/
// initBackup() tidak perlu diulang; hanya bagian kredensial yang benar-benar
// dinamis (butuh render ulang saat status berubah).
"use strict";

function renderSettings() {
  const wrap = $("#settings-access");
  wrap.innerHTML = "";
  renderAksesSection(wrap); // kode akses, kredensial Jira, Google Calendar (jira.js/calendar.js)
}
