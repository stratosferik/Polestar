// Runs the full monitor against local mock pages (no network needed).
// Skipped automatically if Playwright's browser is not installed.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const cars = Array.from({ length: 14 }, (_, i) => ({
  vin: `LPSVSEDEEML${String(i).padStart(6, '0')}`,
  model: 'Polestar 4',
  price: 600000 + i * 1000,
  deliveryInfo: { estimatedDeliveryDate: i < 9 ? '2026-12-1' + (i % 9) : '2027-02-01' },
  content: [{ featureType: 'Color', name: 'Snow' }, { featureType: 'Packages', name: i === 0 ? 'Komfort, Plus, Performance' : 'Komfort, Plus' }, { featureType: 'ModelYear', name: i === 2 ? '2026' : '2027' }, { featureType: 'Engine', name: i % 2 ? 'Dual motor' : 'Single motor' }],
  bundles: [{ name: 'Prime-pakken' }],
}));

const jsonPage = `<!doctype html><html><body>
<div role="dialog"><button>Godta alle</button></div>
<main><ul id="list"></ul><button id="more">Vis flere</button></main>
<script>
document.querySelector('[role=dialog] button').onclick = e => e.target.parentElement.remove();
let page = 0;
async function load() {
  const r = await fetch('/api/cars?page=' + page++);
  const { items, hasMore } = await r.json();
  for (const c of items) {
    const li = document.createElement('li');
    li.innerText = 'Polestar 4\\n' + c.price + ' kr\\nEstimert levering\\n' + c.deliveryInfo.estimatedDeliveryDate;
    document.getElementById('list').appendChild(li);
  }
  if (!hasMore) document.getElementById('more').remove();
}
document.getElementById('more').onclick = load;
load();
</script></body></html>`;

const card = (n, delivery) => `<div class="x"><a href="/no/stock-cars/p4/${n}"><h3>Polestar 4 Long range</h3></a>
<p>659 900 kr</p><dl><dt>Levering</dt><dd>${delivery}</dd></dl></div>`;
const htmlPage = `<!doctype html><html><body><aside><h4>Leveringstid</h4><label>Alle</label></aside><main><div class="grid">
${card(1, 'Klar for levering')}${card(2, 'Desember 2026')}${card(3, 'Uke 49')}
${card(4, 'Januar 2027')}${card(5, 'Kontakt forhandler')}
</div></main><footer>Levering i hele Norge</footer></body></html>`;

function canLaunch() {
  try {
    execFileSync(process.execPath, ['-e', "require('playwright').chromium.launch().then(b=>b.close())"], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

test('monitor counts cars from JSON and from page text', { skip: !canLaunch() && 'no browser' }, async () => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/cars') {
      const p = +u.searchParams.get('page');
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ items: cars.slice(p * 6, p * 6 + 6), hasMore: p * 6 + 6 < cars.length }));
    }
    res.setHeader('content-type', 'text/html');
    res.end(u.pathname.startsWith('/coupe') ? jsonPage : htmlPage);
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-'));
  try {
    await new Promise((resolve, reject) => {
      require('child_process').execFile(process.execPath, [path.join(__dirname, '../src/monitor.js')], {
        env: { ...process.env, URL_COUPE: `${base}/coupe`, URL_SUV: `${base}/suv`, DATA_DIR: dir, DEBUG_DIR: path.join(dir, 'debug'), DEADLINE: '2026-12-31' },
      }, (err, stdout, stderr) => (err ? reject(new Error(stderr || stdout)) : resolve(stdout)));
    });
    const latest = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'));
    const { coupe, suv } = latest.models;
    assert.equal(coupe.source, 'json');
    assert.deepEqual([coupe.total, coupe.before_deadline, coupe.after_deadline, coupe.unknown], [14, 9, 5, 0]);
    assert.deepEqual(coupe.by_delivery.map((g) => [g.period, g.count, g.before_deadline]), [['Desember 2026', 9, true], ['Februar 2027', 5, false]]);
    assert.deepEqual(coupe.by_delivery[0].versions, { 'Single motor Performance': 1, 'Dual motor': 4, 'Single motor (2026)': 1, 'Single motor': 3 });
    assert.ok(fs.readFileSync(path.join(dir, 'SUMMARY.md'), 'utf8').includes('Desember 2026'));
    assert.equal(suv.source, 'page');
    // "Uke 49" is relative to today, so only check the fixed ones.
    assert.equal(suv.total, 5);
    assert.equal(suv.unknown, 1);
    assert.ok(suv.cars.find((c) => c.delivery_raw.includes('Januar')).before_deadline === false);
    assert.equal(fs.readFileSync(path.join(dir, 'history.csv'), 'utf8').trim().split('\n').length, 3);
  } finally {
    server.close();
  }
});
