// Turns a delivery estimate (Norwegian or English text, or a date value from
// the site's data) into the latest date the car is expected to be delivered.
// When the text is a range ("desember 2026", "innen 4-6 uker"), we use the
// latest date in that range so "before deadline" stays a safe estimate.

const MONTHS = {
  jan: 0, januar: 0, january: 0,
  feb: 1, februar: 1, february: 1,
  mar: 2, mars: 2, march: 2,
  apr: 3, april: 3,
  mai: 4, may: 4,
  jun: 5, juni: 5, june: 5,
  jul: 6, juli: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  okt: 9, oktober: 9, oct: 9, october: 9,
  nov: 10, november: 10,
  des: 11, desember: 11, dec: 11, december: 11,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

const IMMEDIATE_RE =
  /(klar for (umiddelbar )?levering|umiddelbar(t)? levering|kan leveres (nå|umiddelbart)|på lager|tilgjengelig (nå|for levering)|leveres umiddelbart|available now|ready for (immediate )?delivery|immediate delivery|in stock)/i;

const DAY_MS = 24 * 60 * 60 * 1000;

function endOfMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0));
}

function utcDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m && dt.getUTCDate() === d ? dt : null;
}

function startOfDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// Sunday of ISO week `week` in `year`.
function endOfIsoWeek(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dow = jan4.getUTCDay() || 7;
  const mondayWeek1 = new Date(jan4.getTime() - (dow - 1) * DAY_MS);
  return new Date(mondayWeek1.getTime() + ((week - 1) * 7 + 6) * DAY_MS);
}

function fullYear(y) {
  y = Number(y);
  return y < 100 ? 2000 + y : y;
}

// A month with no year means its next occurrence (this year or next).
function yearForMonth(month, today) {
  return month >= today.getUTCMonth() ? today.getUTCFullYear() : today.getUTCFullYear() + 1;
}

/**
 * @param {unknown} value  text, ISO string, epoch number or Date
 * @param {Date} [now]
 * @returns {{date: Date, kind: string} | null}
 */
function parseDelivery(value, now = new Date()) {
  const today = startOfDay(now);
  if (value == null || value === '') return null;

  if (value instanceof Date) return isNaN(value) ? null : { date: startOfDay(value), kind: 'date' };

  if (typeof value === 'number') {
    // Epoch seconds or milliseconds within a sane range (2000–2100).
    const ms = value < 1e11 ? value * 1000 : value;
    if (ms > 946684800000 && ms < 4102444800000) return { date: startOfDay(new Date(ms)), kind: 'date' };
    return null;
  }

  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  let m;

  if (IMMEDIATE_RE.test(lower)) return { date: today, kind: 'immediate' };

  // ISO: 2026-12-15 or 2026-12-15T10:00:00Z
  if ((m = lower.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})(?!\d)/))) {
    const d = utcDate(+m[1], +m[2] - 1, +m[3]);
    if (d) return { date: d, kind: 'date' };
  }
  // ISO month only: 2026-12
  if ((m = lower.match(/\b(20\d{2})-(\d{1,2})\b/))) {
    const mo = +m[2] - 1;
    if (mo >= 0 && mo < 12) return { date: endOfMonth(+m[1], mo), kind: 'month' };
  }

  // Ranges of numeric dates: use the last date mentioned.
  const numeric = [...lower.matchAll(/\b(\d{1,2})[./](\d{1,2})[./](\d{2,4})\b/g)]
    .map((x) => utcDate(fullYear(x[3]), +x[2] - 1, +x[1]))
    .filter(Boolean);
  if (numeric.length) return { date: numeric[numeric.length - 1], kind: 'date' };

  // "15. desember 2026", "15 december 2026", "december 15, 2026", "15. des"
  const dayMonth = [
    ...lower.matchAll(new RegExp(`\\b(\\d{1,2})\\.? (${MONTH_RE})\\.?(?: (\\d{4}))?\\b`, 'g')),
  ].map((x) => {
    const mo = MONTHS[x[2]];
    return utcDate(x[3] ? +x[3] : yearForMonth(mo, today), mo, +x[1]);
  });
  const monthDay = [
    ...lower.matchAll(new RegExp(`\\b(${MONTH_RE})\\.? (\\d{1,2})(?:st|nd|rd|th)?,? (\\d{4})\\b`, 'g')),
  ].map((x) => utcDate(+x[3], MONTHS[x[1]], +x[2]));
  const fullDates = [...dayMonth, ...monthDay].filter(Boolean);
  if (fullDates.length) return { date: fullDates[fullDates.length - 1], kind: 'date' };

  // "uke 50", "uke 50 2026", "week 50"
  if ((m = lower.match(/\b(?:uke|week|wk)\.? ?(\d{1,2})(?:[ ,/-]+(\d{4}))?\b/))) {
    const week = +m[1];
    if (week >= 1 && week <= 53) {
      let year = m[2] ? +m[2] : today.getUTCFullYear();
      let d = endOfIsoWeek(year, week);
      if (!m[2] && d < today) d = endOfIsoWeek(year + 1, week);
      return { date: d, kind: 'week' };
    }
  }

  // "Q4 2026", "4. kvartal 2026"
  if ((m = lower.match(/\bq([1-4]) ?(\d{4})\b/)) || (m = lower.match(/\b([1-4])\.? kvartal (\d{4})\b/))) {
    return { date: endOfMonth(+m[2], +m[1] * 3 - 1), kind: 'quarter' };
  }

  // "desember 2026", "november–desember 2026", "des 2026", or a bare month.
  const months = [...lower.matchAll(new RegExp(`\\b(${MONTH_RE})\\.?\\b(?: (\\d{4}))?`, 'g'))];
  if (months.length) {
    const last = months[months.length - 1];
    const mo = MONTHS[last[1]];
    const year = last[2] ? +last[2] : yearForMonth(mo, today);
    // "mar"/"mai"/"may" are also ordinary words; only accept them as months
    // when the text looks like a delivery estimate.
    const ambiguous = ['mar', 'mai', 'may'].includes(last[1]) && !last[2];
    if (!ambiguous) return { date: endOfMonth(year, mo), kind: 'month' };
  }

  // "innen 2 uker", "2-4 uker", "within 3 weeks", "ca. 10 dager"
  if ((m = lower.match(/(\d+)(?: ?[-–] ?(\d+))? ?(dag|dager|day|days|uke|uker|week|weeks|måned|måneder|mnd|month|months)\b/))) {
    const n = +(m[2] || m[1]);
    const unit = m[3];
    if (/^(dag|day)/.test(unit)) return { date: new Date(today.getTime() + n * DAY_MS), kind: 'relative' };
    if (/^(uke|week)/.test(unit)) return { date: new Date(today.getTime() + n * 7 * DAY_MS), kind: 'relative' };
    const d = new Date(today);
    d.setUTCMonth(d.getUTCMonth() + n);
    return { date: d, kind: 'relative' };
  }

  // "Tilgjengelig kun hos Polestar Tønsberg" (no date) = in stock at that store.
  if (/tilgjengelig (kun |bare )?(hos|på|i) /.test(lower)) return { date: today, kind: 'immediate' };

  return null;
}

/** Deadline = 31 Dec of the current year unless a YYYY-MM-DD is given. */
function resolveDeadline(input, now = new Date()) {
  if (input) {
    const m = String(input).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const d = m && utcDate(+m[1], +m[2] - 1, +m[3]);
    if (!d) throw new Error(`Invalid DEADLINE "${input}", expected YYYY-MM-DD`);
    return d;
  }
  return new Date(Date.UTC(now.getUTCFullYear(), 11, 31));
}

module.exports = { parseDelivery, resolveDeadline, startOfDay };
