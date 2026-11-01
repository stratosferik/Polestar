# Polestar 4 stock monitor (Norway)

Counts how many **Polestar 4 Coupe** and **Polestar 4 SUV** stock cars on polestar.com/no
can be delivered **by 31 December** (or another deadline you pick).

- https://www.polestar.com/no/stock-cars/polestar-4-coupe/
- https://www.polestar.com/no/stock-cars/polestar-4-suv/

## How it runs

A GitHub Action (`.github/workflows/monitor.yml`) runs 3 times a day. Each run:

1. Opens both pages in a headless browser, accepts cookies, clicks "Vis flere" until every car is loaded.
2. Reads each car's delivery estimate, from the data the page downloads or, if that fails, from the page text.
3. Counts cars due on or before the deadline, and writes:
   - `data/history.csv`: one row per model per run, to see the trend
   - `data/SUMMARY.md`: **latest counts, grouped by delivery period with a count per version**
     (motor · colour · wheels · Prime/Business · Performance, e.g. "Dual motor · Space · 20\" Aero · Prime · Performance"; Space = black)
   - `data/latest.json`: every car with its delivery date, version, packs and options
   - a table in the run's summary page
4. When the count changes, it comments on the issue **"Polestar 4 stock alerts"**, so GitHub notifies you.

Run it now: **Actions → Polestar stock monitor → Run workflow**. You can enter another deadline there.

## How delivery dates are read

Estimates are turned into the *latest* date they could mean, so "before deadline" stays safe:

| Shown on site | Counted as |
|---|---|
| Klar for levering / på lager | today |
| 15.12.2026 | 15 Dec 2026 |
| Desember 2026 | 31 Dec 2026 |
| Uke 51 | Sunday of week 51 |
| Innen 4–6 uker | today + 6 weeks |
| Q4 2026 | 31 Dec 2026 |

Anything it can't read is counted as **unknown**, with the original text kept in `latest.json`.

## Run locally

```sh
npm install
npx playwright install chromium
npm run monitor                 # deadline: 31 Dec this year
DEADLINE=2026-12-20 npm run monitor
MODELS=suv npm run monitor
npm test
```

## If it breaks

If a model shows 0 cars the run fails (GitHub emails you). Each run uploads a `debug-…` artifact
with the page HTML, a screenshot and all JSON the page loaded, which shows what changed on the site.
