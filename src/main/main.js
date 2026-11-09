'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, ipcMain, shell, Menu, powerMonitor, safeStorage, dialog, BrowserWindow } = require('electron');

const store = require('./store');
const yahoo = require('./sources/yahoo');
const tradingview = require('./sources/tradingview');
const investing = require('./sources/investing');
const { buildLinks, isAllowedUrl, KEY_HOSTS } = require('./links');
const { fetchRows, fetchIndices } = require('./quotes');
const { PROVIDERS, PROVIDER_IDS, createScheduler, trackedValues, dayKey } = require('./providers');
const windows = require('./window');

// Alert tones are generated in the renderer; allow them without a click first.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let state = { items: [], settings: store.normalizeSettings({}), secrets: {}, usage: { day: '', counts: {} } };
let lastRows = [];
let lastUpdatedAt = null;
let lastIndices = [];
let refreshTimer = null;
let providerTimer = null;
let refreshing = false;
let currentRefresh = null;

// Last seen TradingView values per symbol, for change detection.
const lastTv = new Map();

// Every rating change today, newest first. Kept in the main process so the
// feed survives a window reload and includes changes from every source.
let changes = [];
let changesDay = dayKey();
const MAX_CHANGES = 500;

/* ---------- API keys ---------- */

// Keys are encrypted with Windows DPAPI (Electron safeStorage) when available,
// and never sent to the renderer.
function encryptKey(key) {
  if (safeStorage.isEncryptionAvailable()) {
    return `dpapi:${safeStorage.encryptString(key).toString('base64')}`;
  }
  return `plain:${key}`;
}

function getKey(id) {
  const stored = state.secrets && state.secrets[id];
  if (!stored) return null;
  try {
    if (stored.startsWith('dpapi:')) return safeStorage.decryptString(Buffer.from(stored.slice(6), 'base64'));
    if (stored.startsWith('plain:')) return stored.slice(6);
  } catch {
    return null;
  }
  return null;
}

function keyHint(id) {
  const key = getKey(id);
  if (!key) return null;
  return key.length > 4 ? `••••${key.slice(-4)}` : '••••';
}

/** A keyed source can only be on while it has a key. */
function enforceKeys(settings) {
  for (const id of PROVIDER_IDS) {
    if (PROVIDERS[id].needsKey && !getKey(id) && settings.providers[id]) {
      settings.providers[id] = { ...settings.providers[id], enabled: false };
    }
  }
  return settings;
}

/* ---------- snapshot ---------- */

// Regular US session, Mon–Fri 9:30–16:00 New York time (holidays not modelled).
function clockSaysOpen(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

/** Yahoo's live market state when we have quotes (it knows holidays), else the clock. */
function marketOpen() {
  const withQuotes = lastRows.filter((row) => row.quoteError === null);
  if (withQuotes.length) return withQuotes.some((row) => row.marketOpen);
  return clockSaysOpen();
}

function providerInfo() {
  const status = scheduler.status();
  const out = {};
  for (const id of PROVIDER_IDS) {
    out[id] = {
      label: PROVIDERS[id].label,
      needsKey: PROVIDERS[id].needsKey,
      keyUrl: PROVIDERS[id].keyUrl || null,
      hasKey: PROVIDERS[id].needsKey ? Boolean(getKey(id)) : true,
      keyHint: PROVIDERS[id].needsKey ? keyHint(id) : null,
      timeframes: store.PROVIDER_TIMEFRAMES[id] || null,
      ...status[id],
    };
  }
  return out;
}

function ensureChangeDay() {
  const today = dayKey();
  if (today !== changesDay) {
    changesDay = today;
    changes = [];
  }
}

function snapshot(reason, alerts = []) {
  ensureChangeDay();
  return {
    rows: lastRows,
    settings: state.settings,
    providers: providerInfo(),
    marketOpen: marketOpen(),
    updatedAt: lastUpdatedAt,
    indices: lastIndices,
    refreshing,
    alerts,
    changes,
    stockAlerts: state.items.filter((item) => item.alert).map((item) => item.symbol),
    reason,
  };
}

function broadcast(reason, alerts = []) {
  windows.broadcastRows(snapshot(reason, alerts));
}

/* ---------- change tracking ---------- */

function priceOf(symbol) {
  const row = lastRows.find((entry) => entry.symbol === symbol);
  return row && Number.isFinite(row.price) ? row.price : null;
}

function recordChange(symbol, source, from, to) {
  if (!from || !to || from === to) return null;
  ensureChangeDay();
  const row = lastRows.find((entry) => entry.symbol === symbol);
  const change = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    symbol,
    source,
    from,
    to,
    at: Date.now(),
    price: priceOf(symbol),
    currency: (row && row.currency) || 'USD',
    marketOpen: marketOpen(),
  };
  changes.unshift(change);
  if (changes.length > MAX_CHANGES) changes.length = MAX_CHANGES;
  return change;
}

/* ---------- background providers ---------- */

let pendingAlerts = [];
let broadcastQueued = null;

// Provider results trickle in one symbol at a time; coalesce the UI updates.
function queueBroadcast() {
  if (broadcastQueued) return;
  broadcastQueued = setTimeout(() => {
    broadcastQueued = null;
    const alerts = pendingAlerts;
    pendingAlerts = [];
    broadcast('extras', alerts);
  }, 400);
}

const scheduler = createScheduler({
  getState: () => state,
  save: () => store.save(state),
  getKey,
  isMarketOpen: marketOpen,
  getPrice: priceOf,
  onRecord(symbol, id, before, after) {
    const row = lastRows.find((entry) => entry.symbol === symbol);
    const item = state.items.find((entry) => entry.symbol === symbol);
    if (row && item) row.ext = item.ext;

    const prev = trackedValues(id, before);
    const next = trackedValues(id, after);
    for (const source of Object.keys(next)) {
      const change = recordChange(symbol, source, prev[source], next[source]);
      if (change) pendingAlerts.push(change);
    }
    queueBroadcast();
  },
});

function scheduleProviders() {
  if (providerTimer) clearInterval(providerTimer);
  // Each provider decides per item whether it is due; a one-minute tick is
  // fine-grained enough for intervals of 1 minute and up.
  providerTimer = setInterval(() => scheduler.runAll().catch(() => {}), 60 * 1000);
}

/* ---------- price refresh ---------- */

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
      const [{ rows }, indices] = await Promise.all([fetchRows(state.items), fetchIndices()]);
      lastRows = rows;
      // Keep the last good value for any index that failed this cycle.
      lastIndices = indices.map((entry) => {
        if (entry.changePct != null) return entry;
        return lastIndices.find((prev) => prev.symbol === entry.symbol) || entry;
      });
      lastUpdatedAt = Date.now();

      const alerts = [];
      for (const row of rows) {
        // A failed quote means stale ratings; do not compare against them.
        if (row.quoteError !== null) continue;
        const previous = lastTv.get(row.symbol) || {};
        lastTv.set(row.symbol, {
          rating: row.rating || previous.rating,
          analyst: row.analystRating || previous.analyst,
        });
        for (const [source, value] of [
          ['rating', row.rating],
          ['analyst', row.analystRating],
        ]) {
          const change = recordChange(row.symbol, source, previous[source], value);
          if (change) alerts.push(change);
        }
      }

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
    if (payload) {
      broadcast(reason, payload.alerts);
      // Providers refresh behind the price table, so a throttled site never
      // delays quotes or the countdown.
      scheduler.runAll().catch(() => {});
    }
  }
}

function patchRowLinks(symbol) {
  const item = state.items.find((entry) => entry.symbol === symbol);
  const row = lastRows.find((entry) => entry.symbol === symbol);
  if (!item || !row) return;
  row.links = buildLinks(item);
  broadcast('links');
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

  if (!item.investingUrl || !item.investingPairId) {
    try {
      const listing = await investing.resolveInvestingListing(item.symbol);
      item.investingUrl = listing.url;
      item.investingPairId = listing.pairId;
      store.save(state);
      patchRowLinks(item.symbol);
    } catch {
      // Leave it unresolved; the next add or restart retries.
    }
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
    investingPairId: null,
    addedAt: Date.now(),
    ext: {},
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

  lastTv.delete(clean);
  lastRows = lastRows.filter((row) => row.symbol !== clean);
  store.save(state);
  broadcast('remove');
  return true;
}

function updateSettings(patch) {
  const current = state.settings;
  const next = { ...current, ...(patch || {}) };

  if (patch && patch.display) {
    next.display = {
      ...current.display,
      ...patch.display,
      overlayColumns: { ...current.display.overlayColumns, ...(patch.display.overlayColumns || {}) },
      tableColumns: { ...current.display.tableColumns, ...(patch.display.tableColumns || {}) },
      feedColumns: { ...current.display.feedColumns, ...(patch.display.feedColumns || {}) },
    };
  }
  if (patch && patch.sounds) next.sounds = { ...current.sounds, ...patch.sounds };
  if (patch && patch.alertColumns) next.alertColumns = { ...current.alertColumns, ...patch.alertColumns };
  if (patch && patch.providers) {
    next.providers = { ...current.providers };
    for (const [id, value] of Object.entries(patch.providers)) {
      if (!PROVIDERS[id] || !value || typeof value !== 'object') continue;
      next.providers[id] = { ...(current.providers[id] || {}), ...value };
    }
  }

  if (patch && patch.intervalMinutes != null) {
    const minutes = Number(patch.intervalMinutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) {
      throw new Error('Interval must be between 1 and 120 minutes.');
    }
    next.intervalMinutes = minutes;
  }
  if (patch && patch.alertsEnabled != null) next.alertsEnabled = Boolean(patch.alertsEnabled);

  const before = current.providers;
  state.settings = enforceKeys(store.normalizeSettings(next));
  store.save(state);

  if (patch && patch.intervalMinutes != null) scheduleRefresh();
  windows.applyDisplaySettings(state.settings.display);
  windows.broadcastSettings(state.settings);

  if (patch && patch.providers) {
    for (const id of Object.keys(patch.providers)) {
      if (!PROVIDERS[id]) continue;
      // A new timeframe makes the cached ratings stale; refetch them.
      if (before[id] && before[id].tf !== state.settings.providers[id].tf) {
        for (const item of state.items) {
          if (item.ext && item.ext[id]) item.ext[id] = { ...item.ext[id], fetchedAt: 0 };
        }
      }
      scheduler.unblock(id);
      scheduler.runProvider(id).catch(() => {});
    }
    broadcast('providers');
  }

  return state.settings;
}

/* ---------- per-stock alerts ---------- */

function setStockAlert(symbol, on) {
  const clean = String(symbol || '').toUpperCase();
  const item = state.items.find((entry) => entry.symbol === clean);
  if (!item) throw new Error('Unknown symbol.');
  item.alert = Boolean(on);
  store.save(state);
  broadcast('stockAlerts');
  return item.alert;
}

/* ---------- export / import ---------- */

const EXPORT_APP = 'sentinel-vector-stockwatcher';

function exportPayload() {
  return {
    app: EXPORT_APP,
    format: 1,
    version: app.getVersion(),
    exportedAt: new Date().toISOString(),
    items: state.items.map((item) => ({
      symbol: item.symbol,
      name: item.name,
      exchange: item.exchange,
      exchangeDisp: item.exchangeDisp,
      tvTicker: item.tvTicker,
      investingUrl: item.investingUrl,
      investingPairId: item.investingPairId,
      addedAt: item.addedAt,
      alert: item.alert === true,
    })),
    // API keys are encrypted for this Windows account only, so they are never exported.
    settings: state.settings,
  };
}

async function exportData(win) {
  const stamp = new Date().toISOString().slice(0, 10);
  const result = await dialog.showSaveDialog(win, {
    title: 'Export watchlist',
    defaultPath: path.join(app.getPath('documents'), `StockWatcher-export-${stamp}.json`),
    filters: [{ name: 'StockWatcher export', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, JSON.stringify(exportPayload(), null, 2), 'utf8');
  return { filePath: result.filePath, count: state.items.length };
}

async function importData(win) {
  const pick = await dialog.showOpenDialog(win, {
    title: 'Import watchlist',
    defaultPath: app.getPath('documents'),
    properties: ['openFile'],
    filters: [{ name: 'StockWatcher export', extensions: ['json'] }],
  });
  if (pick.canceled || !pick.filePaths.length) return null;

  let parsed;
  try {
    const text = fs.readFileSync(pick.filePaths[0], 'utf8');
    if (text.length > 5 * 1024 * 1024) throw new Error('too big');
    parsed = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new Error('That file is not a StockWatcher export.');
  }
  // Accepts an export file or a copied watchlist.json (same shape; its keys are ignored).
  if (!parsed || !Array.isArray(parsed.items)) throw new Error('That file is not a StockWatcher export.');

  const incoming = parsed.items
    .map(store.normalizeItem)
    .filter(Boolean)
    .filter((item) => /^[A-Z0-9.^=-]{1,15}$/.test(item.symbol))
    .map((item) => ({ ...item, ext: {} }));
  const unique = [...new Map(incoming.map((item) => [item.symbol, item])).values()];
  if (!unique.length) throw new Error('No symbols found in that file.');

  const existing = new Set(state.items.map((item) => item.symbol));
  const fresh = unique.filter((item) => !existing.has(item.symbol));
  const hasSettings = parsed.settings && typeof parsed.settings === 'object';

  const answer = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Import watchlist',
    message: `Import ${unique.length} symbol${unique.length === 1 ? '' : 's'}?`,
    detail:
      `${fresh.length} new, ${unique.length - fresh.length} already on this watchlist.\n\n` +
      'Add: keeps your current list and adds the new symbols.\nReplace: your list becomes exactly the file\'s list.',
    buttons: ['Add to my watchlist', 'Replace my watchlist', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    checkboxLabel: hasSettings ? 'Also import settings (columns, bells, sounds, sizes, overlay, data sources). API keys are not included.' : undefined,
    checkboxChecked: false,
  });
  if (answer.response === 2) return null;

  if (answer.response === 1) {
    const keep = new Map(state.items.map((item) => [item.symbol, item]));
    // Keep cached ratings for symbols that stay on the list.
    state.items = unique.map((item) => (keep.has(item.symbol) ? { ...keep.get(item.symbol), alert: item.alert } : item));
    const symbols = new Set(state.items.map((item) => item.symbol));
    for (const symbol of [...lastTv.keys()]) if (!symbols.has(symbol)) lastTv.delete(symbol);
    lastRows = lastRows.filter((row) => symbols.has(row.symbol));
  } else {
    for (const item of unique) {
      const current = state.items.find((entry) => entry.symbol === item.symbol);
      if (current) current.alert = current.alert || item.alert;
      else state.items.push(item);
    }
  }

  const withSettings = Boolean(hasSettings && answer.checkboxChecked);
  if (withSettings) {
    state.settings = enforceKeys(store.normalizeSettings(parsed.settings));
    scheduleRefresh();
    windows.applyDisplaySettings(state.settings.display);
    windows.broadcastSettings(state.settings);
  }

  store.save(state);
  broadcast('import');

  // Resolve tickers for the new symbols in the background, then fetch quotes.
  const unresolved = state.items.filter((item) => !item.tvTicker || !item.investingUrl || !item.investingPairId);
  mapLimit(unresolved, 3, (item) => resolveSymbol(item))
    .catch(() => {})
    .then(() => refreshAll({ reason: 'import' }))
    .catch(() => {});

  return { added: fresh.length, total: state.items.length, replaced: answer.response === 1, settings: withSettings };
}

/* ---------- IPC ---------- */

ipcMain.handle('app:init', () => snapshot('init'));

ipcMain.handle('search:symbols', async (_event, query) => yahoo.searchSymbols(query));

ipcMain.handle('watchlist:add', async (_event, candidate) => {
  const item = await addSymbol(candidate);
  return { item, rows: lastRows };
});

ipcMain.handle('watchlist:remove', (_event, symbol) => removeSymbol(symbol));

ipcMain.handle('watchlist:setAlert', (_event, payload) => setStockAlert(payload && payload.symbol, payload && payload.on));

ipcMain.handle('data:export', (event) => exportData(BrowserWindow.fromWebContents(event.sender)));
ipcMain.handle('data:import', (event) => importData(BrowserWindow.fromWebContents(event.sender)));

ipcMain.handle('quotes:refresh', async () => {
  const result = await refreshAll({ reason: 'manual' });
  return { rows: result.rows || lastRows, settings: state.settings };
});

ipcMain.handle('settings:update', (_event, patch) => updateSettings(patch));

ipcMain.handle('provider:setKey', (_event, payload) => {
  const id = String((payload && payload.id) || '');
  const key = String((payload && payload.key) || '').trim();
  if (!PROVIDERS[id] || !PROVIDERS[id].needsKey) throw new Error('Unknown provider.');
  if (key && !/^[\x21-\x7e]{6,256}$/.test(key)) throw new Error('That key does not look valid.');

  state.secrets = { ...(state.secrets || {}) };
  if (key) state.secrets[id] = encryptKey(key);
  else delete state.secrets[id];
  // Removing a key switches the source off; adding one leaves it for the user to tick.
  state.settings = enforceKeys(state.settings);
  store.save(state);
  windows.broadcastSettings(state.settings);

  scheduler.unblock(id);
  if (key) scheduler.runProvider(id).catch(() => {});
  broadcast('providers');
  return providerInfo()[id];
});

ipcMain.handle('provider:test', async (_event, payload) => {
  const id = String((payload && payload.id) || '');
  if (!PROVIDERS[id] || !PROVIDERS[id].needsKey) throw new Error('Unknown provider.');
  const key = getKey(id);
  if (!key) throw new Error('Save a key first.');
  const symbol = (state.items[0] && state.items[0].symbol) || 'AAPL';
  const result = await scheduler.test(id, symbol, key);
  return { symbol, rating: result.rating, tip: result.tip || [] };
});

ipcMain.handle('provider:refresh', (_event, payload) => {
  const id = String((payload && payload.id) || '');
  if (!PROVIDERS[id]) throw new Error('Unknown provider.');
  scheduler.unblock(id);
  scheduler.runProvider(id, { force: true }).catch(() => {});
  return true;
});

ipcMain.handle('provider:openKeyPage', async (_event, payload) => {
  const id = String((payload && payload.id) || '');
  const url = PROVIDERS[id] && PROVIDERS[id].keyUrl;
  if (!url || !isAllowedUrl(url, KEY_HOSTS)) throw new Error('That link is not allowed.');
  await shell.openExternal(url);
  return true;
});

ipcMain.handle('changes:clear', () => {
  changes = [];
  broadcast('changes');
  return true;
});

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

// Hover-chart data, cached briefly so moving the mouse across rows is cheap.
const chartCache = new Map();
const CHART_TTL = { '1d': 60 * 1000, '5d': 5 * 60 * 1000 };

ipcMain.handle('chart:get', async (_event, payload) => {
  const symbol = String((payload && payload.symbol) || '').toUpperCase();
  const range = String((payload && payload.range) || '1d');
  if (!state.items.some((entry) => entry.symbol === symbol)) throw new Error('Unknown symbol.');
  if (!yahoo.CHART_RANGES[range]) throw new Error('Unknown chart range.');

  const key = `${symbol}|${range}`;
  const cached = chartCache.get(key);
  const ttl = CHART_TTL[range] || 30 * 60 * 1000;
  if (cached && Date.now() - cached.fetchedAt < ttl) return cached;

  const chart = await yahoo.fetchChart(symbol, range);
  chartCache.set(key, chart);
  if (chartCache.size > 200) chartCache.delete(chartCache.keys().next().value);
  return chart;
});

ipcMain.on('main:fit', (_event, height) => windows.fitMain(height));
ipcMain.on('overlay:fit', (_event, height) => windows.setOverlayHeight(height));

/* ---------- lifecycle ---------- */

async function mapLimit(items, limit, worker) {
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length) || 0).fill(null).map(async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);

  store.init(app.getPath('userData'));
  state = store.load();
  state.settings = enforceKeys(state.settings);
  // Rewrite once so data from older builds (e.g. bought / buy price, Zacks) is dropped.
  store.save(state);
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
  scheduleProviders();

  // Windows timers drift while the machine is asleep. On wake, restart the
  // intervals and refresh immediately so the table (and alerts) catch up.
  powerMonitor.on('resume', () => {
    scheduleRefresh();
    scheduleProviders();
    refreshAll({ reason: 'resume' }).catch(() => {});
  });

  powerMonitor.on('unlock-screen', () => {
    refreshAll({ reason: 'unlock' }).catch(() => {});
  });

  const unresolved = state.items.filter((item) => !item.tvTicker || !item.investingUrl || !item.investingPairId);
  await mapLimit(unresolved, 3, (item) => resolveSymbol(item));

  await refreshAll({ reason: 'startup' });
});

app.on('will-quit', () => {
  windows.dispose();
});

app.on('window-all-closed', () => {
  app.quit();
});
