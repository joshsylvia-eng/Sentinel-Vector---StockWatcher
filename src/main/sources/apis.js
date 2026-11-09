'use strict';

/*
 * Keyed market-data APIs: Finnhub, Twelve Data, Alpha Vantage and TAAPI.IO.
 *
 * Every fetcher returns the same shape so the scheduler and the table can treat
 * them alike:
 *   { rating, score, tip: [lines], updatedAt }
 * and throws an Error carrying one of these flags when it fails:
 *   auth        - key missing, wrong or not entitled to this data
 *   rateLimited - per-minute or per-day quota hit (back off)
 */

const { UA } = require('./http');
const { rateBars, gaugeLines, bucket } = require('./indicators');

function fail(message, flags = {}) {
  const error = new Error(message);
  Object.assign(error, flags);
  return error;
}

async function getJson(url, { method = 'GET', body = null, timeout = 20000 } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    throw fail(`Network error: ${error.message || error}`);
  }

  let payload = null;
  const text = await response.text();
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (response.status === 429) throw fail('Rate limit reached', { rateLimited: true });
  if (response.status === 401 || response.status === 403) {
    const detail = (payload && (payload.error || payload.message)) || text.slice(0, 160);
    throw fail(`Not authorised (${response.status}) ${detail}`.trim(), { auth: true });
  }
  if (!response.ok) {
    const detail = (payload && (payload.error || payload.message)) || '';
    throw fail(`HTTP ${response.status} ${detail}`.trim());
  }
  if (payload == null) throw fail('Unexpected response');
  return payload;
}

/* ---------------- Finnhub ---------------- */

/*
 * /scan/technical-indicator is Finnhub's own aggregate signal (MAs +
 * oscillators, like TradingView's gauge). If the key is not entitled to it,
 * the analyst recommendation trend (free on every plan) is used instead and
 * the tooltip says so.
 */
async function finnhub(symbol, { key, resolution = '30', state = {} }) {
  const sym = encodeURIComponent(symbol.replace(/-/g, '.'));
  const token = encodeURIComponent(key);

  if (!state.analystOnly) {
    try {
      const data = await getJson(
        `https://finnhub.io/api/v1/scan/technical-indicator?symbol=${sym}&resolution=${encodeURIComponent(resolution)}&token=${token}`
      );
      const ta = data && data.technicalAnalysis;
      if (ta && ta.count) {
        const buy = Number(ta.count.buy) || 0;
        const neutral = Number(ta.count.neutral) || 0;
        const sell = Number(ta.count.sell) || 0;
        const total = buy + neutral + sell;
        const score = total ? (buy - sell) / total : 0;
        const signal = String(ta.signal || '').toLowerCase();
        // Finnhub's own verdict is buy/neutral/sell; the vote margin promotes
        // it to "Strong" on the same thresholds TradingView uses.
        let rating = signal === 'buy' ? 'Buy' : signal === 'sell' ? 'Sell' : 'Neutral';
        if (rating === 'Buy' && score >= 0.5) rating = 'Strong Buy';
        if (rating === 'Sell' && score <= -0.5) rating = 'Strong Sell';

        const trend = data.trend || {};
        const res = resolution === 'D' ? 'daily' : `${resolution} min`;
        const tip = [
          `Finnhub aggregate signal (${res}): ${signal || 'n/a'}`,
          `Indicators: ${buy} buy · ${neutral} neutral · ${sell} sell`,
        ];
        if (Number.isFinite(Number(trend.adx))) {
          tip.push(`ADX ${Number(trend.adx).toFixed(1)}${trend.trending ? ' · trending' : ''}`);
        }
        return { rating, score, tip, updatedAt: Date.now() };
      }
      throw fail('No technical analysis in response');
    } catch (error) {
      if (!error.auth) throw error;
      state.analystOnly = true; // remember for this session; retried on restart
    }
  }

  const trends = await getJson(`https://finnhub.io/api/v1/stock/recommendation?symbol=${sym}&token=${token}`);
  const latest = Array.isArray(trends) ? trends[0] : null;
  if (!latest) throw fail('Finnhub has no data for this symbol');
  const sb = Number(latest.strongBuy) || 0;
  const b = Number(latest.buy) || 0;
  const h = Number(latest.hold) || 0;
  const s = Number(latest.sell) || 0;
  const ss = Number(latest.strongSell) || 0;
  const n = sb + b + h + s + ss;
  if (!n) throw fail('Finnhub has no analyst coverage');
  const mean = (sb * 1 + b * 2 + h * 3 + s * 4 + ss * 5) / n;
  const rating =
    mean <= 1.5 ? 'Strong Buy' : mean <= 2.5 ? 'Buy' : mean <= 3.5 ? 'Hold' : mean <= 4.5 ? 'Sell' : 'Strong Sell';
  return {
    rating,
    score: (3 - mean) / 2,
    tip: [
      `Finnhub analyst trend (${latest.period || 'latest'})`,
      `${sb} strong buy · ${b} buy · ${h} hold · ${s} sell · ${ss} strong sell`,
      'Aggregate technical signal needs a Finnhub plan that includes it.',
    ],
    updatedAt: Date.now(),
  };
}

/* ---------------- Twelve Data ---------------- */

async function twelvedata(symbol, { key, interval = '30min' }) {
  const data = await getJson(
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol.replace(/-/g, '.'))}` +
      `&interval=${encodeURIComponent(interval)}&outputsize=250&order=ASC&apikey=${encodeURIComponent(key)}`
  );

  if (data.status === 'error' || !Array.isArray(data.values)) {
    const code = Number(data.code);
    const message = data.message || 'Twelve Data error';
    if (code === 429) throw fail(message, { rateLimited: true });
    if (code === 401 || code === 403) throw fail(message, { auth: true });
    throw fail(message);
  }

  const bars = data.values.map((v) => ({
    open: Number(v.open),
    high: Number(v.high),
    low: Number(v.low),
    close: Number(v.close),
    time: v.datetime,
  }));
  return gaugeResult(bars, `Twelve Data gauge (${interval}, computed in-app)`);
}

/* ---------------- Alpha Vantage ---------------- */

async function alphavantage(symbol, { key, interval = '30min' }) {
  const daily = interval === 'daily';
  const url = daily
    ? `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(symbol)}&outputsize=compact&apikey=${encodeURIComponent(key)}`
    : `https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&outputsize=compact&apikey=${encodeURIComponent(key)}`;

  const data = await getJson(url);

  // Alpha Vantage answers HTTP 200 with a prose message for every failure.
  const notice = data.Note || data.Information || data['Error Message'];
  if (notice) {
    if (/rate limit|requests per|call frequency|premium/i.test(notice)) {
      throw fail(notice, { rateLimited: !/premium/i.test(notice), auth: /premium/i.test(notice) });
    }
    if (/apikey|api key/i.test(notice)) throw fail(notice, { auth: true });
    throw fail(notice);
  }

  const seriesKey = Object.keys(data).find((k) => /^Time Series/.test(k));
  const series = seriesKey ? data[seriesKey] : null;
  if (!series) throw fail('Alpha Vantage returned no prices');

  const bars = Object.entries(series)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([time, v]) => ({
      open: Number(v['1. open']),
      high: Number(v['2. high']),
      low: Number(v['3. low']),
      close: Number(v['4. close']),
      time,
    }));
  return gaugeResult(bars, `Alpha Vantage gauge (${interval}, computed in-app)`);
}

function gaugeResult(bars, title) {
  const result = rateBars(bars);
  if (!result) throw fail('Not enough price history to rate');
  const lastBar = bars[bars.length - 1];
  return {
    rating: result.rating,
    score: result.score,
    tip: [title, ...gaugeLines(result), lastBar && lastBar.time ? `Last bar ${lastBar.time}` : null].filter(Boolean),
    updatedAt: Date.now(),
  };
}

/* ---------------- TAAPI.IO ---------------- */

/*
 * One /bulk call returns every indicator for a symbol. TAAPI only returns the
 * current values (no history), so votes use level-based rules: e.g. RSI below
 * 30 is a buy, price above a moving average is a buy.
 */
async function taapi(symbol, { key, interval = '30m', price = null }) {
  const indicators = [
    { id: 'rsi', indicator: 'rsi' },
    { id: 'macd', indicator: 'macd' },
    { id: 'stoch', indicator: 'stoch' },
    { id: 'cci', indicator: 'cci' },
    { id: 'dmi', indicator: 'dmi' },
    { id: 'willr', indicator: 'willr' },
    { id: 'mom', indicator: 'mom' },
    { id: 'ema20', indicator: 'ema', period: 20 },
    { id: 'ema50', indicator: 'ema', period: 50 },
    { id: 'sma50', indicator: 'sma', period: 50 },
    { id: 'sma200', indicator: 'sma', period: 200 },
    { id: 'price', indicator: 'price' },
  ];

  const data = await getJson('https://api.taapi.io/bulk', {
    method: 'POST',
    body: {
      secret: key,
      construct: { type: 'stocks', symbol: symbol.replace(/-/g, '.'), interval, indicators },
    },
  });

  const rows = Array.isArray(data && data.data) ? data.data : [];
  const by = {};
  const errors = [];
  for (const row of rows) {
    const id = String(row.id || '').split('_').pop();
    if (row.errors && row.errors.length) errors.push(String(row.errors[0]));
    if (row.result) by[row.id] = row.result;
    if (row.result && id && !by[id]) by[id] = row.result;
  }

  if (!Object.keys(by).length) {
    const message = errors[0] || (data && (data.error || data.message)) || 'TAAPI returned no indicators';
    if (/plan|upgrade|subscription|not allowed|stocks/i.test(message)) throw fail(message, { auth: true });
    throw fail(message);
  }

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.isFinite(Number(v)) ? Number(v) : null);
  const close = num(by.price && by.price.value) ?? num(price);

  const maVotes = [];
  for (const id of ['ema20', 'ema50', 'sma50', 'sma200']) {
    const value = num(by[id] && by[id].value);
    if (close != null && value != null) maVotes.push(close > value ? 1 : close < value ? -1 : 0);
  }

  const osc = [];
  const r = num(by.rsi && by.rsi.value);
  if (r != null) osc.push(r < 30 ? 1 : r > 70 ? -1 : 0);
  if (by.macd) {
    const m = num(by.macd.valueMACD);
    const s = num(by.macd.valueMACDSignal);
    if (m != null && s != null) osc.push(m > s ? 1 : m < s ? -1 : 0);
  }
  if (by.stoch) {
    const k = num(by.stoch.valueK);
    const d = num(by.stoch.valueD);
    if (k != null && d != null) osc.push(k < 20 && k > d ? 1 : k > 80 && k < d ? -1 : 0);
  }
  const c = num(by.cci && by.cci.value);
  if (c != null) osc.push(c < -100 ? 1 : c > 100 ? -1 : 0);
  if (by.dmi) {
    const a = num(by.dmi.adx);
    const p = num(by.dmi.pdi);
    const mi = num(by.dmi.mdi);
    if (a != null && p != null && mi != null) osc.push(a > 20 && p > mi ? 1 : a > 20 && mi > p ? -1 : 0);
  }
  const w = num(by.willr && by.willr.value);
  if (w != null) osc.push(w < -80 ? 1 : w > -20 ? -1 : 0);
  const mo = num(by.mom && by.mom.value);
  if (mo != null) osc.push(mo > 0 ? 1 : mo < 0 ? -1 : 0);

  if (!maVotes.length && !osc.length) throw fail(errors[0] || 'TAAPI returned no usable values');

  const avg = (votes) => (votes.length ? votes.reduce((sum, v) => sum + v, 0) / votes.length : 0);
  const groups = [maVotes, osc].filter((g) => g.length);
  const score = groups.reduce((sum, g) => sum + avg(g), 0) / groups.length;
  const count = (votes, sign) => votes.filter((v) => Math.sign(v) === sign).length;

  const tip = [
    `TAAPI.IO gauge (${interval}, current values)`,
    `Score ${score.toFixed(2)}`,
    `Moving averages: ${count(maVotes, 1)} buy · ${count(maVotes, 0)} neutral · ${count(maVotes, -1)} sell`,
    `Oscillators: ${count(osc, 1)} buy · ${count(osc, 0)} neutral · ${count(osc, -1)} sell`,
  ];
  if (r != null) tip.push(`RSI ${r.toFixed(1)}`);

  return { rating: bucket(score), score, tip, updatedAt: Date.now() };
}

module.exports = { finnhub, twelvedata, alphavantage, taapi, fail };
