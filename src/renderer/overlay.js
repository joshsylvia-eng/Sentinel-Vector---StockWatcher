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
      return 'n';
    case 'Sell':
      return 's';
    case 'Strong Sell':
      return 'ss';
    default:
      return 'na';
  }
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
    parts.push(
      `<span class="ov-pill ${ratingClass(row.rating)}"><i></i>${esc(row.rating || '—')}</span>`
    );
  }

  return `<div class="ov-row">${parts.join('')}</div>`;
}

function applyBackground() {
  const display = settings.display || {};
  const background = display.overlayBackground || 'none';

  document.body.classList.remove('bg-none', 'bg-dim', 'bg-solid');
  document.body.classList.add(`bg-${background}`);
  document.body.style.setProperty('--ov-dim', String(display.overlayDim ?? 0.45));
}

function render() {
  $('#overlayRows').innerHTML = rows.map(rowHtml).join('');
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
