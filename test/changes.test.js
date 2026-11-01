const test = require('node:test');
const assert = require('node:assert');
const { diffCars } = require('../src/monitor');

const car = (id, d) => ({ id, estimated_delivery: d });

test('a car counts as gone only after two checks without it', () => {
  const first = diffCars([car('a', '2026-12-01'), car('b', '2026-12-01')], [car('a', '2026-12-01')]);
  assert.deepEqual(first.events, []);
  assert.deepEqual(first.pending.map((c) => c.id), ['b']);

  const second = diffCars([car('a', '2026-12-01')], [car('a', '2026-12-01')], first.pending);
  assert.deepEqual(second.events.map((e) => `${e.event}:${e.car.id}`), ['removed:b']);
});

test('a car that comes back is not logged', () => {
  const r = diffCars([car('a', '2026-12-01')], [car('a', '2026-12-01'), car('b', '2026-12-01')], [car('b', '2026-12-01')]);
  assert.deepEqual(r.events, []);
});

test('new cars and moved delivery dates are logged', () => {
  const r = diffCars([car('a', '2026-12-01')], [car('a', '2026-12-20'), car('c', '2027-01-05')]);
  assert.deepEqual(r.events.map((e) => `${e.event}:${e.car.id}:${e.from}>${e.to}`), ['delivery_changed:a:2026-12-01>2026-12-20', 'added:c:>2027-01-05']);
});
