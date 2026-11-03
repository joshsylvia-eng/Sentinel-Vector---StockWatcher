'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DISPLAY_DEFAULTS = {
  overlayEnabled: false,
  overlayBackground: 'none',
  overlayDim: 0.45,
  overlayWidth: 300,
  overlayCorner: 'top-right',
  overlayMargin: 24,
  overlayColumns: { price: true, change: true, rating: true },
  mainAlwaysOnTop: false,
};

const SOUND_IDS = ['arpeggio', 'chime', 'tick', 'pulse', 'buzz', 'digital', 'none'];

const SOUND_DEFAULTS = {
  strongBuy: 'arpeggio',
  buy: 'chime',
  neutral: 'tick',
  sell: 'pulse',
  strongSell: 'buzz',
};

const DEFAULTS = {
  items: [],
  settings: {
    intervalMinutes: 10,
    alertsEnabled: true,
    sounds: SOUND_DEFAULTS,
    display: DISPLAY_DEFAULTS,
  },
};

const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const BACKGROUNDS = ['none', 'dim', 'solid'];

let filePath = null;
let userDataDir = null;

function init(directory) {
  userDataDir = directory;
  fs.mkdirSync(directory, { recursive: true });
  filePath = path.join(directory, 'watchlist.json');
  migrateLegacyData(directory);
}

function migrateLegacyData(currentDir) {
  try {
    if (fs.existsSync(filePath)) return;
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const legacyDir = path.join(appData, 'StockWatch');
    const legacyPath = path.join(legacyDir, 'watchlist.json');
    if (!fs.existsSync(legacyPath)) return;
    fs.copyFileSync(legacyPath, filePath);
  } catch {
    // Best-effort migration only.
  }
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeDisplay(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const columns =
    source.overlayColumns && typeof source.overlayColumns === 'object' ? source.overlayColumns : {};

  return {
    overlayEnabled: source.overlayEnabled === true,
    overlayBackground: BACKGROUNDS.includes(source.overlayBackground)
      ? source.overlayBackground
      : 'none',
    overlayDim: clamp(source.overlayDim, 0.1, 0.9, 0.45),
    overlayWidth: Math.round(clamp(source.overlayWidth, 240, 520, 300)),
    overlayCorner: CORNERS.includes(source.overlayCorner) ? source.overlayCorner : 'top-right',
    overlayMargin: Math.round(clamp(source.overlayMargin, 0, 80, 24)),
    overlayColumns: {
      price: columns.price !== false,
      change: columns.change !== false,
      rating: columns.rating !== false,
    },
    mainAlwaysOnTop: source.mainAlwaysOnTop === true,
  };
}

function normalizeItem(raw) {
  if (!raw || typeof raw.symbol !== 'string' || !raw.symbol.trim()) return null;
  return {
    symbol: raw.symbol.trim().toUpperCase(),
    name: typeof raw.name === 'string' ? raw.name : raw.symbol,
    exchange: typeof raw.exchange === 'string' ? raw.exchange : '',
    exchangeDisp: typeof raw.exchangeDisp === 'string' ? raw.exchangeDisp : '',
    tvTicker: typeof raw.tvTicker === 'string' ? raw.tvTicker : null,
    investingUrl: typeof raw.investingUrl === 'string' ? raw.investingUrl : null,
    addedAt: Number.isFinite(raw.addedAt) ? raw.addedAt : Date.now(),
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
  const settings = { ...DEFAULTS.settings, ...(raw || {}) };
  const interval = Number(settings.intervalMinutes);
  settings.intervalMinutes =
    Number.isFinite(interval) && interval >= 1 ? Math.min(interval, 120) : 10;
  settings.alertsEnabled = settings.alertsEnabled !== false;
  settings.sounds = normalizeSounds(settings.sounds);
  settings.display = normalizeDisplay(settings.display);
  return settings;
}

function load() {
  if (!filePath) throw new Error('store.init() was not called');

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const items = Array.isArray(parsed.items)
      ? parsed.items.map(normalizeItem).filter(Boolean)
      : [];
    return { items, settings: normalizeSettings(parsed.settings) };
  } catch {
    return { items: [], settings: normalizeSettings({}) };
  }
}

function save(state) {
  if (!filePath) throw new Error('store.init() was not called');

  const payload = JSON.stringify(
    {
      items: (state.items || []).map(normalizeItem).filter(Boolean),
      settings: normalizeSettings(state.settings),
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
  DISPLAY_DEFAULTS,
  SOUND_IDS,
  SOUND_DEFAULTS,
};
