'use strict';

/*
 * Exercises every data source without launching Electron.
 *   node tools/test-data.js [SYMBOL]
 */

const yahoo = require('../src/main/sources/yahoo');
const tradingview = require('../src/main/sources/tradingview');
const investing = require('../src/main/sources/investing');

function line(label) {
  return `\n=== ${label} ===`;
}

(async () => {
  const symbol = (process.argv[2] || 'FCX').toUpperCase();

  console.log(line(`search "${symbol}"`));
  const results = await yahoo.searchSymbols(symbol);
  for (const result of results.slice(0, 5)) {
    console.log(
      `  ${result.isUS ? 'US ' : '   '}${result.symbol.padEnd(10)} ${String(
        result.exchangeDisp
      ).padEnd(12)} ${result.name}`
    );
  }

  const us = results.find((result) => result.isUS && result.symbol === symbol) || results[0];
  if (!us) throw new Error('no search results');
  console.log(`\nU picked: ${us.symbol} (${us.exchangeDisp})`);

  console.log(line('quote'));
  const quote = await yahoo.fetchQuote(us.symbol);
  console.log(quote);

  console.log(line('tradingview ticker'));
  const ticker = await tradingview.resolveTicker(us.symbol, us.exchange);
  console.log(ticker);

  console.log(line('technical rating'));
  const ratings = await tradingview.fetchRatings([ticker]);
  console.log(ratings[ticker]);

  console.log(line('investing.com US page'));
  const url = await investing.resolveInvestingUrl(us.symbol);
  console.log(url);

  // Keyed APIs: set FINNHUB_KEY / TWELVEDATA_KEY / ALPHAVANTAGE_KEY / TAAPI_KEY to try them.
  const apis = require('../src/main/sources/apis');
  for (const [id, env] of [
    ['finnhub', 'FINNHUB_KEY'],
    ['twelvedata', 'TWELVEDATA_KEY'],
    ['alphavantage', 'ALPHAVANTAGE_KEY'],
    ['taapi', 'TAAPI_KEY'],
  ]) {
    if (!process.env[env]) continue;
    console.log(line(id));
    try {
      const result = await apis[id](us.symbol, { key: process.env[env] });
      console.log(result.rating, result.tip);
    } catch (error) {
      console.log('  failed:', error.message);
    }
  }

  console.log('\nAll data sources OK.');
})().catch((error) => {
  console.error('\nFAILED:', error);
  process.exit(1);
});
