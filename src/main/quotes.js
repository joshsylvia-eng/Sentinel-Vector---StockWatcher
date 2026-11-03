'use strict';

const yahoo = require('./sources/yahoo');
const tradingview = require('./sources/tradingview');
const { buildLinks } = require('./links');

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = new Array(Math.min(limit, items.length) || 0).fill(null).map(async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * Build display rows for the whole watchlist.
 * Quotes are fetched per symbol (bounded concurrency); ratings come from one
 * batched TradingView request.
 */
async function fetchRows(items) {
  if (!items.length) return { rows: [], ratingsError: null };

  const quotes = await mapLimit(items, 4, async (item) => {
    try {
      return { ok: true, quote: await yahoo.fetchQuote(item.symbol) };
    } catch (error) {
      return { ok: false, error: error.message || 'Quote failed' };
    }
  });

  let ratings = {};
  let ratingsError = null;

  const tickers = items.map((item) => item.tvTicker).filter(Boolean);
  if (tickers.length) {
    try {
      ratings = await tradingview.fetchRatings(tickers);
    } catch (error) {
      ratingsError = error.message || 'Ratings failed';
    }
  }

  const rows = items.map((item, index) => {
    const quote = quotes[index];
    const rating = item.tvTicker ? ratings[item.tvTicker] : null;

    return {
      symbol: item.symbol,
      name: item.name,
      exchange: item.exchangeDisp || item.exchange || '',
      addedAt: item.addedAt,
      tvTicker: item.tvTicker,
      links: buildLinks(item),

      open: quote.ok ? quote.quote.open : null,
      price: quote.ok ? quote.quote.price : null,
      changePct: quote.ok ? quote.quote.changePct : null,
      volume: quote.ok ? quote.quote.volume : null,
      currency: quote.ok ? quote.quote.currency : 'USD',
      marketOpen: quote.ok ? quote.quote.marketOpen : false,

      rating: rating ? rating.rating : null,
      ratingScore: rating ? rating.score : null,
      maScore: rating ? rating.maScore : null,
      oscScore: rating ? rating.oscScore : null,

      quoteError: quote.ok ? null : quote.error,
      ratingError: rating ? null : ratingsError || 'No rating',
      updatedAt: Date.now(),
    };
  });

  return { rows, ratingsError };
}

module.exports = { fetchRows };
