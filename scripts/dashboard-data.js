#!/usr/bin/env node
// Builds the dashboard's data files from data/ (history, current cars, stock changes).
// Usage: node scripts/dashboard-data.js <out-dir>
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const out = process.argv[2] || path.join(ROOT, 'debug', 'dashboard');
fs.mkdirSync(out, { recursive: true });

const MODEL = { coupe: 'Coupe', suv: 'SUV' };
const NB_MONTHS = ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember'];

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

function period(label, date) {
  if (!date) return 'Unknown';
  const [y, m] = date.split('-').map(Number);
  const l = (label || NB_MONTHS[m - 1]).trim();
  return `${l.charAt(0).toUpperCase()}${l.slice(1)} ${y}`;
}

const osloTime = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const shortDate = (d) => (d ? new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(new Date(d)) : '');
const CHANGE = { added: 'New in stock', removed: 'Gone', delivery_changed: 'Delivery moved' };

const read = (f) => fs.readFileSync(path.join(ROOT, 'data', f), 'utf8');
const latest = JSON.parse(read('latest.json'));

const history = parseCsv(read('history.csv')).map((r) => ({
  checked_at: r.timestamp,
  checked_label: osloTime(r.timestamp),
  model: MODEL[r.model] || r.model,
  total: Number(r.total),
  by_deadline: Number(r.before_deadline),
  after_deadline: Number(r.after_deadline),
}));

const cars = [];
for (const [k, m] of Object.entries(latest.models)) {
  for (const c of m.cars) {
    const f = c.features || {};
    cars.push({
      car_id: c.id,
      model: MODEL[k] || k,
      version: c.version,
      engine: f.Engine || '',
      colour: f.Color || '',
      wheels: (f.Rims || '').replace(/''/g, '"'),
      pack: (f.Bundle || '').replace(/[-\s]*(pakken|pakke|pack)\b.*$/i, '').trim(),
      performance: /performance/i.test(f.Packages || ''),
      delivery_period: period(c.delivery_label, c.estimated_delivery),
      estimated_delivery: c.estimated_delivery,
      by_deadline: c.before_deadline === true,
    });
  }
}

let changes = [];
if (fs.existsSync(path.join(ROOT, 'data', 'changes.csv'))) {
  changes = parseCsv(read('changes.csv')).map((r, i) => ({
    event_id: `${r.timestamp}|${r.model}|${r.event}|${r.car_id}`,
    checked_at: r.timestamp,
    model: MODEL[r.model] || r.model,
    event: r.event,
    version: r.version,
    delivery_label: r.delivery_label,
    delivery_from: r.delivery_from,
    delivery_to: r.delivery_to,
    when: osloTime(r.timestamp),
    change: CHANGE[r.event] || r.event,
    delivery: r.event === 'delivery_changed'
      ? `${shortDate(r.delivery_from)} → ${shortDate(r.delivery_to)}`
      : `${period(r.delivery_label, r.delivery_to || r.delivery_from)} (${shortDate(r.delivery_to || r.delivery_from)})`,
  }));
}

const write = (name, rows) => fs.writeFileSync(path.join(out, name), JSON.stringify(rows));
write('history.json', history);
write('cars.json', cars);
write('changes.json', changes);
console.log(JSON.stringify({ out, checked_at: latest.checked_at, deadline: latest.deadline, history: history.length, cars: cars.length, changes: changes.length }));
