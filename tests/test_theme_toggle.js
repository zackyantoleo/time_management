const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const themeSource = fs.readFileSync(path.join(root, 'assets/js/theme.js'), 'utf8');

assert(html.includes('<script src="assets/js/theme.js"></script>'),
  'theme must initialize before styles render to avoid a light-mode flash');
assert(html.indexOf('assets/js/theme.js') < html.indexOf('assets/css/styles.css'),
  'theme bootstrap must load before stylesheets');
assert(html.includes('id="theme-toggle"'), 'header must expose a theme toggle');
assert(sw.includes('assets/js/theme.js'), 'offline cache must include theme behavior');

const values = new Map();
const rootElement = { dataset: {}, style: { colorScheme: '' } };
let mediaListener = null;
const media = {
  matches: true,
  addEventListener(type, fn) { if (type === 'change') mediaListener = fn; },
};
const context = vm.createContext({
  localStorage: {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
  },
  document: { documentElement: rootElement, querySelector() { return null; } },
  matchMedia() { return media; },
});
vm.runInContext(themeSource, context);
assert.strictEqual(rootElement.dataset.theme, 'dark', 'default must follow dark OS preference');
assert.strictEqual(rootElement.style.colorScheme, 'dark', 'native controls must follow effective theme');

vm.runInContext('setThemeMode("light")', context);
assert.strictEqual(values.get('catet.theme.v1'), 'light', 'explicit choice must persist locally');
assert.strictEqual(rootElement.dataset.theme, 'light', 'explicit light mode must override the OS');

vm.runInContext('toggleTheme()', context);
assert.strictEqual(rootElement.dataset.theme, 'dark', 'toggle must switch to dark mode');
assert.strictEqual(values.get('catet.theme.v1'), 'dark', 'dark choice must persist locally');

vm.runInContext('setThemeMode("system")', context);
media.matches = false;
mediaListener({ matches: false });
assert.strictEqual(rootElement.dataset.theme, 'light', 'system mode must react to OS theme changes');

console.log('theme toggle tests: OK');