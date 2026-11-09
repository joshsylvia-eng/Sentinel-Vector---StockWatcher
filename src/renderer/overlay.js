'use strict';

/*
 * The floating overlay is a read-only heads-up display. The window itself is
 * click-through, so nothing here is interactive by design.
 */

const $ = (selector) => document.querySelector(selector);

let settings = {
  display: {
    overlayBackground: 'none',
    overlayDim: 0.45,
    overlayColumns: { price: true, change: true, rating: true },
  },
};

let rows = [];

const priceFormatters = new Map();

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
  });
}

function fmtPrice(value, currency) {
  if (value == null || !Number.isFinite(value)) return '&mdash;';
  const code = currency || 'USD';
  if (!priceFormatters.has(code)) {
    priceFormatters.set(
      code,
      new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: code,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    );
  }
  return esc(priceFormatters.get(code).format(value));
}

function ratingClass(rating) {
  switch (rating) {
    case 'Strong Buy':
      return 'sb';
    case 'Buy':
      return 'b';
    case 'Neutral':
    case 'Hold':
      return 'n';
    case 'Sell':
      return 's';
    case 'Strong Sell':
      return 'ss';
    default:
      return 'na';
  }
}

const RATING_SCORE = { 'Strong Buy': 1, Buy: 0.5, Neutral: 0, Hold: 0, Sell: -0.5, 'Strong Sell': -1 };

/** The rating a given table column shows for this row. */
function ratingFor(row, column) {
  if (column === 'rating') return row.rating || null;
  if (column === 'analyst') return row.analystRating || null;
  const record = (row.ext || {})[column];
  return (record && record.rating) || null;
}

function scoreFor(row, column) {
  if (column === 'rating' && Number.isFinite(row.ratingScore)) return row.ratingScore;
  const record = (row.ext || {})[column];
  if (record && Number.isFinite(record.score)) return record.score;
  const rating = ratingFor(row, column);
  return rating in RATING_SCORE ? RATING_SCORE[rating] : null;
}

function sortedRows() {
  const display = settings.display || {};
  const key = display.overlaySort || 'none';
  if (key === 'none') return rows;
  const dir = display.overlaySortDir === 'asc' ? 1 : -1;

  const value = (row) => {
    if (key === 'symbol') return row.symbol;
    if (key === 'price' || key === 'changePct') return Number.isFinite(row[key]) ? row[key] : null;
    return scoreFor(row, key);
  };

  return rows.slice().sort((a, b) => {
    const left = value(a);
    const right = value(b);
    if (left == null && right == null) return a.symbol.localeCompare(b.symbol);
    if (left == null) return 1; // unrated rows always sink to the bottom
    if (right == null) return -1;
    if (typeof left === 'string') return left.localeCompare(right) * dir;
    return (left - right) * dir || a.symbol.localeCompare(b.symbol);
  });
}

function rowHtml(row) {
  const columns = (settings.display && settings.display.overlayColumns) || {};

  const changeClass =
    row.changePct == null ? 'flat' : row.changePct > 0 ? 'up' : row.changePct < 0 ? 'down' : 'flat';
  const changeText =
    row.changePct == null
      ? '&mdash;'
      : `${row.changePct > 0 ? '+' : ''}${row.changePct.toFixed(2)}%`;

  const parts = [`<span class="ov-sym">${esc(row.symbol)}</span>`];

  if (columns.price !== false) {
    parts.push(`<span class="ov-price">${fmtPrice(row.price, row.currency)}</span>`);
  }
  if (columns.change !== false) {
    parts.push(`<span class="ov-delta ${changeClass}">${changeText}</span>`);
  }
  if (columns.rating !== false) {
    const rating = ratingFor(row, (settings.display && settings.display.overlayRating) || 'rating');
    parts.push(`<span class="ov-pill ${ratingClass(rating)}"><i></i>${esc(rating || '—')}</span>`);
  }

  return `<div class="ov-row">${parts.join('')}</div>`;
}

function applyBackground() {
  const display = settings.display || {};
  const background = display.overlayBackground || 'none';

  document.body.classList.remove('bg-none', 'bg-dim', 'bg-solid');
  document.body.classList.add(`bg-${background}`);
  document.body.style.setProperty('--ov-dim', String(display.overlayDim ?? 0.45));
  // Only the colour-blind palette carries over: the overlay floats over other
  // apps, so the light theme's dark-on-white text would be unreadable there.
  document.body.classList.toggle('theme-contrast', display.theme === 'contrast');
}

function render() {
  $('#overlayRows').innerHTML = sortedRows().map(rowHtml).join('');
  $('#overlayEmpty').classList.toggle('hidden', rows.length > 0);
  applyBackground();

  // The window hugs its content; the main process resizes it to match. Measure
  // the panel itself, because `body.scrollHeight` is never smaller than the
  // current viewport and so could never shrink the window.
  requestAnimationFrame(() => {
    const panel = document.querySelector('.overlay');
    const height = Math.ceil(panel.getBoundingClientRect().height) + 2;
    window.api.fitOverlay(height);
  });
}

window.api.onRows((payload) => {
  if (payload.settings) settings = payload.settings;
  rows = payload.rows || [];
  render();
});

window.api.onSettings((next) => {
  settings = next;
  render();
});

(async () => {
  try {
    const initial = await window.api.init();
    if (initial.settings) settings = initial.settings;
    rows = initial.rows || [];
  } catch {
    rows = [];
  }
  render();
})();
