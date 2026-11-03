'use strict';

const path = require('node:path');
const { app, ipcMain, shell, Menu, powerMonitor } = require('electron');

const store = require('./store');
const yahoo = require('./sources/yahoo');
const tradingview = require('./sources/tradingview');
const investing = require('./sources/investing');
const { buildLinks, isAllowedUrl } = require('./links');
const { fetchRows } = require('./quotes');
const windows = require('./window');

// Alert tones are generated in the renderer; allow them without a click first.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let state = { items: [], settings: store.normalizeSettings({}) };
let lastRows = [];
let lastUpdatedAt = null;
let refreshTimer = null;
let refreshing = false;
let currentRefresh = null;

const lastRatings = new Map();

function snapshot(reason, alerts = []) {
  return {
    rows: lastRows,
    settings: state.settings,
    marketOpen: lastRows.some((row) => row.marketOpen),
    updatedAt: lastUpdatedAt,
    refreshing,
    alerts,
    reason,
  };
}

function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  const minutes = state.settings.intervalMinutes || 10;
  refreshTimer = setInterval(() => {
    refreshAll({ reason: 'timer' }).catch(() => {});
  }, minutes * 60 * 1000);
}

async function refreshAll({ reason = 'manual' } = {}) {
  if (currentRefresh) {
    // A timer tick during an in-flight refresh can wait for the next cycle,
    // but an add or an explicit refresh must actually run afterwards.
    if (reason === 'timer' || reason === 'startup') return { rows: lastRows, skipped: true };
    await currentRefresh.catch(() => {});
  }

  refreshing = true;
  let payload = null;

  currentRefresh = (async () => {
    try {
      const { rows } = await fetchRows(state.items);
      const alerts = [];

      for (const row of rows) {
        if (!row.rating) continue;
        const previous = lastRatings.get(row.symbol);
        lastRatings.set(row.symbol, row.rating);

        // Record every rating transition so the change strip under the table can
        // show what moved and when. Sound is gated separately (market open and
        // alert sounds enabled). First-load values and unchanged ratings are
        // ignored, as are rows whose quote failed.
        if (previous && previous !== row.rating && row.quoteError === null) {
          alerts.push({
            symbol: row.symbol,
            rating: row.rating,
            from: previous,
            at: Date.now(),
            marketOpen: row.marketOpen === true,
          });
        }
      }

      lastRows = rows;
      lastUpdatedAt = Date.now();
      payload = { rows, alerts };
      return { rows, alerts };
    } finally {
      refreshing = false;
    }
  })();

  try {
    return await currentRefresh;
  } finally {
    currentRefresh = null;
    if (payload) windows.broadcastRows(snapshot(reason, payload.alerts));
  }
}

function patchRowLinks(symbol) {
  const item = state.items.find((entry) => entry.symbol === symbol);
  const row = lastRows.find((entry) => entry.symbol === symbol);
  if (!item || !row) return;
  row.links = buildLinks(item);
  windows.broadcastRows(snapshot('links'));
}

/**
 * Resolve the TradingView ticker and the Investing.com United States page.
 * Neither is allowed to block adding a symbol.
 */
async function resolveSymbol(item) {
  if (!item.tvTicker) {
    try {
      item.tvTicker = await tradingview.resolveTicker(item.symbol, item.exchange);
      store.save(state);
    } catch {
      item.tvTicker = null;
    }
  }

  if (!item.investingUrl) {
    investing
      .resolveInvestingUrl(item.symbol)
      .then((url) => {
        item.investingUrl = url;
        store.save(state);
        patchRowLinks(item.symbol);
      })
      .catch(() => {});
  }
}

async function addSymbol(candidate) {
  const symbol = String((candidate && candidate.symbol) || '')
    .trim()
    .toUpperCase();

  if (!symbol || !/^[A-Z0-9.^=-]{1,15}$/.test(symbol)) {
    throw new Error('That symbol does not look valid.');
  }
  if (state.items.some((item) => item.symbol === symbol)) {
    throw new Error(`${symbol} is already on your watchlist.`);
  }

  const item = {
    symbol,
    name: String(candidate.name || symbol).slice(0, 120),
    exchange: String(candidate.exchange || ''),
    exchangeDisp: String(candidate.exchangeDisp || ''),
    tvTicker: null,
    investingUrl: null,
    addedAt: Date.now(),
  };

  state.items.push(item);
  store.save(state);

  await resolveSymbol(item);
  store.save(state);

  refreshAll({ reason: 'add' }).catch(() => {});
  return item;
}

function removeSymbol(symbol) {
  const clean = String(symbol || '').toUpperCase();
  const before = state.items.length;
  state.items = state.items.filter((item) => item.symbol !== clean);
  if (state.items.length === before) return false;

  lastRatings.delete(clean);
  lastRows = lastRows.filter((row) => row.symbol !== clean);
  store.save(state);
  windows.broadcastRows(snapshot('remove'));
  return true;
}

function updateSettings(patch) {
  const merged = { ...state.settings, ...(patch || {}) };

  if (patch && patch.display) {
    merged.display = {
      ...state.settings.display,
      ...patch.display,
      overlayColumns: {
        ...state.settings.display.overlayColumns,
        ...(patch.display.overlayColumns || {}),
      },
    };
  }

  if (patch && patch.sounds) {
    merged.sounds = { ...state.settings.sounds, ...patch.sounds };
  }

  if (patch && patch.intervalMinutes != null) {
    const minutes = Number(patch.intervalMinutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) {
      throw new Error('Interval must be between 1 and 120 minutes.');
    }
    merged.intervalMinutes = minutes;
  }
  if (patch && patch.alertsEnabled != null) merged.alertsEnabled = Boolean(patch.alertsEnabled);

  state.settings = store.normalizeSettings(merged);
  store.save(state);

  scheduleRefresh();
  windows.applyDisplaySettings(state.settings.display);
  windows.broadcastSettings(state.settings);

  return state.settings;
}

/* ---------- IPC ---------- */

ipcMain.handle('app:init', () => snapshot('init'));

ipcMain.handle('search:symbols', async (_event, query) => yahoo.searchSymbols(query));

ipcMain.handle('watchlist:add', async (_event, candidate) => {
  const item = await addSymbol(candidate);
  return { item, rows: lastRows };
});

ipcMain.handle('watchlist:remove', (_event, symbol) => removeSymbol(symbol));

ipcMain.handle('quotes:refresh', async () => {
  const result = await refreshAll({ reason: 'manual' });
  return { rows: result.rows || lastRows, settings: state.settings };
});

ipcMain.handle('settings:update', (_event, patch) => updateSettings(patch));

ipcMain.handle('link:open', async (_event, payload) => {
  const symbol = String((payload && payload.symbol) || '').toUpperCase();
  const id = String((payload && payload.id) || '');

  const item = state.items.find((entry) => entry.symbol === symbol);
  if (!item) throw new Error('Unknown symbol.');

  const link = buildLinks(item).find((entry) => entry.id === id);
  if (!link || !isAllowedUrl(link.url)) throw new Error('That link is not allowed.');

  await shell.openExternal(link.url);
  return true;
});

ipcMain.on('main:fit', (_event, height) => windows.fitMain(height));
ipcMain.on('overlay:fit', (_event, height) => windows.setOverlayHeight(height));

/* ---------- lifecycle ---------- */

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);

  store.init(app.getPath('userData'));
  state = store.load();
  console.log('Sentinel Vector - StockWatcher watchlist:', path.join(app.getPath('userData'), 'watchlist.json'));

  windows.init({
    getSettings: () => state.settings,
    updateSettings: (patch) => updateSettings(patch),
    refresh: () => refreshAll({ reason: 'manual' }).catch(() => {}),
    quit: () => app.quit(),
  });

  windows.createMainWindow();
  windows.createTray();
  windows.registerShortcuts();
  windows.initScreenListeners();
  windows.applyDisplaySettings(state.settings.display);

  scheduleRefresh();

  // Windows timers drift while the machine is asleep. On wake, restart the
  // interval and refresh immediately so the table (and alerts) catch up.
  powerMonitor.on('resume', () => {
    scheduleRefresh();
    refreshAll({ reason: 'resume' }).catch(() => {});
  });

  powerMonitor.on('unlock-screen', () => {
    refreshAll({ reason: 'unlock' }).catch(() => {});
  });

  // Fill in anything a previous session failed to resolve. Awaiting the ticker
  // lookup means ratings are present on the first paint.
  const unresolved = state.items.filter((item) => !item.tvTicker || !item.investingUrl);
  await Promise.all(unresolved.map((item) => resolveSymbol(item)));

  await refreshAll({ reason: 'startup' });
});

app.on('will-quit', () => {
  windows.dispose();
});

app.on('window-all-closed', () => {
  app.quit();
});
