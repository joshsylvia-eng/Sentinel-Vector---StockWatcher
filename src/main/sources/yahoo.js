'use strict';

const { fetchJson } = require('./http');

/**
 * Yahoo exchange codes -> display names. Only these are treated as US listings.
 */
const US_EXCHANGES = new Map([
  ['NYQ', 'NYSE'],
  ['NMS', 'NASDAQ'],
  ['NGM', 'NASDAQ'],
  ['NCM', 'NASDAQ'],
  ['ASE', 'AMEX'],
  ['PCX', 'AMEX'],
  ['BTS', 'CBOE'],
  ['OTC', 'OTC'],
]);

const US_EXCHANGE_NAMES = new Set(US_EXCHANGES.values());

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Search Yahoo for matching instruments and put the US listing first, which is
 * what the "add the United States version" step needs.
 */
async function searchSymbols(query) {
  const term = String(query || '').trim();
  if (!term) return [];

  const data = await fetchJson(
    `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(term)}&quotesCount=25&newsCount=0`
  );

  const seen = new Set();
  const results = [];

  for (const quote of data.quotes || []) {
    if (!quote || !quote.symbol || seen.has(quote.symbol)) continue;
    if (quote.quoteType !== 'EQUITY' && quote.quoteType !== 'ETF') continue;

    seen.add(quote.symbol);
    results.push({
      symbol: quote.symbol,
      name: quote.longname || quote.shortname || quote.symbol,
      exchange: quote.exchange || '',
      exchangeDisp: quote.exchDisp || quote.exchange || '',
      quoteType: quote.quoteType,
      isUS: US_EXCHANGES.has(quote.exchange) || US_EXCHANGE_NAMES.has(quote.exchDisp),
    });
  }

  const upper = term.toUpperCase();
  results.sort((a, b) => {
    if (a.isUS !== b.isUS) return a.isUS ? -1 : 1;
    const aExact = a.symbol.toUpperCase() === upper ? 0 : 1;
    const bExact = b.symbol.toUpperCase() === upper ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    return a.symbol.localeCompare(b.symbol);
  });

  return results;
}

function isRegularSessionOpen(meta) {
  const now = Date.now() / 1000;

  const periods = (meta.tradingPeriods || []).flat().filter(Boolean);
  for (const period of periods) {
    if (now >= period.start && now < period.end) return true;
  }

  const regular = meta.currentTradingPeriod && meta.currentTradingPeriod.regular;
  if (regular) return now >= regular.start && now < regular.end;

  // Fall back to "a tick arrived very recently".
  return typeof meta.regularMarketTime === 'number' && Math.abs(now - meta.regularMarketTime) < 900;
}

/**
 * Day open, current price, change % and volume for one symbol.
 */
async function fetchQuote(symbol) {
  const data = await fetchJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol
    )}?range=1d&interval=5m&includePrePost=false&lang=en-US&region=US`
  );

  const result = data && data.chart && data.chart.result && data.chart.result[0];
  if (!result) {
    const description = data && data.chart && data.chart.error && data.chart.error.description;
    throw new Error(description || 'No quote data');
  }

  const meta = result.meta || {};
  const series = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};

  // The first bar of the regular session is the day's opening price.
  let open = null;
  for (const value of series.open || []) {
    if (typeof value === 'number' && value > 0) {
      open = value;
      break;
    }
  }

  const price = num(meta.regularMarketPrice);
  const previousClose = num(meta.chartPreviousClose) ?? num(meta.previousClose);
  const changePct =
    price != null && previousClose ? ((price - previousClose) / previousClose) * 100 : null;

  return {
    open,
    price,
    previousClose,
    changePct,
    volume: num(meta.regularMarketVolume),
    currency: meta.currency || 'USD',
    exchangeName: meta.fullExchangeName || '',
    marketOpen: isRegularSessionOpen(meta),
    updatedAt: Date.now(),
  };
}

/** Chart ranges the hover chart offers, with a bar size that keeps ~50-400 points. */
const CHART_RANGES = {
  '1d': { range: '1d', interval: '5m' },
  '5d': { range: '5d', interval: '15m' },
  '1mo': { range: '1mo', interval: '60m' },
  '6mo': { range: '6mo', interval: '1d' },
  ytd: { range: 'ytd', interval: '1d' },
  '1y': { range: '1y', interval: '1d' },
  '5y': { range: '5y', interval: '1wk' },
  max: { range: 'max', interval: '1mo' },
};

/**
 * Close prices over a range for the hover chart.
 */
async function fetchChart(symbol, rangeId) {
  const spec = CHART_RANGES[rangeId];
  if (!spec) throw new Error('Unknown chart range.');

  const data = await fetchJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${spec.range}&interval=${
      spec.interval
    }&includePrePost=false&lang=en-US&region=US`
  );

  const result = data && data.chart && data.chart.result && data.chart.result[0];
  if (!result) {
    const description = data && data.chart && data.chart.error && data.chart.error.description;
    throw new Error(description || 'No chart data');
  }

  const meta = result.meta || {};
  const times = result.timestamp || [];
  const closes = (result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close) || [];

  const points = [];
  for (let i = 0; i < times.length; i += 1) {
    const close = num(closes[i]);
    if (close != null && close > 0) points.push({ t: times[i] * 1000, c: close });
  }

  // Yahoo's last bar can lag the live price; pin the latest price on short ranges.
  const price = num(meta.regularMarketPrice);
  if (price != null && points.length && (rangeId === '1d' || rangeId === '5d')) {
    points[points.length - 1].c = price;
  }

  return {
    symbol,
    range: rangeId,
    points,
    previousClose: rangeId === '1d' ? num(meta.chartPreviousClose) ?? num(meta.previousClose) : null,
    currency: meta.currency || 'USD',
    fetchedAt: Date.now(),
  };
}

module.exports = { searchSymbols, fetchQuote, fetchChart, CHART_RANGES, US_EXCHANGES, num };
