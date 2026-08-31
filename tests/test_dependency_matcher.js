const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/js/dependency-matcher.js'), 'utf8');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(source, ctx);
const matcher = ctx.CatetDependencyMatcher;
assert(matcher, 'CatetDependencyMatcher must be exported globally');
assert.strictEqual(matcher.isQa({ summary: 'Test payment callback', issueType: 'Test', labels: [] }), true);
assert.strictEqual(matcher.isQa({ summary: 'Implement payment callback', issueType: 'Task', labels: ['backend'] }), false);
assert.deepStrictEqual(Array.from(matcher.words('promotionName voucherID')), ['promo', 'name', 'voucher', 'id'],
  'camelCase API/business field names must become separate matching concepts');

function issue(key, summary, extra = {}) {
  return {
    key,
    summary,
    sprintId: '77',
    status: extra.status || 'In Progress',
    done: extra.done || false,
    issueType: extra.issueType || 'Task',
    parentKey: extra.parentKey || null,
    components: extra.components || [],
    labels: extra.labels || [],
    linkedKeys: extra.linkedKeys || [],
    mentionedKeys: extra.mentionedKeys || [],
    created: extra.created || '2026-08-01T00:00:00Z',
    ...(Object.prototype.hasOwnProperty.call(extra, 'assignedToMe')
      ? { assignedToMe: extra.assignedToMe }
      : {}),
  };
}

// Judul tidak harus sama: structural context + business concepts cukup untuk
// menghasilkan pasangan unik tanpa LLM.
const differentTitles = [
  issue('QA-101', 'Test member cannot redeem an expired voucher', {
    parentKey: 'EPIC-9', components: ['Loyalty'], labels: ['qa'], issueType: 'Test',
  }),
  issue('DEV-201', 'Correct loyalty_valid_till_date comparison during redemption', {
    parentKey: 'EPIC-9', components: ['Loyalty'], labels: ['backend'],
  }),
  issue('DEV-202', 'Add promotion name to points response', {
    parentKey: 'EPIC-8', components: ['Loyalty'], labels: ['backend'],
  }),
];
const r1 = matcher.matchSprintIssues(differentTitles, { overrides: {} });
assert.deepStrictEqual(JSON.parse(JSON.stringify(r1.matches.map((x) => [x.qaKey, x.devKey]))), [['QA-101', 'DEV-201']]);
assert.equal(r1.matches[0].source, 'auto');
assert(r1.matches[0].evidence.includes('parent sama'));

// Dua kandidat yang sama kuat tidak boleh dipilih sok yakin.
const ambiguous = [
  issue('QA-102', 'Test OTP on external partner registration', { components: ['Member'], labels: ['qa'], issueType: 'Test' }),
  issue('DEV-203', 'Implement OTP for partner registration', { components: ['Member'] }),
  issue('DEV-204', 'Validate OTP during partner registration', { components: ['Member'] }),
];
const r2 = matcher.matchSprintIssues(ambiguous, { overrides: {} });
assert.equal(r2.matches.length, 0);
assert.equal(r2.suggestions.length, 1);
assert.equal(r2.suggestions[0].qaKey, 'QA-102');
assert.equal(r2.suggestions[0].candidates.length, 2);
assert(r2.warnings.some((x) => x.type === 'qa-ambiguous' && x.key === 'QA-102'));

// Warning harus dua arah: QA tanpa dev dan dev tanpa QA.
const missing = [
  issue('QA-103', 'Test exporting monthly report', { components: ['Reporting'], labels: ['qa'], issueType: 'Test' }),
  issue('DEV-205', 'Rotate infrastructure credentials', { components: ['Platform'], labels: ['backend'] }),
];
const r3 = matcher.matchSprintIssues(missing, { overrides: {} });
assert(r3.warnings.some((x) => x.type === 'qa-missing-dev' && x.key === 'QA-103'));
assert(r3.warnings.some((x) => x.type === 'dev-missing-qa' && x.key === 'DEV-205'));

// Pilihan manual di CATET selalu menang dan tetap menghasilkan status dev.
const overridden = matcher.matchSprintIssues(ambiguous, { overrides: { 'QA-102': 'DEV-204' } });
assert.equal(overridden.matches.length, 1);
assert.equal(overridden.matches[0].devKey, 'DEV-204');
assert.equal(overridden.matches[0].source, 'manual');
assert(!overridden.warnings.some((x) => x.key === 'QA-102'));

// Native issue link adalah hard evidence, meski judul berbeda total.
const linked = [
  issue('QA-104', 'Test a customer-facing scenario', { labels: ['qa'], issueType: 'Test', linkedKeys: ['DEV-206'] }),
  issue('DEV-206', 'Repair an internal state transition', { components: ['State'] }),
];
const r4 = matcher.matchSprintIssues(linked, { overrides: {} });
assert.equal(r4.matches[0].source, 'jira-link');
assert.equal(r4.matches[0].devKey, 'DEV-206');

// Epic/spike bukan delivery dev ticket dan jangan memicu warning palsu.
const noise = [
  issue('QA-105', 'Test checkout tax calculation', { issueType: 'Test', labels: ['qa'], linkedKeys: ['DEV-207'] }),
  issue('DEV-207', 'Implement checkout tax calculation', { linkedKeys: ['QA-105'] }),
  issue('EPIC-10', 'Checkout revamp', { issueType: 'Epic' }),
  issue('SPIKE-1', 'Research tax provider', { issueType: 'Spike' }),
];
const r5 = matcher.matchSprintIssues(noise, { overrides: {} });
assert(!r5.warnings.some((x) => x.key === 'DEV-207'), 'reverse native link means dev already has QA');
assert(!r5.warnings.some((x) => x.key === 'EPIC-10' || x.key === 'SPIKE-1'),
  'epics and spikes must not be called missing QA');

// Review list is assigned-user only. Matcher still sees the whole sprint so
// Zack's QA ticket can pair with someone else's dev ticket; the UI must not
// dump every unmatched ticket in the sprint.
const mixedSprint = [
  issue('QA-201', 'Test assigned voucher expiry', { issueType: 'Test', labels: ['qa'], assignedToMe: true }),
  issue('QA-202', 'Test someone else checkout', { issueType: 'Test', labels: ['qa'], assignedToMe: false }),
  issue('DEV-301', 'Implement voucher expiry', { assignedToMe: false }),
  issue('DEV-302', 'Implement checkout', { assignedToMe: false }),
];
const r6 = matcher.matchSprintIssues(mixedSprint, { overrides: {} });
assert(r6.warnings.some((x) => x.key === 'QA-202'), 'matcher still audits the whole sprint');
assert(r6.warnings.some((x) => x.key === 'DEV-301' || x.key === 'DEV-302'),
  'unmatched teammate dev tickets remain matcher warnings');
const assignedKeys = matcher.assignedKeysFromIssues(mixedSprint);
assert.deepStrictEqual([...assignedKeys].sort(), ['QA-201']);
const review = matcher.filterAssignedReview(r6.warnings, assignedKeys);
assert(review.some((x) => x.key === 'QA-201'), 'assigned QA stays in the pairing list');
assert(!review.some((x) => x.key === 'QA-202'), 'other people\'s QA tickets must leave the pairing list');
assert(!review.some((x) => x.key === 'DEV-301' || x.key === 'DEV-302'),
  'unassigned unmatched dev tickets must leave the pairing list');
assert.deepStrictEqual(matcher.filterAssignedReview(r6.warnings, null), r6.warnings,
  'legacy candidate cache without assigned flags must not hide the list');

console.log(JSON.stringify({ ok: true, cases: 7 }));
