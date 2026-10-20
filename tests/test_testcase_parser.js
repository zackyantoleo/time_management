// Synthetic fixtures only. Parser + validator test case QAlity (Fase 1, tanpa
// DOM dan tanpa jaringan): format markdown standar + JSON catet.testcases.v1.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'assets/js/testcases.js'), 'utf8');

function load(store = new Map()) {
  const context = vm.createContext({
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    tasks: [],
  });
  vm.runInContext(source, context); // tidak boleh menyentuh DOM saat dimuat
  return { run: code => vm.runInContext(code, context), context, store };
}
const { run } = load();
const parse = text => JSON.parse(JSON.stringify(run('parseTestCases')(text)));
const validate = cases => JSON.parse(JSON.stringify(run('validateTestCases')(cases)));

const one = `**Title:** Verify Get Customer Profile Successfully

**Precondition:**
- Customer has a valid access token.

**Test Step(s):**
1. Send a GET request to \`/customers/v2/profile\` using a valid access token.

**Expected Result:**
1. API returns HTTP status code \`200 OK\`.
2. Response contains the correct customer profile data according to the database.

---
`;

// 1 case markdown standar → bentuk internal catet.testcases.v1.
{
  const r = parse(one);
  assert.equal(r.format, 'catet.testcases.v1');
  assert.equal(r.source, 'markdown');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.cases, [{
    title: 'Verify Get Customer Profile Successfully',
    preconditions: ['Customer has a valid access token.'],
    steps: ['Send a GET request to `/customers/v2/profile` using a valid access token.'],
    expected: ['API returns HTTP status code `200 OK`.', 'Response contains the correct customer profile data according to the database.'],
    ignored: [],
  }]);
  const v = validate(r.cases);
  assert.equal(v.ok, true);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.cases, [{ errors: [], warnings: [] }]);
}

// Multi case: dipisah `---` maupun hanya oleh **Title:** berikutnya; CRLF.
{
  const text = (one + `**Title:** Validate Profile Without Token
**Precondition:**
- Customer is registered.
**Test Steps:**
1. Send a GET request to \`/customers/v2/profile\` without a token.
**Expected Result:**
1. API returns HTTP status code \`401 Unauthorized\`.

**Title:** Verify Profile Cache Header
**Test Step(s):**
1. Send a GET request to \`/customers/v2/profile\`.
**Expected Result:**
1. Response has a \`Cache-Control\` header.
`).replace(/\n/g, '\r\n');
  const r = parse(text);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.cases.map(c => c.title), ['Verify Get Customer Profile Successfully', 'Validate Profile Without Token', 'Verify Profile Cache Header']);
  assert.deepEqual(r.cases[1].steps, ['Send a GET request to `/customers/v2/profile` without a token.']);
  assert.deepEqual(r.cases[2].preconditions, []);
  assert.equal(r.cases.some(c => [c.title, ...c.steps, ...c.expected].join('').includes('\r')), false, 'CRLF dinormalisasi');
}

// Toleransi heading: Title: tanpa bold, **Title**:, Test Steps tanpa (s), Expected Results, isi sebaris.
{
  const r = parse(`Title: Verify Order Total
Preconditions: Cart has 2 items.
Test Steps:
1. Open the checkout page.
Expected Results:
1. Total equals the sum of both items.
---
**Title**: Validate Empty Cart
**Test Step(s)**:
- Open the checkout page with an empty cart.
**Expected Result(s)**:
- Checkout button is disabled.
---
**Title: Verify Bold Wrapped**
**Test Step(s):** Open the page.
**Expected Result:** Page opens.`);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.cases.map(c => c.title), ['Verify Order Total', 'Validate Empty Cart', 'Verify Bold Wrapped']);
  assert.deepEqual([r.cases[2].steps, r.cases[2].expected], [['Open the page.'], ['Page opens.']]);
  assert.deepEqual(r.cases[0].preconditions, ['Cart has 2 items.']);
  assert.deepEqual(r.cases[1].steps, ['Open the checkout page with an empty cart.']);
  assert.deepEqual(r.cases[1].expected, ['Checkout button is disabled.']);
}

// Baris lanjutan, sub-bullet, dan blok kode tetap menempel ke step-nya; heading
// dekorasi (### / baris bold penuh) tidak bocor ke expected case sebelumnya;
// bagian tak dikenal dicatat sebagai ignored.
{
  const r = parse(`Here are the test cases:

### Test Case 1
**Title:** Verify Create Order
**Precondition:**
- Customer is logged in.
**Test Step(s):**
1. Send a POST request to \`/orders\` with body:
   \`\`\`json
   {"items": [{"sku": "A-1", "qty": 1}]}

   ---
   \`\`\`
   - header \`X-Channel: app\`
**Expected Result:**
1. API returns HTTP status code \`201 Created\`.
2. Response contains the new order id.
**Priority:** High

**Test Case 2: Negative**
**Title:** Validate Order Without Items
**Test Step(s):**
1. Send a POST request to \`/orders\` with an empty items array.
**Expected Result:**
1. API returns HTTP status code \`400 Bad Request\`.`);
  assert.deepEqual(r.errors, []);
  assert.equal(r.cases.length, 2);
  assert.equal(r.cases[0].steps.length, 1, 'kode + sub-bullet = lanjutan step 1, bukan step baru');
  assert.match(r.cases[0].steps[0], /^Send a POST request to `\/orders` with body:\n/);
  assert.match(r.cases[0].steps[0], /"sku": "A-1"/);
  assert.match(r.cases[0].steps[0], /---/, '--- di dalam blok kode bukan pemisah case');
  assert.match(r.cases[0].steps[0], /- header `X-Channel: app`$/);
  assert.deepEqual(r.cases[0].expected, ['API returns HTTP status code `201 Created`.', 'Response contains the new order id.']);
  assert.deepEqual(r.cases[0].ignored, ['Priority']);
  assert.deepEqual(r.cases[1].ignored, []);
  assert.equal(r.cases[1].title, 'Validate Order Without Items');
  const v = validate(r.cases);
  assert.ok(v.cases[0].warnings.some(w => w.includes('Priority')), 'bagian yang diabaikan diberi tahu');
}

// JSON catet.testcases.v1 (juga dibungkus ```json dari AI).
{
  const doc = {
    format: 'catet.testcases.v1',
    cases: [{
      title: 'Verify Get Customer Profile Successfully',
      preconditions: ['Customer has a valid access token.'],
      steps: ['Send a GET request to `/customers/v2/profile` using a valid access token.'],
      expected: ['API returns HTTP status code `200 OK`.', 'Response contains the correct customer profile data according to the database.'],
    }],
  };
  const bare = parse(JSON.stringify(doc, null, 2));
  assert.equal(bare.source, 'json');
  assert.deepEqual(bare.errors, []);
  assert.deepEqual(bare.cases, parse(one).cases, 'JSON dan markdown menghasilkan bentuk internal yang sama');
  const fenced = parse('```json\n' + JSON.stringify(doc) + '\n```');
  assert.deepEqual(fenced.cases, bare.cases);
  const noFormat = parse(JSON.stringify({ cases: [{ title: 'Verify X', steps: 'Open X.', expected: 'X opens.', priority: 'High' }] }));
  assert.deepEqual(noFormat.errors, []);
  assert.deepEqual(noFormat.cases[0], { title: 'Verify X', preconditions: [], steps: ['Open X.'], expected: ['X opens.'], ignored: ['priority'] });
}

// Input rusak: kosong, teks bebas, JSON patah, bentuk/format salah, tipe field salah.
{
  assert.equal(parse('').cases.length, 0);
  assert.equal(parse('   \n ').errors.length, 1);
  const free = parse('Tolong buatkan test case untuk tiket ini ya.');
  assert.equal(free.cases.length, 0);
  assert.match(free.errors[0], /Tidak ada test case/);
  const broken = parse('{"format": "catet.testcases.v1", "cases": [');
  assert.equal(broken.source, 'json');
  assert.equal(broken.cases.length, 0);
  assert.match(broken.errors[0], /JSON tidak valid/);
  assert.match(parse('[{"title": "Verify X"}]').errors[0], /cases/);
  assert.match(parse('{"format": "other.v2", "cases": []}').errors[0], /other\.v2/);
  const badField = parse(JSON.stringify({ cases: [{ title: 'Verify X', steps: [1, 2], expected: ['ok'] }, 'oops'] }));
  assert.equal(badField.cases.length, 2, 'nomor case tetap sejajar dengan input');
  assert.deepEqual(badField.cases[0].steps, []);
  assert.ok(badField.errors.some(e => /Case #1/.test(e) && /steps/.test(e)));
  assert.ok(badField.errors.some(e => /Case #2/.test(e)));
  const v = validate(badField.cases);
  assert.equal(v.ok, false);
  assert.ok(v.cases[0].errors.some(e => /Test Step/.test(e)));
  // Section tanpa Title tetap jadi case (supaya error-nya terlihat), bukan dibuang diam-diam.
  const noTitle = parse('**Test Step(s):**\n1. Open X.\n**Expected Result:**\n1. X opens.');
  assert.equal(noTitle.cases.length, 1);
  assert.ok(validate(noTitle.cases).cases[0].errors.some(e => /Title kosong/.test(e)));
}

// Aturan error per case.
{
  const base = { preconditions: ['P.'], steps: ['Open X.'], expected: ['X opens.'], ignored: [] };
  const v = validate([
    { ...base, title: '' },
    { ...base, title: 'Verify ' + 'x'.repeat(249) }, // 256 karakter
    { ...base, title: 'Verify ' + 'x'.repeat(248) }, // 255 karakter: boleh
    { ...base, title: 'Verify No Step', steps: [] },
    { ...base, title: 'Verify No Expected', expected: [] },
    { ...base, title: 'GAP: Error message for expired OTP is not specified' },
  ]);
  assert.equal(v.ok, false);
  assert.ok(v.cases[0].errors.some(e => /Title kosong/.test(e)));
  assert.ok(v.cases[1].errors.some(e => /255/.test(e)));
  assert.deepEqual(v.cases[2].errors, []);
  assert.ok(v.cases[3].errors.some(e => /Test Step/.test(e)));
  assert.ok(v.cases[4].errors.some(e => /Expected Result/.test(e)));
  assert.ok(v.cases[5].errors.some(e => /GAP/.test(e)));
}

// Judul duplikat di batch: case-insensitive + spasi dinormalisasi; semua kemunculan ditandai.
{
  const base = { preconditions: ['P.'], steps: ['Open X.'], expected: ['X opens.'], ignored: [] };
  const v = validate([
    { ...base, title: 'Verify Login Success' },
    { ...base, title: 'Verify Logout' },
    { ...base, title: '  verify   LOGIN success ' },
  ]);
  assert.equal(v.ok, false);
  assert.ok(v.cases[0].errors.some(e => /duplikat/i.test(e)));
  assert.deepEqual(v.cases[1].errors, []);
  assert.ok(v.cases[2].errors.some(e => /duplikat/i.test(e)));
  assert.equal(validate([{ ...base, title: 'Verify Login Success' }]).ok, true, 'tanpa kembaran → lolos');
}

// Batas batch: 20 lolos, 21 ditolak di level batch; 0 case juga tidak siap.
{
  const make = n => Array.from({ length: n }, (_, i) => ({ title: 'Verify Case ' + (i + 1), preconditions: ['P.'], steps: ['Open X.'], expected: ['X opens.'], ignored: [] }));
  assert.equal(validate(make(20)).ok, true);
  const over = validate(make(21));
  assert.equal(over.ok, false);
  assert.match(over.errors.join(' '), /21/);
  assert.match(over.errors.join(' '), /20/);
  assert.ok(over.cases.every(c => c.errors.length === 0), 'batas batch bukan error per case');
  const empty = validate([]);
  assert.equal(empty.ok, false);
  assert.equal(empty.errors.length, 1);
  const markdown21 = make(21).map(c => `**Title:** ${c.title}\n**Test Step(s):**\n1. Open X.\n**Expected Result:**\n1. X opens.`).join('\n---\n');
  assert.equal(parse(markdown21).cases.length, 21, 'parser tidak memotong diam-diam; validator yang menolak');
}

// Warning (boleh lanjut): kata validasi di step, judul bukan Verify/Validate,
// precondition kosong, >3 step, >3 expected.
{
  const v = validate([
    { title: 'Verify Search', preconditions: ['P.'], steps: ['Open search and verify the result list.'], expected: ['Results shown.'], ignored: [] },
    { title: 'Check Search Filter', preconditions: [], steps: ['Open search.', 'Pilih filter lalu pastikan chip muncul.', 'Apply.', 'Scroll.'], expected: ['A.', 'B.', 'C.', 'D.'], ignored: [] },
    { title: 'Verify Checkout Page', preconditions: ['P.'], steps: ['Open the checkout page.'], expected: ['Page opens.'], ignored: [] },
  ]);
  assert.equal(v.ok, true, 'warning tidak memblokir');
  assert.deepEqual(v.cases.map(c => c.errors.length), [0, 0, 0]);
  assert.ok(v.cases[0].warnings.some(w => /Step 1/.test(w) && /verify/.test(w)));
  const w1 = v.cases[1].warnings.join('\n');
  assert.match(w1, /Verify\/Validate/);
  assert.match(w1, /Precondition kosong/);
  assert.match(w1, /Step 2.*pastikan/);
  assert.match(w1, /4 step/);
  assert.match(w1, /4 expected/);
  assert.deepEqual(v.cases[2].warnings, [], '"checkout" bukan kata validasi');
}

// Draft per task di localStorage catet.testcaseDrafts.v1 (tidak ikut /state).
{
  const store = new Map();
  const d = load(store);
  d.context.tasks = [{ id: 't1' }, { id: 't2' }];
  d.run('simpanDraftTestCase')('t1', 'draft satu');
  d.run('simpanDraftTestCase')('t2', 'draft dua');
  assert.equal(d.run('bacaDraftTestCase')('t1'), 'draft satu');
  assert.equal(JSON.parse(store.get('catet.testcaseDrafts.v1')).t2.text, 'draft dua');
  d.run('simpanDraftTestCase')('t2', '   ');
  assert.equal(d.run('bacaDraftTestCase')('t2'), '', 'draft kosong dihapus');
  d.context.tasks = [{ id: 't3' }];
  d.run('simpanDraftTestCase')('t3', 'draft tiga');
  assert.deepEqual(Object.keys(JSON.parse(store.get('catet.testcaseDrafts.v1'))), ['t3'], 'draft task yang sudah tidak ada dibersihkan');
  store.set('catet.testcaseDrafts.v1', '{rusak');
  assert.equal(d.run('bacaDraftTestCase')('t3'), '', 'storage rusak tidak melempar');
}

// Terdaftar di index.html (setelah jira.js, sebelum board.js) dan di ASSETS sw.js.
{
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const at = name => html.indexOf('<script src="assets/js/' + name + '"></script>');
  assert.ok(at('testcases.js') > at('jira.js') && at('jira.js') > 0, 'testcases.js dimuat setelah jira.js');
  assert.ok(at('testcases.js') < at('board.js'), 'testcases.js dimuat sebelum board.js');
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.match(sw, /"assets\/js\/testcases\.js"/);
}

console.log('PASS testcase parser/validator: markdown, multi case, JSON, rusak, error/warning, batas 20, draft, registrasi aset');
