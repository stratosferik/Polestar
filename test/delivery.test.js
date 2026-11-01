const test = require('node:test');
const assert = require('node:assert');
const { parseDelivery, resolveDeadline } = require('../src/delivery');

const NOW = new Date('2026-11-01T08:00:00Z');
const d = (text) => {
  const r = parseDelivery(text, NOW);
  return r && r.date.toISOString().slice(0, 10);
};

test('immediate delivery', () => {
  assert.equal(d('Klar for levering'), '2026-11-01');
  assert.equal(d('Umiddelbar levering'), '2026-11-01');
  assert.equal(d('Ready for delivery'), '2026-11-01');
});

test('full dates', () => {
  assert.equal(d('Estimert levering: 15.12.2026'), '2026-12-15');
  assert.equal(d('2026-12-20T00:00:00Z'), '2026-12-20');
  assert.equal(d('Levering 3. januar 2027'), '2027-01-03');
  assert.equal(d('December 5, 2026'), '2026-12-05');
  assert.equal(d('Levering 01.12.2026 - 20.12.2026'), '2026-12-20');
});

test('month estimates use end of month', () => {
  assert.equal(d('Estimert levering desember 2026'), '2026-12-31');
  assert.equal(d('Levering: nov – des 2026'), '2026-12-31');
  assert.equal(d('Levering januar 2027'), '2027-01-31');
  assert.equal(d('Levering i februar'), '2027-02-28');
  assert.equal(d('2026-12'), '2026-12-31');
});

test('weeks, quarters, relative', () => {
  assert.equal(d('Levering uke 51'), '2026-12-20');
  assert.equal(d('Q4 2026'), '2026-12-31');
  assert.equal(d('Levering innen 2 uker'), '2026-11-15');
  assert.equal(d('Leveringstid 4-6 uker'), '2026-12-13');
  assert.equal(d('Leveres om 10 dager'), '2026-11-11');
});

test('numbers and unknown text', () => {
  assert.equal(d(1797724800000), '2026-12-20');
  assert.equal(d('Kontakt oss for leveringstid'), null);
  assert.equal(d(''), null);
  assert.equal(d(true), null);
});

test('deadline', () => {
  assert.equal(resolveDeadline(undefined, NOW).toISOString().slice(0, 10), '2026-12-31');
  assert.equal(resolveDeadline('2026-12-24').toISOString().slice(0, 10), '2026-12-24');
  assert.throws(() => resolveDeadline('24.12.2026'));
});

test('texts seen on polestar.com/no', () => {
  assert.equal(d('Tilgjengelig nå på utvalgte lokasjoner'), '2026-11-01');
  assert.equal(d('Tilgjengelig kun hos Polestar Tønsberg'), '2026-11-01');
  assert.equal(d('Tilgjengelig fra Slutten av desember hos alle lokasjoner'), '2026-12-31');
  assert.equal(d('Tilgjengelig fra tidlig januar hos alle lokasjoner'), '2027-01-31');
});
