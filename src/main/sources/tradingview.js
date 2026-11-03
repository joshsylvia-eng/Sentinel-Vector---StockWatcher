'use strict';

const { US_EXCHANGES } = require('./yahoo');

const SCAN_URL = 'https://scanner.tradingview.com/america/scan';

const SCAN_HEADERS = {
  'Content-Type': 'application/json',
  Origin: 'https://www.tradingview.com',
  Referer: 'https://www.tradingview.com/',
};

const TV_EXCHANGES = ['NYSE', 'NASDAQ', 'AMEX', 'CBOE', 'OTC'];

function toTvPrefix(exchangeCode) {
  return US_EXCHANGES.get(exchangeCode) || 'NYSE';
}

function normalizeTicker(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

async function scan(body, { timeout = 20000 } = {}) {
  const response = await fetch(SCAN_URL, {
    method: 'POST',
    headers: SCAN_HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });

  if (!response.ok) throw new Error(`TradingView HTTP ${response.status}`);
  return response.json();
}

/**
 * TradingView's gauge is a running average of -1/0/+1 signals, so these are
 * exactly the buckets their own UI uses.
 */
function bucket(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  if (score >= 0.5) return 'Strong Buy';
  if (score >= 0.1) return 'Buy';
  if (score > -0.1) return 'Neutral';
  if (score > -0.5) return 'Sell';
  return 'Strong Sell';
}

/**
 * One batched request covers the whole watchlist.
 * Returns a map of "EXCHANGE:TICKER" -> rating details.
 */
async function fetchRatings(tickers) {
  const unique = [...new Set(tickers.filter(Boolean))];
  if (!unique.length) return {};

  const data = await scan({
    symbols: { tickers: unique, query: { types: [] } },
    columns: ['name', 'close', 'volume', 'Recommend.All', 'Recommend.MA', 'Recommend.Other'],
  });

  const ratings = {};
  for (const row of data.data || []) {
    const [, , , all, ma, other] = row.d;
    ratings[row.s] = {
      score: typeof all === 'number' ? all : null,
      rating: bucket(all),
      maScore: typeof ma === 'number' ? ma : null,
      oscScore: typeof other === 'number' ? other : null,
    };
  }
  return ratings;
}

/**
 * Find the exact TradingView ticker (e.g. "NYSE:FCX") for a symbol.
 * Falls back to a prefix guess if the scanner lookup fails.
 */
async function resolveTicker(symbol, exchangeCode) {
  const wanted = normalizeTicker(symbol);
  const variants = [
    ...new Set([String(symbol || '').toUpperCase(), String(symbol || '').toUpperCase().replace(/-/g, '.')]),
  ];

  for (const variant of variants) {
    for (const operation of ['equal', 'match']) {
      try {
        const data = await scan({
          filter: [{ left: 'name', operation, right: variant }],
          options: { lang: 'en' },
          columns: ['name', 'exchange', 'type', 'description'],
          range: [0, 40],
        });

        const rows = (data.data || []).map((row) => ({
          ticker: row.s,
          exchange: row.d[1],
          type: String(row.d[2] || ''),
          description: row.d[3],
        }));

        const candidates = rows.filter(
          (row) =>
            TV_EXCHANGES.includes(row.exchange) &&
            /stock|fund|etf|dr/i.test(row.type) &&
            normalizeTicker(row.ticker.split(':')[1]) === wanted
        );

        if (candidates.length) {
          const prefix = toTvPrefix(exchangeCode);
          const preferred = candidates.find((row) => row.exchange === prefix) || candidates[0];
          return preferred.ticker;
        }
      } catch {
        // try the next strategy
      }
    }
  }

  // Yahoo writes class shares as BRK-B, TradingView as BRK.B.
  return `${toTvPrefix(exchangeCode)}:${String(symbol || '').toUpperCase().replace(/-/g, '.')}`;
}

module.exports = { fetchRatings, resolveTicker, bucket };
