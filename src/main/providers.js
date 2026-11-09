'use strict';

/*
 * Background rating providers. Each one refreshes on its own interval with its
 * own rate limits, so a slow, throttled or keyless source never delays the
 * price table. Results are cached on the watchlist item (item.ext[id]) and
 * survive restarts.
 */

const investingTech = require('./sources/investingTech');
const apis = require('./sources/apis');

const MINUTE = 60 * 1000;

const PROVIDERS = {
  investing: {
    id: 'investing',
    label: 'Investing.com',
    needsKey: false,
    defaults: { enabled: true, interval: 30, tf: '30m', marketHoursOnly: false },
    gapMs: 1500,
    eligible: (item) => Boolean(item.investingPairId),
    async fetch(item, cfg) {
      const data = await investingTech.fetchTechnical(item.investingPairId, cfg.tf || '30m');
      const tf = String(data.timeframe || cfg.tf || '30m');
      return {
        rating: data.rating,
        tip: [
          `Investing.com technical summary (${tf})`,
          data.maRating ? `Moving averages: ${data.maRating}` : null,
          data.oscRating ? `Indicators: ${data.oscRating}` : null,
        ].filter(Boolean),
        updatedAt: data.updatedAt || Date.now(),
      };
    },
  },

  finnhub: {
    id: 'finnhub',
    label: 'Finnhub',
    needsKey: true,
    keyUrl: 'https://finnhub.io/register',
    defaults: { enabled: false, interval: 10, tf: '30', marketHoursOnly: true },
    timeframes: ['5', '15', '30', '60', 'D'],
    gapMs: 1100, // free plan: 60 calls/min
    eligible: () => true,
    fetch(item, cfg, ctx) {
      return apis.finnhub(item.symbol, { key: ctx.key, resolution: cfg.tf || '30', state: ctx.memo });
    },
  },

  twelvedata: {
    id: 'twelvedata',
    label: 'Twelve Data',
    needsKey: true,
    keyUrl: 'https://twelvedata.com/register',
    defaults: { enabled: false, interval: 30, tf: '30min', dailyLimit: 800, marketHoursOnly: true },
    timeframes: ['5min', '15min', '30min', '1h', '4h', '1day'],
    gapMs: 8000, // free plan: 8 credits/min
    eligible: () => true,
    fetch(item, cfg, ctx) {
      return apis.twelvedata(item.symbol, { key: ctx.key, interval: cfg.tf || '30min' });
    },
  },

  alphavantage: {
    id: 'alphavantage',
    label: 'Alpha Vantage',
    needsKey: true,
    keyUrl: 'https://www.alphavantage.co/support/#api-key',
    defaults: { enabled: false, interval: 120, tf: '30min', dailyLimit: 25, marketHoursOnly: true },
    timeframes: ['15min', '30min', '60min', 'daily'],
    gapMs: 13000, // free plan: 5 calls/min, 25/day
    eligible: () => true,
    fetch(item, cfg, ctx) {
      return apis.alphavantage(item.symbol, { key: ctx.key, interval: cfg.tf || '30min' });
    },
  },

  taapi: {
    id: 'taapi',
    label: 'TAAPI.IO',
    needsKey: true,
    keyUrl: 'https://taapi.io/',
    defaults: { enabled: false, interval: 30, tf: '30m', marketHoursOnly: true },
    timeframes: ['5m', '15m', '30m', '1h', '4h', '1d'],
    gapMs: 15500, // free plan: 1 call / 15 s
    eligible: () => true,
    fetch(item, cfg, ctx) {
      return apis.taapi(item.symbol, { key: ctx.key, interval: cfg.tf || '30m', price: ctx.price });
    },
  },
};

const PROVIDER_IDS = Object.keys(PROVIDERS);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function dayKey(time = Date.now()) {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Ratings worth tracking for change alerts, per provider. */
function trackedValues(id, record) {
  if (!record) return {};
  return { [id]: record.rating || null };
}

/**
 * deps:
 *   getState()          -> { items, settings, usage }
 *   save()
 *   getKey(id)          -> string | null
 *   isMarketOpen()      -> boolean
 *   getPrice(symbol)    -> number | null
 *   onRecord(symbol, id, before, after)   called after every fetch
 */
function createScheduler(deps) {
  const runtime = {};
  for (const id of PROVIDER_IDS) {
    runtime[id] = { running: null, blockedUntil: 0, lastError: null, lastOkAt: null, memo: {} };
  }

  function usage(id) {
    const state = deps.getState();
    const today = dayKey();
    if (!state.usage || state.usage.day !== today) state.usage = { day: today, counts: {} };
    return state.usage.counts[id] || 0;
  }

  function countCall(id) {
    usage(id);
    const state = deps.getState();
    state.usage.counts[id] = (state.usage.counts[id] || 0) + 1;
  }

  function config(id) {
    const settings = deps.getState().settings;
    return { ...PROVIDERS[id].defaults, ...((settings.providers || {})[id] || {}) };
  }

  function isDue(item, id, cfg, now) {
    const record = item.ext && item.ext[id];
    if (!record || !record.fetchedAt) return true;
    // "Market hours only" sources make no calls at all while the market is shut.
    if (cfg.marketHoursOnly && !deps.isMarketOpen()) return false;
    let minutes = Number(cfg.interval) || PROVIDERS[id].defaults.interval;
    // Outside market hours the numbers barely move; check far less often.
    if (!deps.isMarketOpen()) minutes = Math.max(minutes, 240);
    return now - record.fetchedAt >= minutes * MINUTE;
  }

  async function runProvider(id, { force = false } = {}) {
    const provider = PROVIDERS[id];
    const rt = runtime[id];
    if (rt.running) return rt.running;

    rt.running = (async () => {
      const cfg = config(id);
      if (!cfg.enabled) return;
      const key = provider.needsKey ? deps.getKey(id) : null;
      if (provider.needsKey && !key) return;
      if (!force && Date.now() < rt.blockedUntil) return;

      const now = Date.now();
      const items = deps
        .getState()
        .items.filter((item) => provider.eligible(item) && (force || isDue(item, id, cfg, now)))
        .sort((a, b) => ((a.ext && a.ext[id] && a.ext[id].fetchedAt) || 0) - ((b.ext && b.ext[id] && b.ext[id].fetchedAt) || 0));

      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        const limit = Number(cfg.dailyLimit) || 0;
        if (limit && usage(id) >= limit) {
          rt.lastError = `Daily limit of ${limit} calls used; resumes tomorrow.`;
          break;
        }
        if (index > 0) await sleep(provider.gapMs);
        // The item may have been removed while we waited.
        if (!deps.getState().items.includes(item)) continue;

        const before = item.ext ? item.ext[id] : null;
        countCall(id);
        try {
          const result = await provider.fetch(item, cfg, {
            key,
            memo: rt.memo,
            price: deps.getPrice(item.symbol),
          });
          const after = { ...result, fetchedAt: Date.now(), error: null };
          item.ext = { ...(item.ext || {}), [id]: after };
          rt.lastError = null;
          rt.lastOkAt = Date.now();
          deps.onRecord(item.symbol, id, before, after);
        } catch (error) {
          const message = (error && error.message) || 'Request failed';
          // Keep the last good rating; just note the failure on it.
          item.ext = {
            ...(item.ext || {}),
            [id]: { ...(before || {}), fetchedAt: Date.now(), error: message },
          };
          rt.lastError = message;
          deps.onRecord(item.symbol, id, before, item.ext[id]);

          if (error && (error.rateLimited || error.blocked)) {
            rt.blockedUntil = Date.now() + 15 * MINUTE;
            break;
          }
          if (error && error.auth) {
            rt.blockedUntil = Date.now() + 60 * MINUTE;
            break;
          }
        }
      }
      deps.save();
    })().finally(() => {
      rt.running = null;
    });

    return rt.running;
  }

  function runAll(options) {
    return Promise.all(PROVIDER_IDS.map((id) => runProvider(id, options).catch(() => {})));
  }

  function unblock(id) {
    if (!runtime[id]) return;
    runtime[id].blockedUntil = 0;
    runtime[id].lastError = null;
    runtime[id].memo = {};
  }

  /** Test a key against one symbol without touching the watchlist cache. */
  async function test(id, symbol, key) {
    const provider = PROVIDERS[id];
    if (!provider) throw new Error('Unknown provider');
    countCall(id);
    const fakeItem = { symbol, investingPairId: null };
    return provider.fetch(fakeItem, config(id), { key, memo: {}, price: deps.getPrice(symbol) });
  }

  function status() {
    const out = {};
    for (const id of PROVIDER_IDS) {
      const rt = runtime[id];
      out[id] = {
        callsToday: usage(id),
        lastError: rt.lastError,
        lastOkAt: rt.lastOkAt,
        blockedUntil: rt.blockedUntil > Date.now() ? rt.blockedUntil : null,
        running: Boolean(rt.running),
      };
    }
    return out;
  }

  return { runAll, runProvider, unblock, test, status, config };
}

module.exports = { PROVIDERS, PROVIDER_IDS, createScheduler, trackedValues, dayKey };
