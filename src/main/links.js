'use strict';

const ALLOWED_HOSTS = [
  'yahoo.com',
  'investing.com',
  'tradingview.com',
  'zacks.com',
  'seekingalpha.com',
  'morningstar.com',
  'finviz.com',
  'marketwatch.com',
  'nasdaq.com',
  'stockanalysis.com',
  'google.com',
  'cnbc.com',
  'barchart.com',
  'marketbeat.com',
  'sec.gov',
];

// Yahoo exchange codes -> the exchange names Google Finance and MarketBeat use.
const EXCHANGE_CODES = {
  NMS: 'NASDAQ',
  NGM: 'NASDAQ',
  NCM: 'NASDAQ',
  NYQ: 'NYSE',
  PCX: 'NYSEARCA',
  ASE: 'NYSEAMERICAN',
  BTS: 'BATS',
};

const ETF_NAME = /\b(ETF|SPDR|iShares|ProShares|Direxion|Invesco QQQ)\b/i;

// Sign-up pages for the keyed data sources (opened from Settings).
const KEY_HOSTS = ['finnhub.io', 'twelvedata.com', 'alphavantage.co', 'taapi.io'];

function isAllowedUrl(raw, hosts = ALLOWED_HOSTS) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return false;
    return hosts.some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`)
    );
  } catch {
    return false;
  }
}

/**
 * Everything the row needs for the "open on..." menu.
 * TradingView needs EXCHANGE-TICKER in the path, Yahoo and Investing take the
 * plain symbol (Investing needs the resolved US quote page).
 */
function buildLinks(item) {
  const symbol = encodeURIComponent(item.symbol);

  const tvUrl = item.tvTicker
    ? `https://www.tradingview.com/symbols/${item.tvTicker.replace(':', '-')}/`
    : `https://www.tradingview.com/search/?query=${symbol}`;

  const lower = encodeURIComponent(item.symbol.toLowerCase());
  const dotted = encodeURIComponent(item.symbol.replace(/-/g, '.'));
  const exchange = EXCHANGE_CODES[item.exchange] || null;
  const isEtf = ETF_NAME.test(item.name || '');

  return [
    // Quotes & charts
    { id: 'yahoo', group: 'Quotes & charts', label: 'Yahoo Finance', hint: 'Price, volume, news', url: `https://finance.yahoo.com/quote/${symbol}/` },
    { id: 'tradingview', group: 'Quotes & charts', label: 'TradingView', hint: 'Technical gauge', url: tvUrl },
    {
      id: 'investing',
      group: 'Quotes & charts',
      label: 'Investing.com',
      hint: 'US quote page',
      url: item.investingUrl || `https://www.investing.com/search/?q=${symbol}`,
    },
    {
      id: 'google',
      group: 'Quotes & charts',
      label: 'Google Finance',
      hint: 'Quick overview',
      url: exchange
        ? `https://www.google.com/finance/quote/${dotted}:${exchange}`
        : `https://www.google.com/finance?q=${symbol}`,
    },
    { id: 'barchart', group: 'Quotes & charts', label: 'Barchart', hint: 'Technicals, options', url: `https://www.barchart.com/${isEtf ? 'etfs-funds' : 'stocks'}/quotes/${dotted}/overview` },

    // Research & ratings
    { id: 'zacks', group: 'Research & ratings', label: 'Zacks', hint: 'Zacks Rank, estimates', url: `https://www.zacks.com/${isEtf ? 'funds/etf' : 'stock/quote'}/${dotted}` },
    { id: 'seekingalpha', group: 'Research & ratings', label: 'Seeking Alpha', hint: 'Quant rating, analysis', url: `https://seekingalpha.com/symbol/${dotted}` },
    { id: 'morningstar', group: 'Research & ratings', label: 'Morningstar', hint: 'Fair value, moat', url: `https://www.morningstar.com/search?query=${symbol}` },
    { id: 'finviz', group: 'Research & ratings', label: 'Finviz', hint: 'Fundamentals, insiders', url: `https://finviz.com/quote.ashx?t=${symbol}` },
    {
      id: 'marketbeat',
      group: 'Research & ratings',
      label: 'MarketBeat',
      hint: 'Analyst targets',
      url: exchange
        ? `https://www.marketbeat.com/stocks/${exchange}/${dotted}/`
        : `https://www.marketbeat.com/search/?query=${symbol}`,
    },
    { id: 'stockanalysis', group: 'Research & ratings', label: 'Stock Analysis', hint: 'Financials, history', url: `https://stockanalysis.com/${isEtf ? 'etf' : 'stocks'}/${lower}/` },

    // News & filings
    { id: 'marketwatch', group: 'News & filings', label: 'MarketWatch', hint: 'News, profile', url: `https://www.marketwatch.com/investing/${isEtf ? 'fund' : 'stock'}/${lower}` },
    { id: 'cnbc', group: 'News & filings', label: 'CNBC', hint: 'News, earnings', url: `https://www.cnbc.com/quotes/${dotted}` },
    { id: 'nasdaq', group: 'News & filings', label: 'Nasdaq.com', hint: 'Earnings, dividends', url: `https://www.nasdaq.com/market-activity/${isEtf ? 'etf' : 'stocks'}/${lower}` },
    {
      id: 'sec',
      group: 'News & filings',
      label: 'SEC EDGAR',
      hint: '10-K, 10-Q, 8-K',
      url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${symbol}&owner=include&count=40`,
    },
  ];
}

module.exports = { buildLinks, isAllowedUrl, KEY_HOSTS };
