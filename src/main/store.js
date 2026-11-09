'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/*
 * Column ids for the main table. Order here is the default display order.
 * Columns with an `alert` default can raise a change alert (feed row + sound).
 */
const TABLE_COLUMNS = [
  { id: 'symbol', on: true },
  { id: 'open', on: true },
  { id: 'price', on: true },
  { id: 'changePct', on: true },
  { id: 'volume', on: true },
  { id: 'rating', on: true, alert: true }, // TradingView technical
  { id: 'analyst', on: true, alert: false },
  { id: 'investing', on: true, alert: true },
  { id: 'finnhub', on: true, alert: true },
  { id: 'twelvedata', on: true, alert: true },
  { id: 'alphavantage', on: true, alert: true },
  { id: 'taapi', on: true, alert: true },
];

const ALERT_COLUMNS = TABLE_COLUMNS.filter((c) => 'alert' in c);

const FEED_COLUMNS = ['time', 'symbol', 'source', 'change', 'price'];

const PROVIDER_DEFAULTS = {
  investing: { enabled: true, interval: 30, tf: '30m', marketHoursOnly: false },
  // Keyed sources start off; they are switched on once a key is saved and ticked.
  finnhub: { enabled: false, interval: 10, tf: '30', marketHoursOnly: true },
  twelvedata: { enabled: false, interval: 30, tf: '30min', dailyLimit: 800, marketHoursOnly: true },
  alphavantage: { enabled: false, interval: 120, tf: '30min', dailyLimit: 25, marketHoursOnly: true },
  taapi: { enabled: false, interval: 30, tf: '30m', marketHoursOnly: true },
};

const PROVIDER_TIMEFRAMES = {
  investing: ['30m'],
  finnhub: ['5', '15', '30', '60', 'D'],
  twelvedata: ['5min', '15min', '30min', '1h', '4h', '1day'],
  alphavantage: ['15min', '30min', '60min', 'daily'],
  taapi: ['5m', '15m', '30m', '1h', '4h', '1d'],
};

const DISPLAY_DEFAULTS = {
  overlayEnabled: false,
  overlayBackground: 'none',
  overlayDim: 0.45,
  overlayWidth: 300,
  overlayCorner: 'top-right',
  overlayMargin: 24,
  overlayColumns: { price: true, change: true, rating: true },
  overlaySort: 'none', // 'none' (watchlist order), 'symbol', 'price', 'changePct' or a rating column id
  overlaySortDir: 'desc',
  overlayRating: 'rating', // which rating column the overlay pill shows
  theme: 'dark', // dark | light | contrast
  mainAlwaysOnTop: false,
  tableSize: 'small', // xsmall (8pt), small (10pt), medium (12pt), large (14pt)
  chartSize: 'medium', // hover chart: xsmall, small, medium, large, xlarge
  feedSize: 'small', // rating-change feed text: xsmall, small, medium, large, xlarge
  tableColumns: Object.fromEntries(TABLE_COLUMNS.map((c) => [c.id, c.on])),
  feedColumns: Object.fromEntries(FEED_COLUMNS.map((id) => [id, true])),
};

const SOUND_IDS = ['arpeggio', 'chime', 'tick', 'pulse', 'buzz', 'digital', 'none'];

const SOUND_DEFAULTS = {
  strongBuy: 'arpeggio',
  buy: 'chime',
  neutral: 'tick',
  sell: 'pulse',
  strongSell: 'buzz',
};

const ALERT_DEFAULTS = Object.fromEntries(ALERT_COLUMNS.map((c) => [c.id, c.alert]));

const RATING_IDS = ALERT_COLUMNS.map((c) => c.id);
const OVERLAY_SORTS = ['none', 'symbol', 'price', 'changePct', ...RATING_IDS];
const THEMES = ['dark', 'light', 'contrast'];

const FEED_SIZES = ['xsmall', 'small', 'medium', 'large', 'xlarge'];

const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const BACKGROUNDS = ['none', 'dim', 'solid'];

let filePath = null;

function init(directory) {
  fs.mkdirSync(directory, { recursive: true });
  filePath = path.join(directory, 'watchlist.json');
  migrateLegacyData();
}

function migrateLegacyData() {
  try {
    if (fs.existsSync(filePath)) return;
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const legacyPath = path.join(appData, 'StockWatch', 'watchlist.json');
    if (!fs.existsSync(legacyPath)) return;
    fs.copyFileSync(legacyPath, filePath);
  } catch {
    // Best-effort migration only.
  }
}

function normalizeColumnWidths(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const widths = {};
  for (const [key, value] of Object.entries(source)) {
    const width = Number(value);
    if (Number.isFinite(width) && width >= 40 && width <= 600) widths[key] = Math.round(width);
  }
  return widths;
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (value == null || value === '' || !Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function boolMap(raw, defaults) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    out[key] = typeof source[key] === 'boolean' ? source[key] : fallback;
  }
  return out;
}

function normalizeDisplay(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const columns = source.overlayColumns && typeof source.overlayColumns === 'object' ? source.overlayColumns : {};

  return {
    overlayEnabled: source.overlayEnabled === true,
    overlayBackground: BACKGROUNDS.includes(source.overlayBackground) ? source.overlayBackground : 'none',
    overlayDim: clamp(source.overlayDim, 0.1, 0.9, 0.45),
    overlayWidth: Math.round(clamp(source.overlayWidth, 240, 520, 300)),
    overlayCorner: CORNERS.includes(source.overlayCorner) ? source.overlayCorner : 'top-right',
    overlayMargin: Math.round(clamp(source.overlayMargin, 0, 80, 24)),
    overlayColumns: {
      price: columns.price !== false,
      change: columns.change !== false,
      rating: columns.rating !== false,
    },
    overlaySort: OVERLAY_SORTS.includes(source.overlaySort) ? source.overlaySort : 'none',
    overlaySortDir: source.overlaySortDir === 'asc' ? 'asc' : 'desc',
    overlayRating: RATING_IDS.includes(source.overlayRating) ? source.overlayRating : 'rating',
    theme: THEMES.includes(source.theme) ? source.theme : 'dark',
    mainAlwaysOnTop: source.mainAlwaysOnTop === true,
    tableSize: ['xsmall', 'small', 'medium', 'large'].includes(source.tableSize) ? source.tableSize : 'small',
    chartSize: ['xsmall', 'small', 'medium', 'large', 'xlarge'].includes(source.chartSize) ? source.chartSize : 'medium',
    feedSize: FEED_SIZES.includes(source.feedSize) ? source.feedSize : 'small',
    columnWidths: normalizeColumnWidths(source.columnWidths),
    tableColumns: boolMap(source.tableColumns, DISPLAY_DEFAULTS.tableColumns),
    feedColumns: boolMap(source.feedColumns, DISPLAY_DEFAULTS.feedColumns),
  };
}

function normalizeProviders(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const [id, defaults] of Object.entries(PROVIDER_DEFAULTS)) {
    const value = source[id] && typeof source[id] === 'object' ? source[id] : {};
    const cfg = {
      enabled: typeof value.enabled === 'boolean' ? value.enabled : defaults.enabled,
      interval: Math.round(clamp(value.interval, 1, 1440, defaults.interval)),
      marketHoursOnly: typeof value.marketHoursOnly === 'boolean' ? value.marketHoursOnly : defaults.marketHoursOnly,
    };
    if ('tf' in defaults) {
      const allowed = PROVIDER_TIMEFRAMES[id];
      cfg.tf = allowed && allowed.includes(value.tf) ? value.tf : defaults.tf;
    }
    if ('dailyLimit' in defaults) {
      cfg.dailyLimit = Math.round(clamp(value.dailyLimit, 0, 100000, defaults.dailyLimit));
    }
    out[id] = cfg;
  }
  return out;
}

const stringOrNull = (value) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : null);
const timeOrNull = (value) => (value != null && Number.isFinite(Number(value)) ? Number(value) : null);

/** Cached provider result on an item. Unknown keys are dropped. */
function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const score = Number(raw.score);
  const record = {
    rating: stringOrNull(raw.rating),
    score: raw.score != null && Number.isFinite(score) ? score : null,
    tip: Array.isArray(raw.tip)
      ? raw.tip.filter((l) => typeof l === 'string').slice(0, 8).map((l) => l.slice(0, 200))
      : [],
    updatedAt: timeOrNull(raw.updatedAt),
    fetchedAt: timeOrNull(raw.fetchedAt),
    error: stringOrNull(raw.error),
  };
  return record;
}

function normalizeItem(raw) {
  if (!raw || typeof raw.symbol !== 'string' || !raw.symbol.trim()) return null;
  const pairId = Number(raw.investingPairId);

  const ext = {};
  const rawExt = raw.ext && typeof raw.ext === 'object' ? raw.ext : {};
  for (const id of Object.keys(PROVIDER_DEFAULTS)) {
    const record = normalizeRecord(rawExt[id]);
    if (record) ext[id] = record;
  }

  // An earlier build kept Investing as flat fields on the item.
  if (!ext.investing && raw.investingRating) {
    ext.investing = normalizeRecord({ rating: raw.investingRating, updatedAt: raw.investingUpdatedAt });
  }

  // Old "bought / buy price" and Zacks fields are intentionally not carried over.
  return {
    symbol: raw.symbol.trim().toUpperCase(),
    name: typeof raw.name === 'string' ? raw.name : raw.symbol,
    exchange: typeof raw.exchange === 'string' ? raw.exchange : '',
    exchangeDisp: typeof raw.exchangeDisp === 'string' ? raw.exchangeDisp : '',
    tvTicker: typeof raw.tvTicker === 'string' ? raw.tvTicker : null,
    investingUrl: typeof raw.investingUrl === 'string' ? raw.investingUrl : null,
    investingPairId: Number.isFinite(pairId) && pairId > 0 ? Math.round(pairId) : null,
    addedAt: Number.isFinite(raw.addedAt) ? raw.addedAt : Date.now(),
    // Per-stock bell: sound on any rating change for this symbol, whatever the column bells say.
    alert: raw.alert === true,
    ext,
  };
}

function normalizeSounds(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const sounds = {};
  for (const [key, fallback] of Object.entries(SOUND_DEFAULTS)) {
    sounds[key] = SOUND_IDS.includes(source[key]) ? source[key] : fallback;
  }
  return sounds;
}

function normalizeSettings(raw) {
  const source = raw || {};
  const interval = Number(source.intervalMinutes);
  return {
    intervalMinutes: Number.isFinite(interval) && interval >= 1 ? Math.min(interval, 120) : 10,
    alertsEnabled: source.alertsEnabled !== false,
    sounds: normalizeSounds(source.sounds),
    alertColumns: boolMap(source.alertColumns, ALERT_DEFAULTS),
    providers: normalizeProviders(source.providers),
    display: normalizeDisplay(source.display),
  };
}

function normalizeSecrets(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const id of Object.keys(PROVIDER_DEFAULTS)) {
    if (typeof raw[id] === 'string' && raw[id].length > 0 && raw[id].length < 4096) out[id] = raw[id];
  }
  return out;
}

function normalizeUsage(raw) {
  if (!raw || typeof raw.day !== 'string' || !raw.counts || typeof raw.counts !== 'object') {
    return { day: '', counts: {} };
  }
  const counts = {};
  for (const [id, n] of Object.entries(raw.counts)) {
    if (Number.isFinite(Number(n))) counts[id] = Number(n);
  }
  return { day: raw.day, counts };
}

function load() {
  if (!filePath) throw new Error('store.init() was not called');
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      items: Array.isArray(parsed.items) ? parsed.items.map(normalizeItem).filter(Boolean) : [],
      settings: normalizeSettings(parsed.settings),
      secrets: normalizeSecrets(parsed.secrets),
      usage: normalizeUsage(parsed.usage),
    };
  } catch {
    return { items: [], settings: normalizeSettings({}), secrets: {}, usage: { day: '', counts: {} } };
  }
}

function save(state) {
  if (!filePath) throw new Error('store.init() was not called');

  const payload = JSON.stringify(
    {
      items: (state.items || []).map(normalizeItem).filter(Boolean),
      settings: normalizeSettings(state.settings),
      secrets: normalizeSecrets(state.secrets),
      usage: normalizeUsage(state.usage),
    },
    null,
    2
  );

  // Write beside the target then rename so a crash can't truncate the watchlist.
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, payload, 'utf8');
  fs.renameSync(tempPath, filePath);
}

module.exports = {
  init,
  load,
  save,
  normalizeSettings,
  normalizeDisplay,
  normalizeSounds,
  normalizeItem,
  DISPLAY_DEFAULTS,
  SOUND_IDS,
  SOUND_DEFAULTS,
  TABLE_COLUMNS,
  ALERT_COLUMNS,
  FEED_COLUMNS,
  PROVIDER_TIMEFRAMES,
};
