#!/usr/bin/env node
// Loads the Polestar Norway stock-car pages, finds every listed car and its
// delivery estimate, and counts how many are due on or before the deadline.
//
// Two ways of finding cars, best one wins:
//   1. JSON the page downloads (most reliable: has the structured data).
//   2. The rendered page text, split into car cards (fallback).
//
// Env vars:
//   DEADLINE=YYYY-MM-DD   default: 31 Dec this year
//   MODELS=coupe,suv      which models to check
//   DATA_DIR / DEBUG_DIR  where results and debug dumps go
//   HEADFUL=1             show the browser

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { parseDelivery, resolveDeadline } = require('./delivery');

const ALL_MODELS = {
  coupe: { name: 'Polestar 4 Coupe', url: 'https://www.polestar.com/no/stock-cars/polestar-4-coupe/' },
  suv: { name: 'Polestar 4 SUV', url: 'https://www.polestar.com/no/stock-cars/polestar-4-suv/' },
};

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DEBUG_DIR = process.env.DEBUG_DIR || path.join(ROOT, 'debug');
const HISTORY_CSV = path.join(DATA_DIR, 'history.csv');
const LATEST_JSON = path.join(DATA_DIR, 'latest.json');
const CHANGE_MD = path.join(DEBUG_DIR, 'change.md');
const CHANGES_CSV = path.join(DATA_DIR, 'changes.csv');

const DELIVERY_KEY_RE = /deliver|leveranse|levering|eta\b|^eta|arrival|availab|readyDate|ready_date/i;
const ID_KEYS = ['vin', 'VIN', 'id', 'stockId', 'stockCarId', 'carId', 'orderId', 'orderNumber', 'registrationNumber', 'uuid', 'key'];
const DELIVERY_LINE_RE = /(levering|leveranse|leveres|leveringstid|levert|delivery|deliver|klar for|på lager|tilgjengelig)/i;

// ---------- JSON extraction ----------

function deepEntries(obj, depth = 3, prefix = '') {
  const out = [];
  if (!obj || typeof obj !== 'object' || depth < 0) return out;
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    out.push([p, k, v]);
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...deepEntries(v, depth - 1, p));
  }
  return out;
}

function deliveryValues(car) {
  return deepEntries(car)
    .filter(([, k, v]) => DELIVERY_KEY_RE.test(k) && v != null && typeof v !== 'boolean' && typeof v !== 'object')
    .map(([p, , v]) => ({ field: p, value: v }));
}

function carId(car) {
  for (const [, k, v] of deepEntries(car, 2)) {
    if (ID_KEYS.includes(k) && (typeof v === 'string' || typeof v === 'number') && String(v).length >= 3) return String(v);
  }
  return null;
}

// Find arrays of objects where most items carry a delivery-like field.
function findCarArrays(node, found = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return found;
  if (Array.isArray(node)) {
    const objs = node.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (objs.length && objs.length >= node.length * 0.8) {
      const withDelivery = objs.filter((o) => deliveryValues(o).length > 0).length;
      if (withDelivery >= Math.max(1, objs.length * 0.5)) {
        found.push(objs);
        return found;
      }
    }
    node.forEach((x) => findCarArrays(x, found, depth + 1));
  } else {
    Object.values(node).forEach((x) => findCarArrays(x, found, depth + 1));
  }
  return found;
}

function bestDelivery(values, now) {
  const parsed = values.map((v) => parseDelivery(v.value, now)).filter(Boolean);
  // An exact date beats a label like "tidlig desember".
  return parsed.find((p) => p.kind === 'date') || parsed[0] || null;
}

// Polestar lists each car's options as content: [{featureType, name}],
// and packs as bundles: [{name}].
function carFeatures(car) {
  const types = {};
  for (const f of Array.isArray(car.content) ? car.content : []) {
    if (f && f.featureType && f.name) types[f.featureType] = types[f.featureType] ? `${types[f.featureType]}, ${f.name}` : f.name;
  }
  const packs = (Array.isArray(car.bundles) ? car.bundles : []).map((b) => b && b.name).filter(Boolean);
  return { types, packs, label: typeof car.earliestDeliveryDateLabel === 'string' ? car.earliestDeliveryDateLabel.trim() : null };
}

// Version as you'd describe it from the page:
// motor · colour · wheels · Prime/Business · Performance,
// e.g. "Dual motor · Space · 21\" Pro · Prime · Performance".
function carVersion(features) {
  if (!features) return 'Unknown version';
  const t = features.types;
  const engine = t.Engine || Object.entries(t).find(([k]) => /motor|engine|powertrain/i.test(k))?.[1];
  const colour = t.Color || t.Colour;
  const rims = t.Rims && t.Rims.replace(/''|”|″/g, '"');
  // "Prime-pakken 2026" / "Prime pack" → "Prime"
  const bundle = (t.Bundle || features.packs[0] || '').replace(/[-\s]*(pakken|pakke|pack)\b.*$/i, '').trim();
  const hasPerf = [t.Packages, ...features.packs].some((x) => /performance/i.test(x || ''));
  const parts = [engine, colour, rims, bundle, hasPerf && 'Performance'].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Unknown version';
}

// Add the model year only to cars that differ from the usual one (e.g. a leftover 2026 car).
function markOddModelYears(cars) {
  const years = {};
  cars.forEach((c) => c.model_year && (years[c.model_year] = (years[c.model_year] || 0) + 1));
  const usual = Object.entries(years).sort((a, b) => b[1] - a[1])[0]?.[0];
  for (const c of cars) if (c.model_year && c.model_year !== usual) c.version += ` (${c.model_year})`;
  return cars;
}

function carsFromJson(bodies, now) {
  const cars = new Map();
  for (const { url, body } of bodies) {
    if (url.includes('ld+json')) continue; // schema.org copy of the same cars
    for (const arr of findCarArrays(body)) {
      const items = arr.map((car) => {
        const values = deliveryValues(car);
        return {
          id: carId(car),
          delivery_raw: values.map((v) => `${v.field}=${v.value}`).join('; '),
          parsed: bestDelivery(values, now),
          source_url: url,
          features: carFeatures(car),
        };
      });
      // Real car lists have ids and readable dates; page text/translations don't.
      const good = items.filter((c) => c.id && c.parsed).length;
      if (good < Math.max(1, items.length * 0.5)) continue;
      for (const c of items) if (c.id && !cars.has(c.id)) cars.set(c.id, c);
    }
  }
  return [...cars.values()];
}

// ---------- DOM extraction ----------

// Car cards show a price; this also tells a car card apart from filter panels.
const PRICE_RE_SRC = String.raw`\d[\d\s\u00a0.]{2,}\s?(kr|nok|,-)|(kr|nok)\s?\d`;

async function cardsFromDom(page) {
  return page.evaluate(({ lineReSrc, priceReSrc }) => {
    const lineRe = new RegExp(lineReSrc, 'i');
    const priceRe = new RegExp(priceReSrc, 'gi');
    const text = (el) => el.innerText || '';
    const countLines = (el) => text(el).split('\n').filter((l) => lineRe.test(l)).length;
    const countPrices = (el) => (text(el).match(priceRe) || []).length;
    const skip = 'header, footer, nav, [role="dialog"], [id*="cookie" i], [class*="cookie" i], select, option, button, script, style';
    const cards = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const el = walker.currentNode.parentElement;
      if (!el || !lineRe.test(walker.currentNode.textContent || '') || el.closest(skip)) continue;
      if (!el.getClientRects().length) continue; // hidden
      // 1) Climb until the block shows a price: that's (part of) a car card.
      let card = el;
      while (card !== document.body && countPrices(card) === 0) card = card.parentElement;
      if (card === document.body || countPrices(card) > 3) continue;
      // 2) Keep climbing while the parent adds no other car's content.
      let lines = countLines(card);
      let prices = countPrices(card);
      while (card.parentElement && card.parentElement !== document.body) {
        const p = card.parentElement;
        if (countLines(p) !== lines || countPrices(p) !== prices) break;
        card = p;
      }
      cards.add(card);
    }
    return [...cards].map((card) => {
      const link = card.matches('a[href]') ? card : card.querySelector('a[href]') || card.closest('a[href]');
      return { href: link ? link.href : null, text: text(card).slice(0, 3000) };
    });
  }, { lineReSrc: DELIVERY_LINE_RE.source, priceReSrc: PRICE_RE_SRC });
}

function carsFromDom(cards, now) {
  const seen = new Set();
  cards = cards.filter((c) => {
    const k = c.href || c.text;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return cards.map((c) => {
    const lines = c.text.split('\n').map((l) => l.trim()).filter(Boolean);
    const idxs = lines.map((l, i) => (DELIVERY_LINE_RE.test(l) ? i : -1)).filter((i) => i >= 0);
    // The date is often on the line after the "Levering" label.
    let parsed = null;
    let idx = idxs[0] ?? -1;
    for (const i of idxs) {
      for (const cand of [lines[i], `${lines[i]} ${lines[i + 1] || ''}`]) {
        parsed = parseDelivery(cand, now);
        if (parsed) break;
      }
      if (parsed) { idx = i; break; }
    }
    return {
      id: c.href || lines.slice(0, 3).join(' | '),
      title: lines.slice(0, 2).join(' '),
      delivery_raw: idx >= 0 ? lines.slice(idx, idx + 2).join(' ') : '',
      parsed,
    };
  });
}

// ---------- page interaction ----------

async function clickFirst(page, re, timeout = 1500) {
  const candidates = [
    page.getByRole('button', { name: re }),
    page.getByRole('link', { name: re }),
    page.locator('button, a, [role="button"]').filter({ hasText: re }),
  ];
  for (const c of candidates) {
    const loc = c.first();
    try {
      await loc.waitFor({ state: 'visible', timeout });
      await loc.scrollIntoViewIfNeeded({ timeout });
      await loc.click({ timeout });
      return true;
    } catch {}
  }
  return false;
}

const LOAD_MORE_RE = /vis flere|last inn flere|se flere|vis mer|flere biler|show more|load more/i;

// Number of car links on the page: grows as more cars are loaded.
const carLinkCount = (page) =>
  page.evaluate(() => new Set([...document.querySelectorAll('a[href*="/stock-cars/"]')].map((a) => a.href.split('?')[0])).size);

async function loadAll(page) {
  await clickFirst(page, /godta alle|aksepter alle|accept all|tillat alle|godta|aksepter|accept/i, 8000);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  let count = await carLinkCount(page);
  let stale = 0;
  // Stop after 3 rounds in a row where neither clicking nor scrolling adds cars.
  for (let i = 0; i < 80 && stale < 3; i++) {
    await page.mouse.wheel(0, 20000);
    await page.waitForTimeout(1000);
    await clickFirst(page, LOAD_MORE_RE, 2000);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const now = await carLinkCount(page);
    stale = now > count ? 0 : stale + 1;
    count = now;
  }
  return count;
}

async function scrapeModel(browser, key, model, now) {
  const context = await browser.newContext({
    locale: 'nb-NO',
    timezoneId: 'Europe/Oslo',
    viewport: { width: 1366, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  const bodies = [];
  page.on('response', async (res) => {
    try {
      const ct = res.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      bodies.push({ url: res.url(), body: await res.json() });
    } catch {}
  });

  await page.goto(model.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  // Data embedded in the HTML (e.g. Next.js) counts as JSON too.
  for (const sel of ['script#__NEXT_DATA__', 'script[type="application/json"]', 'script[type="application/ld+json"]']) {
    for (const txt of await page.$$eval(sel, (els) => els.map((e) => e.textContent)).catch(() => [])) {
      try { bodies.push({ url: `${model.url}#${sel}`, body: JSON.parse(txt) }); } catch {}
    }
  }

  const linkCount = await loadAll(page);
  console.log(`  car links on page after loading: ${linkCount}`);

  const jsonCars = carsFromJson(bodies, now);
  const domCardsRaw = await cardsFromDom(page);
  const domCars = carsFromDom(domCardsRaw, now);

  const dbg = path.join(DEBUG_DIR, key);
  fs.mkdirSync(dbg, { recursive: true });
  fs.writeFileSync(path.join(dbg, 'page.html'), await page.content());
  await page.screenshot({ path: path.join(dbg, 'page.png'), fullPage: true }).catch(() => {});
  fs.writeFileSync(
    path.join(dbg, 'json-responses.json'),
    JSON.stringify(bodies.map((b) => ({ url: b.url, body: b.body })), null, 1).slice(0, 20_000_000),
  );
  fs.writeFileSync(path.join(dbg, 'cars.json'), JSON.stringify({ jsonCars, domCars }, null, 2));

  await context.close();

  const parsedCount = (cars) => cars.filter((c) => c.parsed).length;
  const useJson = parsedCount(jsonCars) > 0;
  if (useJson && domCars.length && domCars.length !== jsonCars.length) {
    console.warn(`  note: page shows ${domCars.length} cars, data has ${jsonCars.length}`);
  }
  return { source: useJson ? 'json' : domCars.length ? 'page' : 'none', cars: useJson ? jsonCars : domCars, jsonCount: jsonCars.length, domCount: domCars.length };
}

// ---------- reporting ----------

function summarise(cars, deadline) {
  const before = cars.filter((c) => c.parsed && c.parsed.date <= deadline);
  const after = cars.filter((c) => c.parsed && c.parsed.date > deadline);
  const unknown = cars.filter((c) => !c.parsed);
  return { total: cars.length, before_deadline: before.length, after_deadline: after.length, unknown: unknown.length };
}

const NB_MONTHS = ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember'];

// Groups cars by delivery period ("Tidlig desember 2026"), earliest first,
// with a count per version inside each group.
function breakdown(cars) {
  const groups = new Map();
  for (const c of cars) {
    let period = 'Unknown delivery';
    if (c.estimated_delivery) {
      const [y, m] = c.estimated_delivery.split('-').map(Number);
      const label = c.delivery_label || NB_MONTHS[m - 1];
      period = `${label.charAt(0).toUpperCase()}${label.slice(1)} ${y}`;
    }
    const g = groups.get(period) || { period, earliest: null, latest: null, count: 0, before_deadline: true, versions: {} };
    g.count++;
    g.versions[c.version] = (g.versions[c.version] || 0) + 1;
    if (c.estimated_delivery) {
      if (!g.earliest || c.estimated_delivery < g.earliest) g.earliest = c.estimated_delivery;
      if (!g.latest || c.estimated_delivery > g.latest) g.latest = c.estimated_delivery;
    }
    if (c.before_deadline !== true) g.before_deadline = false;
    groups.set(period, g);
  }
  return [...groups.values()].sort((a, b) => (a.earliest || '9999').localeCompare(b.earliest || '9999'));
}

// Compares this check with the previous one, car by car: cars that appeared,
// disappeared or moved delivery date. A car only counts as gone after it is
// missing from two checks in a row, since the site sometimes leaves one out.
function diffCars(prevCars, cars, pending = []) {
  const before = new Map((prevCars || []).map((c) => [c.id, c]));
  const waiting = new Map((pending || []).map((c) => [c.id, c]));
  const now = new Map(cars.map((c) => [c.id, c]));
  const events = [];
  for (const [id, c] of now) {
    const p = before.get(id) || waiting.get(id);
    if (!p) events.push({ event: 'added', car: c, from: '', to: c.estimated_delivery || '' });
    else if ((p.estimated_delivery || '') !== (c.estimated_delivery || '')) {
      events.push({ event: 'delivery_changed', car: c, from: p.estimated_delivery || '', to: c.estimated_delivery || '' });
    }
  }
  for (const [id, p] of waiting) if (!now.has(id)) events.push({ event: 'removed', car: p, from: p.estimated_delivery || '', to: '' });
  const stillPending = [...before.values()].filter((p) => !now.has(p.id));
  return { events, pending: stillPending };
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function logStockChanges(previous, results, stamp) {
  const rows = [];
  for (const [k, r] of Object.entries(results)) {
    const prev = previous && previous.models && previous.models[k];
    if (!prev || !Array.isArray(prev.cars)) continue;
    // A much smaller list than last time is more likely a partial page load than a sell-out.
    if (prev.cars.length >= 10 && r.cars.length < prev.cars.length * 0.7) {
      console.warn(`  ${r.name}: ${prev.cars.length} → ${r.cars.length} cars, too big a drop to trust; not logging changes`);
      continue;
    }
    const { events, pending } = diffCars(prev.cars, r.cars, prev.pending_removed);
    r.pending_removed = pending;
    for (const e of events) {
      rows.push([stamp, k, e.event, e.car.id, e.car.version || '', e.car.delivery_label || '', e.from, e.to]);
    }
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CHANGES_CSV)) fs.writeFileSync(CHANGES_CSV, 'timestamp,model,event,car_id,version,delivery_label,delivery_from,delivery_to\n');
  if (rows.length) fs.appendFileSync(CHANGES_CSV, rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n');
  console.log(`  stock changes since last check: ${rows.length}`);
  return rows;
}

function iso(d) {
  return d.toISOString().slice(0, 10);
}

function appendHistory(rows) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const header = 'timestamp,deadline,model,total,before_deadline,after_deadline,unknown_delivery,source\n';
  if (!fs.existsSync(HISTORY_CSV)) fs.writeFileSync(HISTORY_CSV, header);
  fs.appendFileSync(HISTORY_CSV, rows.map((r) => r.join(',')).join('\n') + '\n');
}

async function main() {
  const now = new Date();
  const deadline = resolveDeadline(process.env.DEADLINE, now);
  const keys = (process.env.MODELS || 'coupe,suv').split(',').map((s) => s.trim()).filter(Boolean);
  const models = Object.fromEntries(keys.map((k) => {
    if (!ALL_MODELS[k]) throw new Error(`Unknown model "${k}". Options: ${Object.keys(ALL_MODELS).join(', ')}`);
    return [k, { ...ALL_MODELS[k], url: process.env[`URL_${k.toUpperCase()}`] || ALL_MODELS[k].url }];
  }));

  const previous = fs.existsSync(LATEST_JSON) ? JSON.parse(fs.readFileSync(LATEST_JSON, 'utf8')) : null;
  fs.mkdirSync(DEBUG_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: !process.env.HEADFUL });
  const results = {};
  try {
    for (const [key, model] of Object.entries(models)) {
      console.log(`Checking ${model.name} …`);
      const r = await scrapeModel(browser, key, model, now);
      results[key] = {
        name: model.name,
        url: model.url,
        source: r.source,
        ...summarise(r.cars, deadline),
        cars: r.cars.map((c) => ({
          id: c.id,
          title: c.title,
          delivery_raw: c.delivery_raw,
          estimated_delivery: c.parsed ? iso(c.parsed.date) : null,
          estimate_kind: c.parsed ? c.parsed.kind : null,
          before_deadline: c.parsed ? c.parsed.date <= deadline : null,
          delivery_label: c.features ? c.features.label : null,
          version: carVersion(c.features),
          model_year: c.features ? c.features.types.ModelYear || null : null,
          packs: c.features ? c.features.packs : [],
          features: c.features ? c.features.types : {},
        })),
      };
      markOddModelYears(results[key].cars);
      results[key].by_delivery = breakdown(results[key].cars);
      console.log(`  found ${r.cars.length} cars (json: ${r.jsonCount}, page: ${r.domCount}, using ${r.source})`);
      if (r.cars[0]) console.log(`  sample: ${r.cars[0].id} | ${r.cars[0].delivery_raw}`.slice(0, 400));
      if (r.cars[0] && r.cars[0].features) {
        const f = r.cars[0].features;
        console.log(`  features: ${Object.entries(f.types).map(([t, n]) => `${t}=${n}`).join(' | ')} | packs=${f.packs.join(', ')}`.slice(0, 1500));
      }
    }
  } finally {
    await browser.close();
  }

  const stamp = now.toISOString();
  const stockEvents = logStockChanges(previous, results, stamp);
  const latest = { checked_at: stamp, deadline: iso(deadline), models: results };
  fs.writeFileSync(LATEST_JSON, JSON.stringify(latest, null, 2) + '\n');
  appendHistory(Object.entries(results).map(([k, r]) => [stamp, iso(deadline), k, r.total, r.before_deadline, r.after_deadline, r.unknown, r.source]));

  // Human-readable summary
  const lines = [
    `## Polestar 4 stock in Norway — deliverable by ${iso(deadline)}`,
    '',
    '| Model | Before deadline | After | Unknown | Total | Change |',
    '|---|---|---|---|---|---|',
  ];
  const changes = [];
  for (const [k, r] of Object.entries(results)) {
    const prev = previous && previous.models && previous.models[k];
    const delta = prev && prev.deadline === iso(deadline) ? r.before_deadline - prev.before_deadline : null;
    if (delta) changes.push(`${r.name}: ${prev.before_deadline} → **${r.before_deadline}** (${delta > 0 ? '+' : ''}${delta})`);
    lines.push(`| [${r.name}](${r.url}) | **${r.before_deadline}** | ${r.after_deadline} | ${r.unknown} | ${r.total} | ${delta == null ? '–' : (delta > 0 ? '+' : '') + delta} |`);
  }
  for (const r of Object.values(results)) {
    lines.push('', `### ${r.name}: by delivery`, '');
    for (const g of r.by_delivery) {
      const versions = Object.entries(g.versions).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const when = g.latest ? ` (by ${g.latest})` : '';
      const late = g.before_deadline ? '' : ' — after deadline';
      lines.push(`- **${g.period}**${when}: ${g.count} car${g.count === 1 ? '' : 's'}${late}`);
      for (const [v, n] of versions) lines.push(`  - ${v}: **${n}**`);
    }
  }
  lines.push('', `Checked ${stamp}.`);
  const summary = lines.join('\n');
  console.log('\n' + summary);
  fs.writeFileSync(path.join(DATA_DIR, 'SUMMARY.md'), summary + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');

  if (changes.length) {
    fs.writeFileSync(CHANGE_MD, `Cars deliverable by ${iso(deadline)} changed:\n\n- ${changes.join('\n- ')}\n\n${summary}\n`);
  } else if (fs.existsSync(CHANGE_MD)) {
    fs.unlinkSync(CHANGE_MD);
  }

  const empty = Object.values(results).filter((r) => r.total === 0);
  if (empty.length) {
    console.error(`\nNo cars found for: ${empty.map((r) => r.name).join(', ')}. The site layout may have changed — see the debug/ folder.`);
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { diffCars, carsFromJson, carsFromDom, findCarArrays, summarise, breakdown, carVersion, carFeatures };
