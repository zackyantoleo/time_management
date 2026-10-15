'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const context = { matchMedia: () => ({ matches: false, addEventListener() {} }),
  document: { documentElement: { dataset: {}, style: {} }, querySelector: () => null },
  localStorage: { getItem() { throw new Error('storage denied'); }, setItem() { throw new Error('storage denied'); } } };
vm.createContext(context);
assert.doesNotThrow(() => vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets/js/theme.js'), 'utf8'), context), 'offline/sandbox viewer must render without storage');
assert.doesNotThrow(() => context.setThemeMode('dark'));
assert.equal(context.document.documentElement.dataset.theme, 'dark');
console.log('THEME_STORAGE_BOUNDARY_OK: denied storage uses in-memory theme');
