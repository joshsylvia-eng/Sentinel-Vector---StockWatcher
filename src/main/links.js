'use strict';

const ALLOWED_HOSTS = ['yahoo.com', 'investing.com', 'tradingview.com', 'zacks.com'];

function isAllowedUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return false;
    return ALLOWED_HOSTS.some(
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

  return [
    { id: 'yahoo', label: 'Yahoo Finance', hint: 'Price, volume, news', url: `https://finance.yahoo.com/quote/${symbol}/` },
    {
      id: 'investing',
      label: 'Investing.com',
      hint: 'US quote page',
      url: item.investingUrl || `https://www.investing.com/search/?q=${symbol}`,
    },
    { id: 'tradingview', label: 'TradingView', hint: 'Technical gauge', url: tvUrl },
    { id: 'zacks', label: 'Zacks', hint: 'Estimates, ratings & research', url: `https://www.zacks.com/stock/quote/${symbol}` },
  ];
}

module.exports = { buildLinks, isAllowedUrl };
