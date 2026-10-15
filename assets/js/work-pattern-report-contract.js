(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkPatternReportContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const sources = ['catet', 'jira', 'telegram', 'calendar', 'hermes', 'github', 'test_artifacts'];
  const sensitive = /https?:\/\/|www\.|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b(?:bearer|basic)\s+\S+|\b(?:password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*\S+|-----BEGIN [\w ]*PRIVATE KEY-----|\b\d{6,}:\w{20,}|(?:\+\d[\d ()-]{7,}\d)|\b(?:08|628)\d{8,13}\b/i;
  function fail() { throw new Error('invalid work-pattern report contract'); }
  function exact(v, keys) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== [...keys].sort().join(',')) fail();
  }
  function text(v, max = 2000) {
    if (typeof v !== 'string' || !v || v !== v.trim() || v.length > max || /[\u0000-\u001f\u007f]/.test(v) || sensitive.test(v)) fail();
  }
  function strings(v, max = 10) { if (!Array.isArray(v) || !v.length || v.length > max) fail(); v.forEach(s => text(s)); }
  function time(v) { if (typeof v !== 'string' || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) fail(); return Date.parse(v); }
  function ref(v, nullable = false) { if (nullable && v === null) return; text(v, 200); if (!/^[a-z][A-Za-z0-9:._-]*$/.test(v)) fail(); }
  const day = ms => new Date(ms + 7 * 3600000).toISOString().slice(0, 10);
  function equal(a, b) {
    const sort = v => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort().map(([k, x]) => [k, sort(x)])) : v;
    if (JSON.stringify(sort(a)) !== JSON.stringify(sort(b))) fail();
  }
  function validateWorkPatternReport(data) {
    exact(data, ['schema_version', 'report_kind', 'report_id', 'generated_at', 'period', 'objective', 'report'].concat(data?.updated_at === undefined ? [] : ['updated_at']));
    if (data.updated_at !== undefined) time(data.updated_at);
    if (data.schema_version !== 2 || data.report_kind !== 'work_patterns' || !/^\d{4}-W\d{2}$/.test(data.report_id)) fail();
    const [year, week] = data.report_id.split('-W').map(Number);
    const monday = new Date(Date.UTC(year, 0, 4));
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) + (week - 1) * 7);
    const thursday = new Date(monday); thursday.setUTCDate(monday.getUTCDate() + 3);
    if (year < 1000 || week < 1 || week > 53 || thursday.getUTCFullYear() !== year) fail();
    const start = monday.getTime() - 7 * 3600000, end = start + 7 * 86400000, captured = time(data.generated_at);
    exact(data.period, ['start', 'end', 'label', 'timezone']);
    if (data.period.start !== day(start) || data.period.end !== day(end - 1) || data.period.timezone !== 'Asia/Jakarta') fail();
    text(data.period.label, 100); text(data.objective);
    const report = data.report;
    exact(report, ['status', 'summary', 'insights', 'coverage', 'agent_scope', 'unique_work_total', 'abstentions', 'evidence']);
    text(report.status, 100); text(report.summary);
    if (report.unique_work_total !== null || !Array.isArray(report.evidence) || report.evidence.length > 100 || !Array.isArray(report.insights) || report.insights.length > 110) fail();
    const summaries = report.evidence.length ? [
      'Ada rekaman sumber yang bisa diperiksa. Bukti belum cukup untuk menilai kualitas kerja atau memberi kritik personal.',
      'Contoh sintetis, bukan aktivitas atau penilaian Zack. Rekaman aktivitas dan jadwal dapat diperiksa; kualitas kerja belum dinilai.',
    ] : ['Belum ada rekaman sumber yang diterima pada scope ini; bukan bukti tidak ada kerja. Kualitas kerja belum dapat dinilai.'];
    if (report.status !== 'local-partial' || !summaries.includes(report.summary)) fail();
    const evidence = new Map(), originals = new Set();
    for (const e of report.evidence) {
      exact(e, ['id', 'source', 'provenance_ref', 'work_ref', 'event_at', 'attribution', 'kind', 'interval', 'sensitivity']);
      if (!sources.includes(e.source) || !['catet', 'jira', 'calendar', 'hermes'].includes(e.source) || !new RegExp(`^event:${e.source}:[a-f0-9]{64}$`).test(e.id) || evidence.has(e.id) || originals.has(e.provenance_ref) || e.sensitivity !== 'sanitized') fail();
      ref(e.provenance_ref); ref(e.work_ref, true);
      const at = time(e.event_at);
      if (at < start || at >= end || at > captured || (e.source !== 'hermes' ? e.attribution !== 'unknown' : !['user', 'agent'].includes(e.attribution))) fail();
      if (e.source === 'catet' && !['worklog', 'completion', 'interruption_marker'].includes(e.kind) || e.source === 'jira' && e.kind !== 'status_change' || e.source === 'hermes' && e.kind !== 'snapshot' || e.source === 'calendar' && e.kind !== 'meeting') fail();
      if (e.source === 'calendar') {
        exact(e.interval, ['start', 'end', 'provenance_ref']);
        if (e.interval.start !== e.event_at || e.interval.provenance_ref !== e.provenance_ref || time(e.interval.end) <= at || time(e.interval.end) > end) fail();
      } else if (e.interval !== null) fail();
      evidence.set(e.id, e); originals.add(e.provenance_ref);
    }
    exact(report.coverage, sources);
    for (const source of sources) {
      const c = report.coverage[source];
      exact(c, ['status', 'reason', 'scope_ref', 'observed_at', 'observed_event_count', 'event_count']); text(c.reason);
      const events = report.evidence.filter(e => e.source === source);
      if (!['partial', 'missing'].includes(c.status) || c.event_count !== null || c.observed_event_count !== events.length) fail();
      if (c.status === 'missing') { if (c.scope_ref !== null || c.observed_at !== null || events.length) fail(); }
      else { ref(c.scope_ref); if (time(c.observed_at) > captured || events.some(e => time(e.event_at) > time(c.observed_at))) fail(); }
    }
    exact(report.agent_scope, ['status', 'included_refs', 'excluded_refs', 'total_work', 'reason']); text(report.agent_scope.reason);
    if (report.agent_scope.status !== report.coverage.hermes.status || report.agent_scope.total_work !== null || !['included_refs', 'excluded_refs'].every(k => Number.isSafeInteger(report.agent_scope[k]) && report.agent_scope[k] >= 0 && report.agent_scope[k] <= 10000)) fail();
    exact(report.abstentions, ['communication', 'focus', 'workload', 'feedback', 'comparison']);
    const abstentionReasons = {
      communication: 'Telegram DIPARKIR dan tidak dikumpulkan; tidak ada penilaian komunikasi.',
      focus: 'Rangkaian aktivitas dan hasil tidak cukup untuk menilai fokus atau deep work.',
      workload: 'Jadwal bukan kehadiran; backlog, kapasitas dan aktivitas aktual belum lengkap.',
      feedback: 'Metadata aktivitas belum mendukung kritik/apresiasi perilaku atau saran personal.',
      comparison: 'Tidak ada baseline mingguan dengan scope, coverage dan definisi comparable.',
    };
    for (const [dimension, a] of Object.entries(report.abstentions)) {
      exact(a, dimension === 'feedback' ? ['status', 'reason', 'items'] : ['status', 'reason']); text(a.reason);
      if (a.status !== 'abstain' || a.reason !== abstentionReasons[dimension] || dimension === 'feedback' && (!Array.isArray(a.items) || a.items.length)) fail();
    }
    if (report.agent_scope.reason !== 'Accepted/excluded refs adalah metadata cakupan; nol accepted bukan nol kerja.') fail();
    const used = new Set(), ids = new Set(), insightGroups = new Set();
    for (const i of report.insights) {
      const base = ['id', 'dimension', 'type', 'source', 'weekly_total', 'observation', 'evidence_refs', 'interpretation', 'interpretation_limits', 'impact', 'confidence_reason', 'counter_context', 'suggestion'];
      exact(i, base.concat(i.dimension === 'activity' ? ['work_ref', 'attribution', 'observed_by_kind'] : i.dimension === 'rhythm' ? ['observed_by_day'] : i.dimension === 'schedule' ? ['observed_union_minutes'] : (fail(), [])));
      const group = JSON.stringify([i.dimension, i.source, i.dimension === 'activity' ? i.work_ref || i.evidence_refs?.[0] : null, i.attribution || null]);
      if (insightGroups.has(group)) fail();
      insightGroups.add(group);
      ref(i.id); if (ids.has(i.id) || i.type !== 'fact' || i.weekly_total !== null || i.suggestion !== null || !Array.isArray(i.evidence_refs) || !i.evidence_refs.length || i.evidence_refs.length > 100 || new Set(i.evidence_refs).size !== i.evidence_refs.length) fail(); ids.add(i.id);
      ['observation', 'interpretation', 'confidence_reason'].forEach(k => text(i[k])); strings(i.interpretation_limits); strings(i.counter_context);
      exact(i.impact, ['status', 'reason']); if (i.impact.status !== 'unknown') fail(); text(i.impact.reason);
      const events = i.evidence_refs.map(r => { if (!evidence.has(r)) fail(); used.add(r); return evidence.get(r); });
      if (events.some(e => e.source !== i.source)) fail();
      // ponytail: local minimum accepts deterministic facts, not arbitrary semantic claims.
      const observation = i.dimension === 'activity'
        ? `Rekaman ${i.source} dalam scope item ini: ${Object.entries(i.observed_by_kind).map(([k, v]) => `${k} ${v}`).join(', ')}.`
        : i.dimension === 'rhythm' ? `Timestamp ${i.source} teramati pada ${Object.keys(i.observed_by_day).length} tanggal WIB.`
          : `Union interval jadwal teramati ${i.observed_union_minutes} menit; overlap dihitung sekali.`;
      if (i.observation !== observation) fail();
      const contexts = {
        activity: {
          interpretation: 'Fakta rekaman sumber, bukan hasil pribadi atau dampak kerja.',
          interpretation_limits: ['Coverage partial; jumlah teramati bukan total mingguan.', 'Identitas kerja lintas sumber belum dipetakan; jumlah antar-sumber tidak dijumlahkan.', 'Deadline sekarang bukan deadline efektif historis.', 'Metadata/agent output bukan completion atau hasil Zack.'],
          confidence_reason: 'Timestamp dan referensi ada; actor atau hasil pribadi belum terverifikasi.',
          counter_context: [i.source === 'catet' ? 'Completion dapat rekonsiliasi/backfill; waktu pencatatan bukan durasi pengerjaan.' : i.source === 'jira' ? 'Status dapat diubah orang lain; perubahan scope/dependency dan prioritas belum tercakup.' : 'Output agent bukan hasil Zack; metadata aktivitas bukan bukti completion.'],
          impact: { status: 'unknown', reason: 'Tidak ada bukti outcome atau nilai yang dihasilkan.' },
        },
        rhythm: {
          interpretation: 'Sebaran waktu rekaman sumber, bukan pola kerja berulang.',
          interpretation_limits: ['Coverage partial; hari tanpa rekaman bukan hari tanpa kerja.', 'Bukan jam kerja, deep work, jumlah context switches atau penundaan deadline.'],
          confidence_reason: 'Tanggal dihitung dari timestamp zoned, tidak dari waktu snapshot atau deadline sekarang.',
          counter_context: ['Backfill, perubahan scope/dependency dan perubahan status oleh orang lain dapat mengubah sebaran.'],
          impact: { status: 'unknown', reason: 'Tidak ada bukti efek terhadap hasil kerja.' },
        },
        schedule: {
          interpretation: 'Beban jadwal yang terlihat saja, bukan beban kerja aktual.',
          interpretation_limits: ['Jadwal bukan kehadiran atau jam kerja.', 'Coverage partial; total jadwal mingguan dan beban kerja tetap unknown.'],
          confidence_reason: 'Interval/provenance tersedia dan union dihitung ulang oleh validator T3.',
          counter_context: ['Kategori belum diketahui; reminder atau event non-meeting dapat ikut. Tidak ada bukti semua jadwal dihadiri.'],
          impact: { status: 'unknown', reason: 'Kehadiran dan dampak pada kapasitas tidak tercatat.' },
        },
      };
      for (const [key, value] of Object.entries(contexts[i.dimension])) equal(i[key], value);
      if (i.dimension === 'activity') {
        if (!['catet', 'jira', 'hermes'].includes(i.source) || events.some(e => e.work_ref !== i.work_ref || e.attribution !== i.attribution)) fail();
        if (i.work_ref !== null && events.length !== report.evidence.filter(e => e.source === i.source && e.work_ref === i.work_ref && e.attribution === i.attribution).length) fail();
        const counts = {}; events.forEach(e => { counts[e.kind] = (counts[e.kind] || 0) + 1; }); equal(counts, i.observed_by_kind);
      } else if (i.dimension === 'rhythm') {
        if (!['catet', 'jira'].includes(i.source) || events.length !== report.coverage[i.source].observed_event_count) fail();
        const counts = {}; events.forEach(e => { const d = day(time(e.event_at)); counts[d] = (counts[d] || 0) + 1; }); equal(counts, i.observed_by_day);
      } else {
        if (i.source !== 'calendar' || events.length !== report.coverage.calendar.observed_event_count) fail();
        let minutes = 0, until = -Infinity;
        for (const [s, e] of events.map(e => [time(e.interval.start), time(e.interval.end)]).sort((a, b) => a[0] - b[0] || a[1] - b[1])) { minutes += Math.max(0, e - Math.max(s, until)) / 60000; until = Math.max(until, e); }
        if (i.observed_union_minutes !== minutes) fail();
      }
    }
    if (used.size !== evidence.size || new TextEncoder().encode(JSON.stringify(data)).length > 256 * 1024) fail();
    return data;
  }
  return { validateWorkPatternReport };
});
