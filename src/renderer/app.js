'use strict';

const $ = (selector) => document.querySelector(selector);

const SOUND_LABELS = {
  arpeggio: 'Arpeggio',
  chime: 'Chime',
  tick: 'Tick',
  pulse: 'Pulse',
  buzz: 'Buzz',
  digital: 'Digital',
  none: 'None (silent)',
};

// Maps a rating to its key in settings.sounds.
const SOUND_KEYS = {
  'Strong Buy': 'strongBuy',
  Buy: 'buy',
  Neutral: 'neutral',
  Hold: 'neutral',
  Sell: 'sell',
  'Strong Sell': 'strongSell',
};

/*
 * Every column of the main table. The table head, the column menu and the
 * Settings list are all generated from this, so adding a source is one entry.
 *   provider: background source id in row.ext
 *   alert:    can raise a change alert (feed row + optional sound)
 */
const COLUMNS = [
  { id: 'symbol', label: 'Symbol', sort: 'symbol' },
  { id: 'open', label: 'Day open', num: true, sort: 'open' },
  { id: 'price', label: 'Current', num: true, sort: 'price' },
  { id: 'changePct', label: 'Change %', num: true, sort: 'changePct' },
  { id: 'volume', label: 'Volume', num: true, sort: 'volume' },
  { id: 'rating', label: 'TradingView', head: 'TradingView', alert: true, sort: 'rating', desc: 'TradingView technical gauge (daily)' },
  { id: 'analyst', label: 'Analyst', alert: true, sort: 'analyst', desc: 'Analyst consensus via TradingView' },
  { id: 'investing', label: 'Investing.com', provider: 'investing', alert: true, sort: 'investing', desc: 'Investing.com technical summary' },
  { id: 'finnhub', label: 'Finnhub', provider: 'finnhub', alert: true, sort: 'finnhub', desc: 'Finnhub aggregate technical signal' },
  { id: 'twelvedata', label: 'Twelve Data', provider: 'twelvedata', alert: true, sort: 'twelvedata', desc: 'Gauge computed from Twelve Data candles' },
  { id: 'alphavantage', label: 'Alpha Vantage', provider: 'alphavantage', alert: true, sort: 'alphavantage', desc: 'Gauge computed from Alpha Vantage candles' },
  { id: 'taapi', label: 'TAAPI.IO', provider: 'taapi', alert: true, sort: 'taapi', desc: 'Gauge from TAAPI.IO indicator values' },
];

const COLUMN_BY_ID = Object.fromEntries(COLUMNS.map((c) => [c.id, c]));
const DEFAULT_HIDDEN = new Set();
const DEFAULT_SILENT = new Set(['analyst']);

const FEED_COLUMNS = [
  { id: 'time', label: 'Time' },
  { id: 'symbol', label: 'Symbol' },
  { id: 'source', label: 'Source' },
  { id: 'change', label: 'Change' },
  { id: 'price', label: 'Price at change' },
];

const TF_LABELS = {
  '5': '5m', '15': '15m', '30': '30m', '60': '1h', D: '1D',
  '5min': '5m', '15min': '15m', '30min': '30m', '60min': '1h', '1h': '1h', '4h': '4h', '1day': '1D', daily: '1D',
  '5m': '5m', '15m': '15m', '30m': '30m', '1d': '1D',
};

const state = {
  rows: [],
  settings: { intervalMinutes: 10, alertsEnabled: true, sounds: {}, display: {}, alertColumns: {}, providers: {} },
  providers: {},
  sort: { key: null, dir: 1 },
  countdown: 10 * 60,
  popoverSymbol: null,
  searchResults: [],
  searchSeq: 0,
  searchTimer: null,
  adding: false,
  refreshing: false,
  lastInterval: 10,
  changes: [], // today's changes from every source, newest first (owned by main)
  filter: '',
  columnMenuMode: 'table',
  headKey: '',
  stockAlerts: new Set(), // symbols with their own bell on
};

const FEED_SIZES = ['xsmall', 'small', 'medium', 'large', 'xlarge'];

/* ---------- formatting ---------- */

const priceFormatters = new Map();

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
  });
}

function moneyText(value, currency) {
  if (value == null || !Number.isFinite(value)) return '—';
  const code = currency || 'USD';
  if (!priceFormatters.has(code)) {
    priceFormatters.set(
      code,
      new Intl.NumberFormat('en-US', { style: 'currency', currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2 })
    );
  }
  return priceFormatters.get(code).format(value);
}

const fmtPrice = (value, currency) => esc(moneyText(value, currency));

function fmtVolume(value) {
  if (value == null || !Number.isFinite(value)) return '&mdash;';
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(Math.round(value));
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

function ratingOrdinal(rating) {
  const order = { 'Strong Buy': 1, Buy: 2, Neutral: 3, Hold: 3, Sell: 4, 'Strong Sell': 5 };
  return order[rating] || null;
}

function fmtClock(value) {
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function fmtWhen(value) {
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) return '';
  const today = new Date().toDateString() === date.toDateString();
  return today ? fmtClock(value) : `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${fmtClock(value)}`;
}

function tip(lines) {
  const text = lines.filter(Boolean).join('\n');
  return text ? ` title="${esc(text)}"` : '';
}

function cleanError(error) {
  const message = (error && error.message) || String(error || 'Something went wrong');
  return message.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '');
}

/* ---------- columns ---------- */

function tableColumns() {
  return state.settings.display.tableColumns || {};
}

function isVisible(id) {
  const value = tableColumns()[id];
  return typeof value === 'boolean' ? value : !DEFAULT_HIDDEN.has(id);
}

function alertsOn(id) {
  const value = (state.settings.alertColumns || {})[id];
  return typeof value === 'boolean' ? value : !DEFAULT_SILENT.has(id);
}

function stockAlertOn(symbol) {
  return state.stockAlerts.has(symbol);
}

/** A change sounds if its column bell or its stock's bell is on. */
function alertAudible(change) {
  return alertsOn(change.source) || stockAlertOn(change.symbol);
}

function providerTf(provider) {
  const cfg = (state.settings.providers || {})[provider] || {};
  return cfg.tf ? TF_LABELS[cfg.tf] || cfg.tf : '';
}

function headerLabel(col) {
  if (col.provider) {
    const tf = providerTf(col.provider);
    return tf ? `${col.label} ${tf}` : col.label;
  }
  return col.head || col.label;
}

function visibleColumns() {
  return COLUMNS.filter((col) => isVisible(col.id));
}

function buildHead() {
  const cols = visibleColumns();
  const key = cols.map((c) => `${c.id}:${headerLabel(c)}`).join('|');
  if (key === state.headKey) return;
  state.headKey = key;

  $('#gridCols').innerHTML =
    cols.map((c) => `<col data-col="${c.id}" />`).join('') + '<col data-col="remove" />';

  $('#gridHead').innerHTML =
    cols
      .map((c) => {
        const cls = ['sortable', c.num ? 'num' : ''].filter(Boolean).join(' ');
        const bell = c.alert && alertsOn(c.id) ? '<span class="head-bell" aria-hidden="true">&#128276;</span>' : '';
        return `<th scope="col" class="${cls}" data-sort="${c.sort}" data-col="${c.id}"${tip([c.desc])}>${esc(
          headerLabel(c)
        )}${bell}</th>`;
      })
      .join('') +
    '<th scope="col" class="col-remove" data-col="remove"><span class="sr-only">Remove</span></th>';

  setupColumnResizers();
}

/* ---------- cell renderers ---------- */

function providerMeta(id) {
  return (state.providers || {})[id] || {};
}

function recordTip(record, extra = []) {
  const lines = [...extra, ...((record && record.tip) || [])];
  if (record && record.updatedAt) lines.push(`Updated ${fmtWhen(record.updatedAt)}`);
  if (record && record.error) lines.push(`Last attempt failed: ${record.error}`);
  return lines;
}

/** Placeholder pill for a source that has nothing to show yet. */
function placeholder(id, record) {
  const meta = providerMeta(id);
  const cfg = (state.settings.providers || {})[id] || {};
  if (meta.needsKey && !meta.hasKey) {
    return `<span class="pill na needkey" title="Add a ${esc(meta.label || id)} API key in Settings → Data sources">add key</span>`;
  }
  if (cfg.enabled === false) return '<span class="pill na" title="Turned off in Settings → Data sources">off</span>';
  if (!record && cfg.marketHoursOnly && !state.marketOpen) {
    return '<span class="pill na" title="Set to call only during market hours; first update at the next open">closed</span>';
  }
  if (record && record.error) {
    return `<span class="pill na err"${tip([`${meta.label || id}: ${record.error}`])}>error</span>`;
  }
  return `<span class="pill na" title="Waiting for the first update">…</span>`;
}

function ratingPill(rating, lines, extraClass = '') {
  return `<span class="pill ${ratingClass(rating)} ${extraClass}"${tip(lines)}><i></i>${esc(rating)}</span>`;
}

function providerCell(col, row) {
  const record = (row.ext || {})[col.provider];

  if (!record || !record.rating) return placeholder(col.provider, record);
  return ratingPill(record.rating, recordTip(record), record.error ? 'stale' : '');
}

function analystTooltip(row) {
  if (!row.analystRating && row.analystMark == null) return [];
  const lines = ['Analyst consensus (TradingView)'];
  if (row.analystMark != null) lines.push(`Average mark: ${row.analystMark.toFixed(2)} / 5 (1 = Strong Buy)`);
  if (row.priceTarget != null) {
    lines.push(`Average price target: ${moneyText(row.priceTarget, row.currency)}`);
    if (Number.isFinite(row.price) && row.price > 0) {
      const upside = ((row.priceTarget - row.price) / row.price) * 100;
      lines.push(`Implied upside: ${upside > 0 ? '+' : ''}${upside.toFixed(1)}%`);
    }
  }
  return lines;
}

function tvTooltip(row) {
  if (row.ratingError) return [row.ratingError];
  const lines = ['TradingView technical gauge (daily)'];
  if (Number.isFinite(row.ratingScore)) lines.push(`Score ${row.ratingScore.toFixed(2)}`);
  if (Number.isFinite(row.maScore)) lines.push(`Moving averages ${row.maScore.toFixed(2)}`);
  if (Number.isFinite(row.oscScore)) lines.push(`Oscillators ${row.oscScore.toFixed(2)}`);
  return lines;
}

function cellHtml(col, row) {
  switch (col.id) {
    case 'symbol': {
      const exchange = row.quoteError
        ? '<span class="exch warn">offline</span>'
        : row.exchange
          ? `<span class="exch">${esc(row.exchange)}</span>`
          : '';
      const bellOn = stockAlertOn(row.symbol);
      const bell = `<button type="button" class="row-bell${bellOn ? ' on' : ''}" data-bell="${esc(row.symbol)}" aria-pressed="${bellOn}" title="${
        bellOn ? `Alerts on for ${esc(row.symbol)} (every source). Click to turn off.` : `Alert on every rating change for ${esc(row.symbol)}`
      }">&#128276;</button>`;
      return `<td class="cell-symbol">${bell}<button type="button" class="sym" data-symbol="${esc(row.symbol)}" aria-label="Open ${esc(
        row.name
      )} on another site">${esc(row.symbol)}</button>${exchange}</td>`;
    }
    case 'open':
      return `<td class="num">${fmtPrice(row.open, row.currency)}</td>`;
    case 'price':
      return `<td class="num">${fmtPrice(row.price, row.currency)}</td>`;
    case 'changePct': {
      const cls = row.changePct == null ? 'flat' : row.changePct > 0 ? 'up' : row.changePct < 0 ? 'down' : 'flat';
      const text = row.changePct == null ? '&mdash;' : `${row.changePct > 0 ? '+' : ''}${row.changePct.toFixed(2)}%`;
      return `<td class="num"><span class="delta ${cls}">${text}</span></td>`;
    }
    case 'volume':
      return `<td class="num">${fmtVolume(row.volume)}</td>`;
    case 'rating':
      return `<td>${row.rating ? ratingPill(row.rating, tvTooltip(row)) : `<span class="pill na"${tip(tvTooltip(row))}>—</span>`}</td>`;
    case 'analyst':
      return `<td>${
        row.analystRating ? ratingPill(row.analystRating, analystTooltip(row)) : '<span class="pill na">—</span>'
      }</td>`;
    default:
      return `<td>${col.provider ? providerCell(col, row) : ''}</td>`;
  }
}

function rowTemplate(row) {
  const stale = row.quoteError ? ' class="is-stale"' : '';
  const cells = visibleColumns().map((col) => cellHtml(col, row)).join('');
  return `<tr data-symbol="${esc(row.symbol)}"${stale}>${cells}<td><button type="button" class="row-remove" data-remove="${esc(
    row.symbol
  )}" title="Remove ${esc(row.symbol)}">&times;</button></td></tr>`;
}

/* ---------- sorting ---------- */

function sortValue(row, key) {
  const ext = row.ext || {};
  switch (key) {
    case 'symbol':
      return row.symbol;
    case 'rating':
      return row.ratingScore;
    case 'analyst':
      return row.analystMark == null ? null : -row.analystMark;
    default: {
      const col = COLUMN_BY_ID[key];
      if (col && col.provider) {
        const record = ext[col.provider];
        if (!record) return null;
        if (Number.isFinite(record.score)) return record.score;
        const ord = ratingOrdinal(record.rating);
        return ord == null ? null : -ord;
      }
      return row[key];
    }
  }
}

function orderedRows() {
  const { key, dir } = state.sort;
  const query = state.filter.trim().toLowerCase();
  const source = query
    ? state.rows.filter((row) =>
        [row.symbol, row.name, row.exchange].some((value) => String(value || '').toLowerCase().includes(query))
      )
    : state.rows;

  if (!key) return source.slice();

  return source.slice().sort((a, b) => {
    const left = sortValue(a, key);
    const right = sortValue(b, key);
    if (left == null && right == null) return 0;
    if (left == null) return 1;
    if (right == null) return -1;
    if (typeof left === 'string') return left.localeCompare(right) * dir;
    return (left - right) * dir;
  });
}

function applySortIndicators() {
  document.querySelectorAll('.grid th.sortable').forEach((th) => {
    if (state.sort.key === th.dataset.sort) th.dataset.dir = state.sort.dir === 1 ? 'asc' : 'desc';
    else delete th.dataset.dir;
  });
}

/* ---------- auto-fit height ---------- */

let fitQueued = false;

function stageContentHeight() {
  const card = $('.grid-card');
  if (!card) return 0;

  let content = 0;
  const table = $('#grid');
  if (table && !table.classList.contains('hidden')) content += table.offsetHeight;

  const scroll = $('.grid-scroll');
  if (scroll && scroll.scrollWidth > scroll.clientWidth + 1) content += 8;

  const noMatches = $('#noMatches');
  if (noMatches && !noMatches.hidden) content += noMatches.offsetHeight;

  const feed = $('#changeFeed');
  if (feed && !feed.hidden) content += feed.offsetHeight;

  const empty = $('#emptyState');
  if (empty && !empty.classList.contains('hidden')) content += empty.offsetHeight;

  return content + 2;
}

function desiredHeight() {
  const topbar = $('.topbar');
  const stage = $('.stage');
  const stageStyle = getComputedStyle(stage);
  const stagePad = (parseFloat(stageStyle.paddingTop) || 0) + (parseFloat(stageStyle.paddingBottom) || 0);

  let height = topbar.offsetHeight + stagePad + stageContentHeight() + 6;

  const settingsOpen = !$('#settingsModal').hidden;
  const addOpen = !$('#modal').hidden;

  if (settingsOpen) {
    const card = $('#settingsModal .settings-card');
    const style = getComputedStyle(card);
    const head = card.querySelector('.modal-head');
    const body = card.querySelector('.settings-body');
    const bodyGap = parseFloat(getComputedStyle(body).marginTop) || 0;
    const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const content = padding + head.offsetHeight + bodyGap + body.scrollHeight;
    height = Math.max(height, content + 64);
  } else if (addOpen) {
    height = Math.max(height, $('#modal .modal-card').scrollHeight + 72);
  }

  if (!$('#columnMenu').hidden) {
    const menu = $('#columnMenu');
    height = Math.max(height, menu.offsetTop + menu.offsetHeight + 16);
  }

  return Math.ceil(height);
}

function scheduleFit() {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    window.api.fit(desiredHeight());
  });
}

function applyTableSizeClass() {
  const size = state.settings.display.tableSize || 'small';
  document.body.classList.remove('table-xsmall', 'table-small', 'table-medium', 'table-large');
  document.body.classList.add(`table-${size}`);

  const feedSize = FEED_SIZES.includes(state.settings.display.feedSize) ? state.settings.display.feedSize : 'small';
  document.body.classList.remove(...FEED_SIZES.map((s) => `feed-${s}`));
  document.body.classList.add(`feed-${feedSize}`);

  const theme = state.settings.display.theme || 'dark';
  document.body.classList.remove('theme-dark', 'theme-light', 'theme-contrast');
  document.body.classList.add(`theme-${theme}`);
}

/* ---------- column widths ---------- */

function setColumnWidths(widths) {
  const table = $('#grid');
  const map = widths && typeof widths === 'object' ? widths : {};
  const entries = Object.entries(map).filter(([, value]) => Number.isFinite(Number(value)));
  table.classList.toggle('cols-fixed', entries.length > 0);

  let total = 0;
  let missing = 0;
  document.querySelectorAll('#grid colgroup col').forEach((col) => {
    const width = Number(map[col.dataset.col]);
    if (Number.isFinite(width) && width > 0) {
      col.style.width = `${width}px`;
      total += width;
    } else {
      col.style.width = '';
      missing += 1;
    }
  });

  table.style.width = total ? `${Math.round(total + missing * 90)}px` : '';
}

function applyColumnWidths() {
  setColumnWidths(state.settings.display.columnWidths || {});
}

function startColumnResize(event) {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();

  const handle = event.currentTarget;
  const th = handle.closest('th');
  const widths = {};

  document.querySelectorAll('.grid thead th[data-col]').forEach((cell) => {
    widths[cell.dataset.col] = Math.round(cell.getBoundingClientRect().width);
  });

  $('#grid').classList.add('cols-fixed');
  const drag = {
    col: th.dataset.col,
    startX: event.clientX,
    startWidth: widths[th.dataset.col] || 80,
    widths,
    pointerId: event.pointerId,
  };
  setColumnWidths(widths);
  handle.setPointerCapture(event.pointerId);
  document.body.classList.add('col-resizing');

  const onMove = (moveEvent) => {
    if (moveEvent.pointerId !== drag.pointerId) return;
    drag.widths[drag.col] = Math.max(45, Math.min(600, Math.round(drag.startWidth + moveEvent.clientX - drag.startX)));
    setColumnWidths(drag.widths);
  };

  const onUp = () => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    document.body.classList.remove('col-resizing');
    try {
      handle.releasePointerCapture(drag.pointerId);
    } catch {
      // Pointer already released.
    }

    const saved = { ...(state.settings.display.columnWidths || {}) };
    document.querySelectorAll('#grid colgroup col').forEach((col) => {
      const width = parseFloat(col.style.width);
      if (Number.isFinite(width) && width > 0) saved[col.dataset.col] = Math.round(width);
    });
    updateDisplay({ columnWidths: saved });
  };

  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
}

function setupColumnResizers() {
  document.querySelectorAll('.grid thead th[data-col]').forEach((th) => {
    if (th.dataset.col === 'remove' || th.querySelector('.col-resizer')) return;
    const handle = document.createElement('span');
    handle.className = 'col-resizer';
    handle.title = 'Drag to resize column';
    handle.addEventListener('click', (event) => event.stopPropagation());
    handle.addEventListener('pointerdown', startColumnResize);
    th.appendChild(handle);
  });
}

/* ---------- render ---------- */

function renderNoMatches(rowCount, query) {
  const box = $('#noMatches');
  if (state.rows.length > 0 && query && rowCount === 0) {
    box.innerHTML = `No watchlist matches <b>${esc(query)}</b>.`;
    box.hidden = false;
  } else {
    box.hidden = true;
    box.textContent = '';
  }
}

function render() {
  buildHead();
  const rows = orderedRows();
  $('#gridBody').innerHTML = rows.map(rowTemplate).join('');

  const hasRows = state.rows.length > 0;
  $('#grid').classList.toggle('hidden', !hasRows);
  $('#emptyState').classList.toggle('hidden', hasRows);
  renderNoMatches(rows.length, state.filter.trim());

  applySortIndicators();
  applyChangeHighlights();
  renderChangeFeed();
  applyTableSizeClass();
  applyColumnWidths();
  scheduleFit();
}

function updateHeader(payload) {
  const chip = $('#marketChip');
  const hasRows = state.rows.length > 0;
  const open = Boolean(payload && payload.marketOpen);

  if (!hasRows) {
    chip.textContent = 'Idle';
    chip.className = 'chip';
  } else {
    chip.textContent = open ? 'Market open' : 'Market closed';
    chip.className = `chip ${open ? 'open' : 'closed'}`;
  }

  renderIndices(payload && payload.indices);

  const updated = payload && payload.updatedAt ? new Date(payload.updatedAt) : null;
  $('#updated').textContent = updated
    ? `Updated ${updated.toLocaleTimeString('en-US', { hour12: false })}`
    : 'Waiting for data';

  syncSoundButton();
}

function renderIndices(indices) {
  const host = $('#indices');
  host.textContent = '';
  for (const entry of indices || []) {
    const pct = entry.changePct;
    const dir = pct == null ? 'flat' : pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
    const item = document.createElement('span');
    item.className = `index-chip ${dir}`;
    const label = document.createElement('b');
    label.textContent = entry.label;
    const value = document.createElement('span');
    value.className = 'idx-pct';
    value.textContent = pct == null ? '--' : `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
    item.append(label, ' ', value);
    if (entry.price != null) {
      const pts = entry.change == null ? '' : ` (${entry.change > 0 ? '+' : ''}${entry.change.toFixed(2)})`;
      item.title = `${entry.label}: ${entry.price.toLocaleString('en-US', { maximumFractionDigits: 2 })}${pts}`;
    }
    host.append(item);
  }
}

function syncSoundButton() {
  const button = $('#soundBtn');
  button.textContent = state.settings.alertsEnabled ? '\u{1F50A}' : '\u{1F507}';
  button.classList.toggle('muted', !state.settings.alertsEnabled);
  button.title = state.settings.alertsEnabled
    ? 'Alert sounds on (right-click to test)'
    : 'Alert sounds off (right-click to test)';
}

/* ---------- countdown ---------- */

function resetCountdown() {
  state.countdown = Math.max(1, Number(state.settings.intervalMinutes) || 10) * 60;
  renderCountdown();
}

function renderCountdown() {
  const total = Math.max(0, state.countdown);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  $('#countdown').textContent = total > 0 ? `Next ${minutes}:${String(seconds).padStart(2, '0')}` : 'Refreshing…';
}

function tick() {
  if (state.countdown > 0) state.countdown -= 1;
  renderCountdown();
}

/* ---------- toasts ---------- */

function toast(html, kind = '') {
  const item = document.createElement('div');
  item.className = `toast ${kind}`.trim();
  item.innerHTML = html;
  $('#toasts').appendChild(item);
  setTimeout(() => {
    item.style.opacity = '0';
    item.style.transform = 'translateY(6px)';
    item.style.transition = 'opacity .2s, transform .2s';
    setTimeout(() => item.remove(), 220);
  }, 5200);
}

function flashRow(symbol, buy) {
  const row = document.querySelector(`tr[data-symbol="${CSS.escape(symbol)}"]`);
  if (!row) return;
  const cls = buy ? 'flash-buy' : 'flash-sell';
  row.classList.add(cls);
  setTimeout(() => row.classList.remove(cls), 2800);
}

/* ---------- rating changes ---------- */

function changeTone(value) {
  const key = SOUND_KEYS[value];
  if (key === 'strongBuy' || key === 'buy') return 'buy';
  if (key === 'strongSell' || key === 'sell') return 'sell';
  return 'neutral';
}

function changeTime(at) {
  return new Date(Number(at) || Date.now()).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function sourceLabel(source) {
  const col = COLUMN_BY_ID[source];
  return col ? headerLabel(col) : source;
}

// gridBody is rebuilt on every render, so highlights are re-applied after.
// The newest change per symbol decides the row's tone.
function applyChangeHighlights() {
  const seen = new Set();
  for (const change of state.changes) {
    if (seen.has(change.symbol)) continue;
    seen.add(change.symbol);
    const row = document.querySelector(`tr[data-symbol="${CSS.escape(change.symbol)}"]`);
    if (row) row.classList.add('row-changed', `row-changed-${changeTone(change.to)}`);
  }
}

function feedColumns() {
  const cfg = state.settings.display.feedColumns || {};
  return FEED_COLUMNS.filter((c) => cfg[c.id] !== false);
}

function feedCell(colId, change) {
  switch (colId) {
    case 'time':
      return `<span class="fc fc-time">${esc(changeTime(change.at))}</span>`;
    case 'symbol':
      return `<span class="fc fc-symbol">${esc(change.symbol)}</span>`;
    case 'source': {
      const why = stockAlertOn(change.symbol) ? `Sound alerts on for ${change.symbol}` : 'Sound alerts on for this column';
      const bell = alertAudible(change) ? ` <span class="fc-bell" title="${esc(why)}">&#128276;</span>` : '';
      return `<span class="fc fc-source">${esc(sourceLabel(change.source))}${bell}</span>`;
    }
    case 'change':
      return `<span class="fc fc-change"><span class="change-from">${esc(change.from)}</span><span class="change-arrow">&rarr;</span><b>${esc(
        change.to
      )}</b></span>`;
    case 'price':
      return `<span class="fc fc-price">${change.price == null ? '—' : fmtPrice(change.price, change.currency)}</span>`;
    default:
      return '';
  }
}

function renderChangeFeed() {
  const feed = $('#changeFeed');
  const changes = state.changes || [];
  feed.hidden = changes.length === 0;
  $('#changeFeedTitle').textContent = changes.length
    ? `Rating changes · today (${changes.length})`
    : 'Rating changes · today';

  const container = $('#changeFeedItems');
  if (!changes.length) {
    container.innerHTML = '';
    return;
  }

  const cols = feedColumns();
  const template = cols.map((c) => `var(--fc-${c.id})`).join(' ');
  container.style.setProperty('--feed-cols', template || '1fr');

  const head = `<div class="change-item change-head">${cols.map((c) => `<span class="fc">${esc(c.label)}</span>`).join('')}</div>`;
  container.innerHTML =
    head +
    changes
      .map(
        (change) =>
          `<div class="change-item ${changeTone(change.to)}">${cols.map((c) => feedCell(c.id, change)).join('')}</div>`
      )
      .join('');
}

/* ---------- per-stock bell & feed size ---------- */

async function toggleStockAlert(symbol) {
  const on = !stockAlertOn(symbol);
  // Optimistic: flip now, main confirms with a broadcast.
  if (on) state.stockAlerts.add(symbol);
  else state.stockAlerts.delete(symbol);
  render();
  try {
    await window.api.setStockAlert(symbol, on);
    toast(on ? `🔔 Alerts on for <b>${esc(symbol)}</b>` : `Alerts off for <b>${esc(symbol)}</b>`);
  } catch (error) {
    if (on) state.stockAlerts.delete(symbol);
    else state.stockAlerts.add(symbol);
    render();
    toast(esc(cleanError(error)), 'error');
  }
}

async function setFeedSize(size) {
  if (!FEED_SIZES.includes(size)) return;
  await updateDisplay({ feedSize: size });
  applyTableSizeClass();
  applySettingsToControls();
  scheduleFit();
}

function stepFeedSize(delta) {
  const current = FEED_SIZES.indexOf(state.settings.display.feedSize || 'small');
  const next = FEED_SIZES[Math.max(0, Math.min(FEED_SIZES.length - 1, (current < 0 ? 1 : current) + delta))];
  setFeedSize(next);
}

/* ---------- alerts ---------- */

function handleAlerts(alerts) {
  // A burst (e.g. first load of a new source) plays at most a few tones.
  const audible = alerts.filter(alertAudible);
  let played = 0;

  alerts.forEach((alert, index) => {
    const tone = changeTone(alert.to);
    setTimeout(() => {
      const wantsSound = audible.includes(alert) && played < 4;
      if (wantsSound && state.settings.alertsEnabled && alert.marketOpen !== false) {
        played += 1;
        const sounds = state.settings.sounds || {};
        window.Sounds.play(sounds[SOUND_KEYS[alert.to] || 'neutral'] || 'tick');
      }
      if (tone !== 'neutral') flashRow(alert.symbol, tone === 'buy');
    }, index * 700);
  });
}

/* ---------- hover chart ---------- */

const CHART_RANGES = [
  ['1d', '1D'],
  ['5d', '5D'],
  ['1mo', '1M'],
  ['6mo', '6M'],
  ['ytd', 'YTD'],
  ['1y', '1Y'],
  ['5y', '5Y'],
  ['max', 'Max'],
];

// Plot size per "Hover chart size" setting; small is the original size.
const CHART_SIZES = {
  xsmall: { w: 300, h: 120, fs: 9 },
  small: { w: 356, h: 150, fs: 9.5 },
  medium: { w: 460, h: 200, fs: 10.5 },
  large: { w: 580, h: 250, fs: 11.5 },
  xlarge: { w: 720, h: 310, fs: 12.5 },
};

function chartSize() {
  const display = (state.settings && state.settings.display) || {};
  return CHART_SIZES[display.chartSize] || CHART_SIZES.medium;
}

function applyChartSize() {
  const size = chartSize();
  const card = $('#chartCard');
  card.style.width = `${size.w + 24}px`;
  card.style.setProperty('--chart-axis-fs', `${size.fs}px`);
  $('#chartBody').style.height = `${size.h}px`;
}

const chart = {
  symbol: null,
  mx: null,
  my: null,
  range: '1d',
  data: null,
  seq: 0,
  showTimer: null,
  hideTimer: null,
};

try {
  const saved = localStorage.getItem('chartRange');
  if (saved && CHART_RANGES.some(([id]) => id === saved)) chart.range = saved;
} catch {
  // Storage unavailable; keep the default range.
}

function chartWhen(t, range, long = false) {
  const d = new Date(t);
  if (range === '1d') return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (range === '5d' || range === '1mo') {
    return d.toLocaleString('en-US', long
      ? { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function scheduleChart(symbol, anchor) {
  clearTimeout(chart.hideTimer);
  if (!$('#popover').hidden) return;
  if (chart.symbol === symbol && !$('#chartCard').hidden) return;
  // Moving between cells of the same row keeps the pending timer.
  if (chart.pending === symbol && chart.showTimer) return;
  clearTimeout(chart.showTimer);
  chart.pending = symbol;
  chart.showTimer = setTimeout(() => {
    chart.showTimer = null;
    chart.pending = null;
    showChart(symbol, anchor);
  }, 350);
}

function scheduleHideChart() {
  clearTimeout(chart.showTimer);
  chart.showTimer = null;
  chart.pending = null;
  clearTimeout(chart.hideTimer);
  chart.hideTimer = setTimeout(() => hideChart(), 220);
}

function hideChart(now = false) {
  clearTimeout(chart.showTimer);
  chart.showTimer = null;
  chart.pending = null;
  clearTimeout(chart.hideTimer);
  const card = $('#chartCard');
  if (card) card.hidden = true;
  chart.symbol = null;
  if (now) chart.seq += 1;
}

// Default spot is below-right of the pointer; flip left and/or above when
// there is no room, and clamp to the window as a last resort.
function placeChart(anchor) {
  const card = $('#chartCard');
  const rect = anchor.getBoundingClientRect();
  card.hidden = false;
  const width = card.offsetWidth || 380;
  const height = card.offsetHeight || 260;
  const GAP = 14;
  const EDGE = 8;
  const x = Number.isFinite(chart.mx) ? chart.mx : rect.left + 40;
  const y = Number.isFinite(chart.my) ? chart.my : rect.top + rect.height / 2;

  let left = x + GAP;
  if (left + width > window.innerWidth - EDGE) left = x - GAP - width;
  left = Math.min(Math.max(EDGE, left), Math.max(EDGE, window.innerWidth - width - EDGE));

  let top = y + GAP;
  if (top + height > window.innerHeight - EDGE) top = y - GAP - height;
  top = Math.min(Math.max(EDGE, top), Math.max(EDGE, window.innerHeight - height - EDGE));

  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}

function showChart(symbol, anchor) {
  const row = state.rows.find((entry) => entry.symbol === symbol);
  if (!row) return;
  chart.symbol = symbol;
  chart.anchor = anchor;
  $('#chartSymbol').textContent = symbol;
  $('#chartName').textContent = row.name || '';
  $('#chartRanges').innerHTML = CHART_RANGES.map(
    ([id, label]) => `<button type="button" class="chart-range${id === chart.range ? ' active' : ''}" data-range="${id}">${label}</button>`
  ).join('');
  applyChartSize();
  placeChart(anchor);
  loadChart();
}

async function loadChart() {
  const symbol = chart.symbol;
  const range = chart.range;
  if (!symbol) return;
  const seq = ++chart.seq;
  $('#chartBody').innerHTML = '<div class="chart-msg">Loading…</div>';
  $('#chartChange').textContent = '';
  $('#chartFoot').textContent = '';
  try {
    const data = await window.api.chart(symbol, range);
    if (seq !== chart.seq) return;
    chart.data = data;
    drawChart();
  } catch (error) {
    if (seq !== chart.seq) return;
    chart.data = null;
    $('#chartBody').innerHTML = `<div class="chart-msg">${esc(cleanError(error))}</div>`;
  }
}

function drawChart() {
  const data = chart.data;
  const body = $('#chartBody');
  const points = (data && data.points) || [];
  if (points.length < 2) {
    body.innerHTML = '<div class="chart-msg">No chart data for this range.</div>';
    return;
  }

  const { w: W, h: H } = chartSize();
  const PAD_T = 8;
  const PAD_B = 18;
  const PAD_R = 46;
  const plotW = W - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const base = data.previousClose != null ? data.previousClose : points[0].c;
  const last = points[points.length - 1].c;
  let min = Math.min(...points.map((p) => p.c));
  let max = Math.max(...points.map((p) => p.c));
  if (data.previousClose != null) {
    min = Math.min(min, base);
    max = Math.max(max, base);
  }
  if (max === min) {
    max += 1;
    min -= 1;
  }
  const span = max - min;
  min -= span * 0.06;
  max += span * 0.06;

  const x = (i) => (i / (points.length - 1)) * plotW;
  const y = (c) => PAD_T + (1 - (c - min) / (max - min)) * plotH;

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.c).toFixed(1)}`).join('');
  const area = `${line}L${plotW},${PAD_T + plotH}L0,${PAD_T + plotH}Z`;
  const dir = last > base ? 'up' : last < base ? 'down' : 'flat';

  const fmt = (v) => moneyText(v, data.currency);
  const ticks = [max - (max - min) * 0.06, (max + min) / 2, min + (max - min) * 0.06];
  const baseLine =
    data.previousClose != null
      ? `<line class="chart-base" x1="0" x2="${plotW}" y1="${y(base).toFixed(1)}" y2="${y(base).toFixed(1)}" />`
      : '';

  body.innerHTML = `
    <svg class="chart-svg ${dir}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(chart.symbol)} price chart">
      <defs>
        <linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" class="chart-stop-a" />
          <stop offset="100%" class="chart-stop-b" />
        </linearGradient>
      </defs>
      ${ticks
        .map(
          (v) => `<line class="chart-grid" x1="0" x2="${plotW}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" />
          <text class="chart-axis" x="${plotW + 6}" y="${(y(v) + 3.5).toFixed(1)}">${esc(fmt(v))}</text>`
        )
        .join('')}
      ${baseLine}
      <path class="chart-area" d="${area}" fill="url(#chartFill)" />
      <path class="chart-line" d="${line}" />
      <text class="chart-axis" x="0" y="${H - 4}">${esc(chartWhen(points[0].t, data.range))}</text>
      <text class="chart-axis" x="${plotW}" y="${H - 4}" text-anchor="end">${esc(chartWhen(points[points.length - 1].t, data.range))}</text>
      <line class="chart-cross" x1="0" x2="0" y1="${PAD_T}" y2="${PAD_T + plotH}" visibility="hidden" />
      <circle class="chart-dot" r="3.2" cx="0" cy="0" visibility="hidden" />
      <rect class="chart-hit" x="0" y="0" width="${plotW}" height="${H}" fill="transparent" />
    </svg>`;

  const change = last - base;
  const pct = base ? (change / base) * 100 : 0;
  const sign = change > 0 ? '+' : '';
  const label = CHART_RANGES.find(([id]) => id === data.range);
  $('#chartChange').className = `chart-change ${dir}`;
  $('#chartChange').textContent = `${sign}${pct.toFixed(2)}% (${sign}${change.toFixed(2)}) ${label ? label[1] : ''}`;
  const footDefault = `${fmt(last)} · ${chartWhen(points[points.length - 1].t, data.range, true)}`;
  $('#chartFoot').textContent = footDefault;

  const svg = body.querySelector('svg');
  const cross = svg.querySelector('.chart-cross');
  const dot = svg.querySelector('.chart-dot');
  svg.querySelector('.chart-hit').addEventListener('mousemove', (event) => {
    const box = svg.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(points.length - 1, Math.round((px / plotW) * (points.length - 1))));
    const p = points[i];
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', x(i));
    dot.setAttribute('cy', y(p.c));
    dot.setAttribute('visibility', 'visible');
    const d = base ? ((p.c - base) / base) * 100 : 0;
    $('#chartFoot').textContent = `${fmt(p.c)} · ${d > 0 ? '+' : ''}${d.toFixed(2)}% · ${chartWhen(p.t, data.range, true)}`;
  });
  svg.querySelector('.chart-hit').addEventListener('mouseleave', () => {
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    $('#chartFoot').textContent = footDefault;
  });
}

function bindChart() {
  const grid = $('#gridBody');
  grid.addEventListener('mousemove', (event) => {
    chart.mx = event.clientX;
    chart.my = event.clientY;
  });
  grid.addEventListener('mouseover', (event) => {
    chart.mx = event.clientX;
    chart.my = event.clientY;
    const tr = event.target.closest('tr[data-symbol]');
    if (tr) scheduleChart(tr.dataset.symbol, tr);
  });
  grid.addEventListener('mouseout', (event) => {
    const tr = event.target.closest('tr[data-symbol]');
    if (!tr || tr.contains(event.relatedTarget)) return;
    if (event.relatedTarget && event.relatedTarget.closest && event.relatedTarget.closest('#chartCard')) return;
    scheduleHideChart();
  });

  const card = $('#chartCard');
  card.addEventListener('mouseenter', () => {
    clearTimeout(chart.hideTimer);
    clearTimeout(chart.showTimer);
    chart.showTimer = null;
    chart.pending = null;
  });
  card.addEventListener('mouseleave', scheduleHideChart);
  $('#chartRanges').addEventListener('click', (event) => {
    const button = event.target.closest('[data-range]');
    if (!button || button.dataset.range === chart.range) return;
    chart.range = button.dataset.range;
    try {
      localStorage.setItem('chartRange', chart.range);
    } catch {
      // Not critical.
    }
    for (const b of $('#chartRanges').querySelectorAll('[data-range]')) {
      b.classList.toggle('active', b.dataset.range === chart.range);
    }
    loadChart();
  });
  window.addEventListener('resize', () => hideChart(true));
  $('.grid-scroll').addEventListener('scroll', () => hideChart(true));
}

/* ---------- link popover ---------- */

function openPopover(symbol, anchor) {
  const row = state.rows.find((entry) => entry.symbol === symbol);
  if (!row) return;
  closeColumnMenu();

  state.popoverSymbol = symbol;
  hideChart(true);
  $('#popSymbol').textContent = symbol;
  const groups = [];
  for (const link of row.links || []) {
    const name = link.group || 'Links';
    let group = groups.find((entry) => entry.name === name);
    if (!group) groups.push((group = { name, links: [] }));
    group.links.push(link);
  }
  $('#popOptions').innerHTML = groups
    .map(
      (group) => `
      <div class="pop-group">
        <div class="pop-group-name">${esc(group.name)}</div>
        <div class="pop-grid">${group.links
          .map(
            (link) => `
          <button type="button" class="pop-item" data-link="${esc(link.id)}" title="${esc(link.hint || '')}">
            <span class="pop-label">${esc(link.label)}</span>
            <span class="pop-hint">${esc(link.hint || '')}</span>
          </button>`
          )
          .join('')}</div>
      </div>`
    )
    .join('');

  placePopover($('#popover'), anchor.getBoundingClientRect());
  clearTimeout(popoverTimer);
  popoverTimer = setTimeout(closePopover, POPOVER_TIMEOUT_MS);
}

function placePopover(popover, rect) {
  popover.hidden = false;
  const width = popover.offsetWidth || 420;
  const height = popover.offsetHeight || 160;
  let left = rect.left;
  let top = rect.bottom + 8;
  if (left + width > window.innerWidth - 12) left = window.innerWidth - width - 12;
  if (top + height > window.innerHeight - 12) top = Math.max(10, rect.top - height - 8);
  popover.style.left = `${Math.max(10, left)}px`;
  popover.style.top = `${Math.max(10, top)}px`;
}

const POPOVER_TIMEOUT_MS = 60 * 1000;
let popoverTimer = null;

function closePopover() {
  clearTimeout(popoverTimer);
  popoverTimer = null;
  $('#popover').hidden = true;
  state.popoverSymbol = null;
}

async function openLink(linkId) {
  const symbol = state.popoverSymbol;
  closePopover();
  if (!symbol) return;
  try {
    await window.api.openLink(symbol, linkId);
  } catch (error) {
    toast(esc(cleanError(error)), 'error');
  }
}

/* ---------- column chooser (menu + settings) ---------- */

function columnListHtml(mode) {
  if (mode === 'feed') {
    const cfg = state.settings.display.feedColumns || {};
    return FEED_COLUMNS.map(
      (c) => `
      <label class="col-row">
        <input type="checkbox" data-feed-show="${c.id}" ${cfg[c.id] !== false ? 'checked' : ''} />
        <span class="col-name">${esc(c.label)}</span>
      </label>`
    ).join('');
  }

  return COLUMNS.map((c) => {
    const bell = c.alert
      ? `<label class="col-bell" title="Play a sound when ${esc(c.label)} changes"><input type="checkbox" data-col-alert="${c.id}" ${
          alertsOn(c.id) ? 'checked' : ''
        } /><span aria-hidden="true">&#128276;</span></label>`
      : '<span class="col-bell none"></span>';
    return `
      <div class="col-row">
        <label class="col-show"><input type="checkbox" data-col-show="${c.id}" ${isVisible(c.id) ? 'checked' : ''} ${
          c.id === 'symbol' ? 'disabled title="The symbol column is always shown"' : ''
        } /><span class="col-name">${esc(c.label)}</span></label>
        ${bell}
      </div>`;
  }).join('');
}

function syncColumnLists() {
  $('#columnSettings').innerHTML = columnListHtml('table');
  if (!$('#columnMenu').hidden) $('#columnMenuBody').innerHTML = columnListHtml(state.columnMenuMode);
}

function openColumnMenu(mode, rect) {
  closePopover();
  state.columnMenuMode = mode;
  $('#columnMenuTitle').textContent = mode === 'feed' ? 'Feed columns' : 'Columns · show / 🔔 sound';
  $('#columnMenu').classList.toggle('feed-mode', mode === 'feed');
  $('#columnMenuBody').innerHTML = columnListHtml(mode);
  placePopover($('#columnMenu'), rect);
  scheduleFit();
}

function closeColumnMenu() {
  if ($('#columnMenu').hidden) return;
  $('#columnMenu').hidden = true;
  scheduleFit();
}

async function handleColumnToggle(target) {
  if (target.dataset.colShow) {
    await updateDisplay({ tableColumns: { [target.dataset.colShow]: target.checked } });
  } else if (target.dataset.colAlert) {
    await updateSettings({ alertColumns: { [target.dataset.colAlert]: target.checked } });
  } else if (target.dataset.feedShow) {
    await updateDisplay({ feedColumns: { [target.dataset.feedShow]: target.checked } });
  } else {
    return;
  }
  render();
  syncColumnLists();
}

async function handleColumnMenuAction(action) {
  const mode = state.columnMenuMode;
  if (mode === 'feed') {
    const all = Object.fromEntries(FEED_COLUMNS.map((c) => [c.id, true]));
    await updateDisplay({ feedColumns: all });
  } else if (action === 'all') {
    await updateDisplay({ tableColumns: Object.fromEntries(COLUMNS.map((c) => [c.id, true])) });
  } else {
    await updateDisplay({ tableColumns: Object.fromEntries(COLUMNS.map((c) => [c.id, !DEFAULT_HIDDEN.has(c.id)])) });
    await updateSettings({
      alertColumns: Object.fromEntries(COLUMNS.filter((c) => c.alert).map((c) => [c.id, !DEFAULT_SILENT.has(c.id)])),
    });
  }
  render();
  syncColumnLists();
}

/* ---------- data sources (settings) ---------- */

const INTERVAL_CHOICES = [1, 2, 5, 10, 15, 30, 60, 120, 240];

function providerStatusText(id, meta, cfg) {
  if (meta.needsKey && !meta.hasKey) return 'Needs an API key';
  if (cfg.enabled === false) return meta.needsKey ? 'Key saved · tick to turn on' : 'Off';
  const parts = [];
  if (cfg.marketHoursOnly && !state.marketOpen) parts.push('Paused · market closed');
  if (meta.running) parts.push('Updating…');
  if (meta.callsToday != null) parts.push(`${meta.callsToday}${cfg.dailyLimit ? `/${cfg.dailyLimit}` : ''} calls today`);
  if (meta.lastOkAt) parts.push(`OK ${fmtClock(meta.lastOkAt)}`);
  if (meta.blockedUntil) parts.push(`paused to ${fmtClock(meta.blockedUntil)}`);
  return parts.join(' · ') || 'Waiting';
}

const PROVIDER_ORDER = ['finnhub', 'twelvedata', 'alphavantage', 'taapi', 'investing'];

const PROVIDER_NOTES = {
  investing: 'No key needed.',
  finnhub: 'Free key: 60 calls/min.',
  twelvedata: 'Free key: 800 calls/day, 8/min.',
  alphavantage: 'Free key: 25 calls/day.',
  taapi: 'US stocks need the Pro plan.',
};

function providerRowHtml(id) {
  const meta = providerMeta(id);
  const cfg = (state.settings.providers || {})[id] || {};
  const label = meta.label || id;
  const locked = meta.needsKey && !meta.hasKey;
  const on = cfg.enabled === true && !locked;

  const intervals = INTERVAL_CHOICES.includes(Number(cfg.interval))
    ? INTERVAL_CHOICES
    : [...INTERVAL_CHOICES, Number(cfg.interval)].sort((a, b) => a - b);

  const intervalSelect = `<select data-prov-field="interval" data-prov="${id}" title="How often each symbol is refreshed">${intervals
    .map((m) => `<option value="${m}" ${Number(cfg.interval) === m ? 'selected' : ''}>every ${m < 60 ? `${m} min` : `${m / 60} h`}</option>`)
    .join('')}</select>`;

  const tfSelect =
    meta.timeframes && meta.timeframes.length > 1
      ? `<select data-prov-field="tf" data-prov="${id}" title="Candle timeframe">${meta.timeframes
          .map((tf) => `<option value="${esc(tf)}" ${cfg.tf === tf ? 'selected' : ''}>${esc(TF_LABELS[tf] || tf)}</option>`)
          .join('')}</select>`
      : meta.timeframes && meta.timeframes.length === 1
        ? `<span class="prov-fixed">${esc(TF_LABELS[meta.timeframes[0]] || meta.timeframes[0])} timeframe</span>`
        : '';

  const limit =
    cfg.dailyLimit != null
      ? `<label class="prov-limit" title="Stop for the day after this many calls (0 = no cap)">cap <input type="number" min="0" max="100000" step="1" value="${esc(
          cfg.dailyLimit
        )}" data-prov-field="dailyLimit" data-prov="${id}" />/day</label>`
      : '';

  const keyRow = meta.needsKey
    ? `<div class="prov-key${locked ? ' missing' : ''}">
        <input type="password" autocomplete="off" spellcheck="false" placeholder="${
          meta.hasKey ? `Key saved ${esc(meta.keyHint || '')} · paste to replace` : `Paste your ${esc(label)} API key`
        }" data-prov-key="${id}" aria-label="${esc(label)} API key" />
        <button type="button" class="${locked ? 'primary' : 'ghost'} small" data-prov-save="${id}">Save key</button>
        ${
          meta.hasKey
            ? `<button type="button" class="ghost small" data-prov-test="${id}">Test</button><button type="button" class="ghost small icon-only" data-prov-clear="${id}" title="Forget this key">&times;</button>`
            : meta.keyUrl
              ? `<button type="button" class="ghost small" data-prov-getkey="${id}" title="Opens ${esc(meta.keyUrl)} in your browser">Get key &#8599;</button>`
              : ''
        }
      </div>`
    : '';

  const error = meta.lastError && on ? `<div class="prov-error"${tip([meta.lastError])}>${esc(meta.lastError)}</div>` : '';

  return `
    <div class="prov-row${on ? ' is-on' : ''}${locked ? ' is-locked' : ''}" data-prov-row="${id}">
      <div class="prov-top">
        <label class="prov-name"${locked ? ' title="Add an API key first"' : ''}><input type="checkbox" data-prov-field="enabled" data-prov="${id}" ${
          on ? 'checked' : ''
        } ${locked ? 'disabled' : ''} /> ${esc(label)}</label>
        <span class="prov-status">${esc(providerStatusText(id, meta, cfg))}</span>
        ${on ? `<button type="button" class="ghost small icon-only" data-prov-refresh="${id}" title="Refresh every symbol from ${esc(label)} now">&#8635;</button>` : ''}
      </div>
      ${keyRow}
      <div class="prov-opts">${intervalSelect}${tfSelect}${limit}</div>
      <label class="prov-mh" title="Make no calls outside regular US trading hours (Mon–Fri 9:30–16:00 ET)"><input type="checkbox" data-prov-field="marketHoursOnly" data-prov="${id}" ${
        cfg.marketHoursOnly ? 'checked' : ''
      } /> Only call during market hours</label>
      <div class="prov-note">${esc(PROVIDER_NOTES[id] || '')}</div>
      ${error}
    </div>`;
}

function renderProviderSettings() {
  const box = $('#providerSettings');
  if (!box || $('#settingsModal').hidden) return;
  // Don't wipe a key the user is in the middle of typing.
  if (box.contains(document.activeElement) && document.activeElement.matches('input[type=password], input[type=number]')) {
    return;
  }
  box.innerHTML = PROVIDER_ORDER.map(providerRowHtml).join('');
}

async function saveProviderKey(id, value) {
  try {
    const info = await window.api.setProviderKey(id, value);
    state.providers = { ...state.providers, [id]: info };
    toast(
      value
        ? `${esc(info.label)} key saved. Tick <b>${esc(info.label)}</b> to turn it on.`
        : `${esc(info.label)} key removed; source turned off.`
    );
  } catch (error) {
    toast(esc(cleanError(error)), 'error');
  }
  renderProviderSettings();
  render();
}

async function testProvider(id, button) {
  const label = providerMeta(id).label || id;
  button.disabled = true;
  button.textContent = '…';
  try {
    const result = await window.api.testProvider(id);
    toast(`${esc(label)} OK · <b>${esc(result.symbol)}</b>: ${esc(result.rating || 'no rating')}`, 'buy');
  } catch (error) {
    toast(`${esc(label)}: ${esc(cleanError(error))}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Test';
  }
}

/* ---------- add modal ---------- */

function openModal() {
  if (!$('#settingsModal').hidden) closeSettings();
  closeColumnMenu();
  $('#modal').hidden = false;
  $('#searchInput').value = '';
  $('#searchResults').innerHTML = '<div class="results-note">Start typing a ticker or company name.</div>';
  $('#searchStatus').textContent = '';
  state.searchResults = [];
  $('#searchInput').focus();
  window.Sounds.unlock();
  scheduleFit();
}

function closeModal() {
  $('#modal').hidden = true;
  state.searchSeq += 1;
  clearTimeout(state.searchTimer);
  scheduleFit();
}

function renderResults(results) {
  state.searchResults = results;
  const container = $('#searchResults');

  if (!results.length) {
    container.innerHTML = '<div class="results-note">Nothing matched. Try a different ticker or the full company name.</div>';
    return;
  }

  container.innerHTML = results
    .map(
      (result, index) => `
      <button type="button" class="result-item" data-index="${index}">
        <span class="result-sym">${esc(result.symbol)}</span>
        <span class="result-name">${esc(result.name)}</span>
        <span class="badge ${result.isUS ? 'us' : ''}">${esc(result.exchangeDisp || result.exchange || '—')}</span>
      </button>`
    )
    .join('');
}

async function runSearch(term) {
  const query = String(term || '').trim();
  const seq = (state.searchSeq += 1);

  if (!query) {
    state.searchResults = [];
    $('#searchResults').innerHTML = '<div class="results-note">Start typing a ticker or company name.</div>';
    $('#searchStatus').textContent = '';
    return;
  }

  $('#searchStatus').textContent = 'Searching…';

  try {
    const results = await window.api.search(query);
    if (seq !== state.searchSeq) return;
    renderResults(results);
    $('#searchStatus').textContent = results.length ? `${results.length} result${results.length === 1 ? '' : 's'}` : '';
  } catch (error) {
    if (seq !== state.searchSeq) return;
    state.searchResults = [];
    $('#searchResults').innerHTML = `<div class="results-note">Could not search right now. ${esc(cleanError(error))}</div>`;
    $('#searchStatus').textContent = '';
  }
}

async function addCandidate(candidate) {
  if (!candidate || state.adding) return;

  state.adding = true;
  $('#searchStatus').textContent = `Adding ${candidate.symbol}…`;

  try {
    await window.api.add(candidate);
    closeModal();
    toast(`Added <b>${esc(candidate.symbol)}</b>. Fetching its first quote…`);
  } catch (error) {
    toast(esc(cleanError(error)), 'error');
  } finally {
    state.adding = false;
    $('#searchStatus').textContent = '';
  }
}

/* ---------- settings panel ---------- */

function setSegment(selector, value) {
  document.querySelectorAll(`${selector} button`).forEach((button) => {
    const active = button.dataset.bg === value;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function overlayRatingOptions() {
  return COLUMNS.filter((c) => c.alert);
}

function syncOverlayControls(display) {
  const sortSelect = $('#setOverlaySort');
  const ratingSelect = $('#setOverlayRating');
  if (!sortSelect.options.length) {
    const ratings = overlayRatingOptions();
    sortSelect.innerHTML =
      '<option value="none">Watchlist order</option><option value="symbol">Name (symbol)</option>' +
      '<option value="price">Price</option><option value="changePct">Change %</option>' +
      ratings.map((c) => `<option value="${c.id}">${esc(c.label)} rating</option>`).join('');
    ratingSelect.innerHTML = ratings.map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join('');
  }
  const sort = display.overlaySort || 'none';
  sortSelect.value = sort;
  ratingSelect.value = display.overlayRating || 'rating';

  const dirBtn = $('#setOverlayDir');
  const asc = display.overlaySortDir === 'asc';
  dirBtn.disabled = sort === 'none';
  if (sort === 'symbol') dirBtn.innerHTML = asc ? '&#8593; A → Z' : '&#8595; Z → A';
  else if (COLUMN_BY_ID[sort]) dirBtn.innerHTML = asc ? '&#8593; Sell first' : '&#8595; Buy first';
  else dirBtn.innerHTML = asc ? '&#8593; Low first' : '&#8595; High first';
}

function syncSettingsControls() {
  const display = state.settings.display;
  if (!display) return;

  const background = display.overlayBackground || 'none';
  const dim = Math.round((display.overlayDim == null ? 0.45 : display.overlayDim) * 100);
  const width = Number(display.overlayWidth) || 300;
  const margin = Number(display.overlayMargin) || 0;
  const columns = display.overlayColumns || {};

  $('#setOverlayEnabled').checked = Boolean(display.overlayEnabled);
  $('#setAlwaysOnTop').checked = Boolean(display.mainAlwaysOnTop);
  $('#setSounds').checked = state.settings.alertsEnabled !== false;

  setSegment('#setBackground', background);
  $('#dimRow').classList.toggle('hidden', background !== 'dim');
  $('#setDim').value = String(dim);
  $('#dimValue').textContent = `${dim}%`;
  $('#setWidth').value = String(width);
  $('#widthValue').textContent = `${width}px`;
  $('#setMargin').value = String(margin);
  $('#marginValue').textContent = `${margin}px`;
  $('#setCorner').value = display.overlayCorner || 'top-right';

  $('#colPrice').checked = columns.price !== false;
  $('#colChange').checked = columns.change !== false;
  $('#colRating').checked = columns.rating !== false;
  syncOverlayControls(display);

  const theme = display.theme || 'dark';
  document.querySelectorAll('#themeGroup .theme-choice').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
    btn.setAttribute('aria-pressed', String(btn.dataset.theme === theme));
  });

  const tableSize = display.tableSize || 'small';
  document.querySelectorAll('#tableSizeGroup button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.size === tableSize);
  });

  const feedSizeId = display.feedSize || 'small';
  document.querySelectorAll('#feedSizeGroup button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.feedSize === feedSizeId);
  });

  const chartSizeId = display.chartSize || 'medium';
  document.querySelectorAll('#chartSizeGroup button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.chartSize === chartSizeId);
  });

  const sounds = state.settings.sounds || {};
  document.querySelectorAll('#soundList .sound-row').forEach((row) => {
    row.querySelector('.sound-select').value = sounds[row.dataset.key] || 'arpeggio';
  });

  syncColumnLists();
  renderProviderSettings();
  syncSoundButton();
}

function openSettings() {
  if (!$('#modal').hidden) closeModal();
  closePopover();
  closeColumnMenu();
  $('#settingsModal').hidden = false;
  syncSettingsControls();
  scheduleFit();
  window.Sounds.unlock();
}

function closeSettings() {
  $('#settingsModal').hidden = true;
  scheduleFit();
}

async function updateSettings(patch) {
  try {
    const settings = await window.api.setSettings(patch);
    if (settings) state.settings = settings;
    state.headKey = '';
    scheduleFit();
    return settings;
  } catch (error) {
    toast(esc(cleanError(error)), 'error');
    return null;
  }
}

async function updateDisplay(patch) {
  const settings = await updateSettings({ display: patch });
  if (settings && !$('#settingsModal').hidden) {
    // Keep the overlay controls in sync without re-rendering the key inputs.
    syncColumnLists();
  }
  return settings;
}

function populateSoundOptions() {
  document.querySelectorAll('#soundList .sound-row').forEach((row) => {
    const select = row.querySelector('.sound-select');
    if (select.options.length) return;
    select.innerHTML = Object.entries(SOUND_LABELS)
      .map(([value, label]) => `<option value="${value}">${label}</option>`)
      .join('');
  });
}

/* ---------- actions ---------- */

async function manualRefresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  $('#refreshBtn').classList.add('spinning');
  try {
    await window.api.refresh();
  } catch (error) {
    toast(esc(cleanError(error)), 'error');
  } finally {
    state.refreshing = false;
    $('#refreshBtn').classList.remove('spinning');
  }
}

async function toggleSound() {
  state.settings.alertsEnabled = !state.settings.alertsEnabled;
  syncSoundButton();
  await updateSettings({ alertsEnabled: state.settings.alertsEnabled });
}

async function changeInterval(value) {
  const minutes = Number(value);
  const settings = await updateSettings({ intervalMinutes: minutes });
  if (!settings) return;
  state.lastInterval = minutes;
  resetCountdown();
  toast(`Price refresh set to every <b>${minutes} minute${minutes === 1 ? '' : 's'}</b>.`);
}

/* ---------- events ---------- */

function wireEvents() {
  const openAdd = () => openModal();
  $('#addBtn').addEventListener('click', openAdd);
  $('#emptyAddBtn').addEventListener('click', openAdd);
  $('#cancelBtn').addEventListener('click', closeModal);

  $('#modal').addEventListener('click', (event) => {
    if (event.target === $('#modal')) closeModal();
  });

  $('#searchInput').addEventListener('input', (event) => {
    const value = event.target.value;
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => runSearch(value), 220);
  });

  $('#searchInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && state.searchResults.length) {
      event.preventDefault();
      addCandidate(state.searchResults[0]);
    }
  });

  $('#searchResults').addEventListener('click', (event) => {
    const button = event.target.closest('.result-item');
    if (!button) return;
    const result = state.searchResults[Number(button.dataset.index)];
    if (result) addCandidate(result);
  });

  $('#gridBody').addEventListener('click', (event) => {
    const bellBtn = event.target.closest('[data-bell]');
    if (bellBtn) {
      event.stopPropagation();
      toggleStockAlert(bellBtn.dataset.bell);
      return;
    }

    // While the link menu is open, any click in the table just closes it.
    if (!$('#popover').hidden) {
      closePopover();
      const tr = event.target.closest('tr[data-symbol]');
      if (tr) scheduleChart(tr.dataset.symbol, tr);
      return;
    }

    const remove = event.target.closest('[data-remove]');
    if (remove) {
      const symbol = remove.dataset.remove;
      window.api
        .remove(symbol)
        .then((removed) => {
          if (removed) {
            toast(`Removed <b>${esc(symbol)}</b>.`);
            scheduleFit();
          }
        })
        .catch((error) => toast(esc(cleanError(error)), 'error'));
      return;
    }

    const symbolButton = event.target.closest('.sym');
    if (symbolButton) {
      openPopover(symbolButton.dataset.symbol, symbolButton);
      return;
    }

    const row = event.target.closest('tr[data-symbol]');
    if (row) openPopover(row.dataset.symbol, row.querySelector('.sym') || row);
  });

  $('#popOptions').addEventListener('click', (event) => {
    const button = event.target.closest('[data-link]');
    if (button) openLink(button.dataset.link);
  });

  // Sorting and the column menu are delegated: the header is rebuilt whenever
  // the visible columns change.
  $('#gridHead').addEventListener('click', (event) => {
    const th = event.target.closest('th.sortable');
    if (!th) return;
    const key = th.dataset.sort;
    if (state.sort.key === key) state.sort.dir = state.sort.dir === 1 ? -1 : 1;
    else {
      state.sort.key = key;
      state.sort.dir = key === 'symbol' ? 1 : -1;
    }
    render();
  });

  $('#gridHead').addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openColumnMenu('table', { left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY });
  });

  $('#columnsBtn').addEventListener('click', (event) => {
    event.stopPropagation();
    if (!$('#columnMenu').hidden && state.columnMenuMode === 'table') closeColumnMenu();
    else openColumnMenu('table', event.currentTarget.getBoundingClientRect());
  });

  $('#feedColumnsBtn').addEventListener('click', (event) => {
    event.stopPropagation();
    if (!$('#columnMenu').hidden && state.columnMenuMode === 'feed') closeColumnMenu();
    else openColumnMenu('feed', event.currentTarget.getBoundingClientRect());
  });

  $('#feedClearBtn').addEventListener('click', async () => {
    try {
      await window.api.clearChanges();
    } catch (error) {
      toast(esc(cleanError(error)), 'error');
    }
  });

  $('#feedSmallerBtn').addEventListener('click', () => stepFeedSize(-1));
  $('#feedLargerBtn').addEventListener('click', () => stepFeedSize(1));

  $('#feedSizeGroup').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-feed-size]');
    if (btn) setFeedSize(btn.dataset.feedSize);
  });

  $('#exportBtn').addEventListener('click', async () => {
    try {
      const result = await window.api.exportData();
      if (result) toast(`Exported <b>${result.count}</b> symbol${result.count === 1 ? '' : 's'} to ${esc(result.filePath)}`);
    } catch (error) {
      toast(esc(cleanError(error)), 'error');
    }
  });

  $('#importBtn').addEventListener('click', async () => {
    try {
      const result = await window.api.importData();
      if (!result) return;
      const what = result.replaced
        ? `Watchlist replaced: <b>${result.total}</b> symbols`
        : `Added <b>${result.added}</b> new symbol${result.added === 1 ? '' : 's'}`;
      toast(`${what}${result.settings ? ', settings applied' : ''}. Fetching prices…`);
      if (result.settings) applySettingsToControls();
    } catch (error) {
      toast(esc(cleanError(error)), 'error');
    }
  });

  $('#columnMenu').addEventListener('change', (event) => handleColumnToggle(event.target));
  $('#columnSettings').addEventListener('change', (event) => handleColumnToggle(event.target));
  $('#columnMenu').addEventListener('click', (event) => {
    const action = event.target.closest('[data-colmenu]');
    if (action) handleColumnMenuAction(action.dataset.colmenu);
  });

  document.addEventListener('click', (event) => {
    const popover = $('#popover');
    if (!popover.hidden && !popover.contains(event.target) && !event.target.closest('#gridBody')) closePopover();

    const menu = $('#columnMenu');
    if (!menu.hidden && !menu.contains(event.target) && !event.target.closest('#columnsBtn, #feedColumnsBtn')) {
      closeColumnMenu();
    }
  });

  window.addEventListener('resize', () => {
    closePopover();
    closeColumnMenu();
  });
  $('.grid-scroll').addEventListener('scroll', closePopover);

  /* data sources */

  const providers = $('#providerSettings');

  providers.addEventListener('change', (event) => {
    const field = event.target.dataset.provField;
    const id = event.target.dataset.prov;
    if (!field || !id) return;
    let value;
    if (field === 'enabled' || field === 'marketHoursOnly') value = event.target.checked;
    else if (field === 'tf') value = event.target.value;
    else value = Number(event.target.value);
    updateSettings({ providers: { [id]: { [field]: value } } }).then(() => {
      renderProviderSettings();
      render();
    });
  });

  providers.addEventListener('click', (event) => {
    const save = event.target.closest('[data-prov-save]');
    if (save) {
      const id = save.dataset.provSave;
      const input = providers.querySelector(`[data-prov-key="${id}"]`);
      const value = input ? input.value.trim() : '';
      if (!value) {
        toast('Paste a key first.', 'error');
        return;
      }
      if (input) {
        input.value = '';
        input.blur();
      }
      saveProviderKey(id, value);
      return;
    }
    const clear = event.target.closest('[data-prov-clear]');
    if (clear) {
      saveProviderKey(clear.dataset.provClear, '');
      return;
    }
    const getKey = event.target.closest('[data-prov-getkey]');
    if (getKey) {
      window.api.openKeyPage(getKey.dataset.provGetkey).catch((error) => toast(esc(cleanError(error)), 'error'));
      return;
    }
    const test = event.target.closest('[data-prov-test]');
    if (test) {
      testProvider(test.dataset.provTest, test);
      return;
    }
    const refresh = event.target.closest('[data-prov-refresh]');
    if (refresh) {
      window.api
        .refreshProvider(refresh.dataset.provRefresh)
        .then(() => toast(`Refreshing ${esc(providerMeta(refresh.dataset.provRefresh).label || '')}…`))
        .catch((error) => toast(esc(cleanError(error)), 'error'));
    }
  });

  providers.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.dataset.provKey) {
      event.preventDefault();
      const value = event.target.value.trim();
      event.target.value = '';
      event.target.blur();
      if (value) saveProviderKey(event.target.dataset.provKey, value);
    }
  });

  /* toolbar */

  $('#refreshBtn').addEventListener('click', manualRefresh);
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#closeSettingsBtn').addEventListener('click', closeSettings);

  $('#settingsModal').addEventListener('click', (event) => {
    if (event.target === $('#settingsModal')) closeSettings();
  });

  $('#soundBtn').addEventListener('click', toggleSound);
  $('#soundBtn').addEventListener('contextmenu', (event) => {
    event.preventDefault();
    window.Sounds.previewAll(state.settings.sounds || {});
    toast('Previewing each rating sound in order: Strong Buy to Strong Sell.');
  });

  $('#soundList').addEventListener('change', (event) => {
    const select = event.target.closest('.sound-select');
    if (!select) return;
    updateSettings({ sounds: { [select.closest('.sound-row').dataset.key]: select.value } });
  });

  $('#soundList').addEventListener('click', (event) => {
    const button = event.target.closest('.sound-preview');
    if (!button) return;
    window.Sounds.unlock();
    window.Sounds.play(button.closest('.sound-row').querySelector('.sound-select').value);
  });

  /* watchlist search */

  const watchSearch = $('#watchSearch');
  const clearSearch = $('#clearWatchSearch');

  const applyFilter = () => {
    state.filter = watchSearch.value;
    clearSearch.hidden = watchSearch.value.length === 0;
    render();
  };

  watchSearch.addEventListener('input', applyFilter);
  watchSearch.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      watchSearch.value = '';
      applyFilter();
      watchSearch.blur();
    } else if (event.key === 'Enter') {
      event.preventDefault();
    }
  });

  clearSearch.addEventListener('click', () => {
    watchSearch.value = '';
    applyFilter();
    watchSearch.focus();
  });

  $('#resetColWidthsBtn').addEventListener('click', async () => {
    await updateDisplay({ columnWidths: {} });
    applyColumnWidths();
    scheduleFit();
  });

  $('#tableSizeGroup').addEventListener('click', (event) => {
    const btn = event.target.closest('button');
    if (!btn) return;
    updateDisplay({ tableSize: btn.dataset.size }).then(() => {
      syncSettingsControls();
      render();
    });
  });

  $('#chartSizeGroup').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-chart-size]');
    if (!btn) return;
    hideChart(true);
    updateDisplay({ chartSize: btn.dataset.chartSize }).then(syncSettingsControls);
  });

  $('#intervalSelect').addEventListener('change', (event) => changeInterval(event.target.value));

  /* overlay & window settings */

  $('#setOverlayEnabled').addEventListener('change', (event) => updateDisplay({ overlayEnabled: event.target.checked }));
  $('#setAlwaysOnTop').addEventListener('change', (event) => updateDisplay({ mainAlwaysOnTop: event.target.checked }));

  $('#setSounds').addEventListener('change', async (event) => {
    await updateSettings({ alertsEnabled: event.target.checked });
    syncSoundButton();
  });

  $('#setBackground').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-bg]');
    if (!button) return;
    const background = button.dataset.bg;
    setSegment('#setBackground', background);
    $('#dimRow').classList.toggle('hidden', background !== 'dim');
    updateDisplay({ overlayBackground: background });
  });

  $('#setDim').addEventListener('input', (event) => {
    $('#dimValue').textContent = `${event.target.value}%`;
  });
  $('#setDim').addEventListener('change', (event) => updateDisplay({ overlayDim: Number(event.target.value) / 100 }));

  $('#setWidth').addEventListener('input', (event) => {
    $('#widthValue').textContent = `${event.target.value}px`;
  });
  $('#setWidth').addEventListener('change', (event) => updateDisplay({ overlayWidth: Number(event.target.value) }));

  $('#setMargin').addEventListener('input', (event) => {
    $('#marginValue').textContent = `${event.target.value}px`;
  });
  $('#setMargin').addEventListener('change', (event) => updateDisplay({ overlayMargin: Number(event.target.value) }));

  $('#setOverlaySort').addEventListener('change', (event) => {
    const value = event.target.value;
    // Names read naturally A→Z; ratings and numbers best/highest first.
    updateDisplay({ overlaySort: value, overlaySortDir: value === 'symbol' ? 'asc' : 'desc' }).then(syncSettingsControls);
  });
  $('#setOverlayDir').addEventListener('click', () => {
    const dir = state.settings.display.overlaySortDir === 'asc' ? 'desc' : 'asc';
    updateDisplay({ overlaySortDir: dir }).then(syncSettingsControls);
  });
  $('#setOverlayRating').addEventListener('change', (event) =>
    updateDisplay({ overlayRating: event.target.value }).then(syncSettingsControls)
  );

  $('#themeGroup').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-theme]');
    if (!btn) return;
    updateDisplay({ theme: btn.dataset.theme }).then(() => {
      applyTableSizeClass();
      syncSettingsControls();
    });
  });

  $('#setCorner').addEventListener('change', (event) => updateDisplay({ overlayCorner: event.target.value }));

  const overlayPatch = () => ({
    overlayColumns: {
      price: $('#colPrice').checked,
      change: $('#colChange').checked,
      rating: $('#colRating').checked,
    },
  });
  ['#colPrice', '#colChange', '#colRating'].forEach((selector) => {
    $(selector).addEventListener('change', () => updateDisplay(overlayPatch()));
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!$('#columnMenu').hidden) closeColumnMenu();
      else if (!$('#settingsModal').hidden) closeSettings();
      else if (!$('#modal').hidden) closeModal();
      else {
        closePopover();
        hideChart(true);
      }
    }
    if (event.key.toLowerCase() === 'r' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      manualRefresh();
    }
    if (event.key.toLowerCase() === 'n' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      openModal();
    }
    if (event.key.toLowerCase() === 'f' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      $('#watchSearch').focus();
      $('#watchSearch').select();
    }
  });
}

/* ---------- boot ---------- */

function applySettingsToControls() {
  const select = $('#intervalSelect');
  const minutes = Number(state.settings.intervalMinutes) || 10;

  if (![...select.options].some((option) => Number(option.value) === minutes)) {
    const option = document.createElement('option');
    option.value = String(minutes);
    option.textContent = `${minutes} min`;
    select.appendChild(option);
  }
  select.value = String(minutes);
  state.lastInterval = minutes;
  syncSoundButton();
  syncSettingsControls();
}

function applySettings(settings) {
  if (!settings) return;
  const nextInterval = Number(settings.intervalMinutes) || 10;
  state.settings = settings;
  state.headKey = '';
  applyTableSizeClass();

  if (nextInterval !== state.lastInterval) {
    state.lastInterval = nextInterval;
    applySettingsToControls();
    resetCountdown();
  }
}

// Reasons that are not a price refresh and must not restart the countdown.
const PASSIVE_REASONS = new Set(['links', 'extras', 'providers', 'changes', 'remove', 'stockAlerts']);

function handleUpdate(payload) {
  state.rows = payload.rows || [];
  if (payload.settings) applySettings(payload.settings);
  if (payload.providers) state.providers = payload.providers;
  if (Array.isArray(payload.changes)) state.changes = payload.changes;
  if (Array.isArray(payload.stockAlerts)) state.stockAlerts = new Set(payload.stockAlerts);
  if (typeof payload.marketOpen === 'boolean') state.marketOpen = payload.marketOpen;

  if (!PASSIVE_REASONS.has(payload.reason)) resetCountdown();

  updateHeader(payload);
  render();
  renderProviderSettings();
  handleAlerts(payload.alerts || []);
}

async function boot() {
  populateSoundOptions();
  applyTableSizeClass();
  wireEvents();
  bindChart();

  // Subscribe before the first read so a startup update cannot slip past us.
  window.api.onRows(handleUpdate);
  window.api.onSettings(applySettings);
  setInterval(tick, 1000);

  try {
    const initial = await window.api.init();
    state.rows = initial.rows || [];
    if (initial.settings) state.settings = initial.settings;
    if (initial.providers) state.providers = initial.providers;
    if (Array.isArray(initial.changes)) state.changes = initial.changes;
    if (Array.isArray(initial.stockAlerts)) state.stockAlerts = new Set(initial.stockAlerts);
    state.marketOpen = Boolean(initial.marketOpen);
    applySettingsToControls();
    updateHeader(initial);
    resetCountdown();
    render();
  } catch (error) {
    toast(esc(cleanError(error)), 'error');
  }
}

boot();
