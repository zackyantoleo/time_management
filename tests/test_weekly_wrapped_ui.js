const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'weekly-wrapped.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'assets/css/weekly-wrapped.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'assets/js/weekly-wrapped.js'), 'utf8');
const data = JSON.parse(fs.readFileSync(path.join(root, 'assets/data/weekly-wrapped.sample.json'), 'utf8'));
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');

assert(html.includes('href="index.html"'), 'Wrapped must provide a route back to CATET');
assert(html.includes('id="wrapped-story"'), 'story/slideshow must be the first experience');
assert(html.indexOf('id="wrapped-story"') < html.indexOf('id="wrapped-report"'),
  'story must appear before the detailed report');
assert(html.includes('id="story-next"') && html.includes('id="story-prev"'),
  'story must expose explicit previous/next controls');
assert(html.includes('id="view-report"'), 'story must expose a report CTA');
assert(html.includes('aria-live="polite"'), 'slide changes must be announced accessibly');
assert(!html.includes('class="orb') && !css.includes('filter:blur'),
  'Wrapped must use CATET calm-workbench styling, not the old neon/orb theme');
assert(html.includes('href="assets/css/styles.css"') && html.includes('href="assets/css/calm-workbench.css"'),
  'Wrapped must inherit CATET styles and design tokens');
assert(css.includes('var(--accent)') && css.includes('var(--bg)'),
  'Wrapped-specific styling must consume CATET design tokens');
assert(js.includes('function renderSlide('), 'story renderer must be implemented');
assert(js.includes('ArrowRight') && js.includes('ArrowLeft'), 'story must support keyboard navigation');
assert(js.includes('goToReport'), 'story must transition to the detailed report');
assert(js.includes('prefers-reduced-motion'), 'story must respect reduced-motion preferences');
assert(Array.isArray(data.slides) && data.slides.length >= 5, 'sample needs at least five story slides');
assert(data.report && Array.isArray(data.report.scorecard), 'sample needs a detailed report scorecard');
for (const item of data.report.evidence) {
  assert.strictEqual(item.sensitivity, 'sanitized', 'all report evidence must be sanitized');
}
for (const asset of [
  'weekly-wrapped.html',
  'assets/css/weekly-wrapped.css',
  'assets/js/weekly-wrapped.js',
  'assets/data/weekly-wrapped.sample.json'
]) {
  assert(sw.includes('"' + asset + '"'), 'service worker must cache ' + asset);
}

console.log('Weekly Wrapped integration contract tests passed.');
