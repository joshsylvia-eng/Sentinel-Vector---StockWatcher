'use strict';

const path = require('node:path');
const { BrowserWindow, screen, Tray, Menu, nativeImage, globalShortcut } = require('electron');

const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const ICON_PATH = path.join(__dirname, '..', '..', 'build', 'icon.png');

let mainWindow = null;
let overlayWindow = null;
let tray = null;
let overlayHeight = 140;
let lastBoundsLog = '';
let userResizedMain = false;
let programmaticResize = false;

const deps = {
  getSettings: () => ({ display: {} }),
  updateSettings: () => {},
  refresh: () => {},
  quit: () => {},
};

function init(options) {
  Object.assign(deps, options || {});
}

/* ---------- main window ---------- */

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 420,
    minWidth: 720,
    minHeight: 260,
    backgroundColor: '#0a0e13',
    title: 'Sentinel Vector - StockWatcher',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // Alerts are played from this window; do not let Chromium throttle its
      // timers/audio when it is minimised, covered, or the display is off.
      backgroundThrottling: false,
    },
  });

  mainWindow.loadFile(path.join(RENDERER_DIR, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // A single local page; never navigate it away or spawn child windows.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  // Once the user picks their own size, stop auto-fitting to content.
  mainWindow.on('will-resize', () => {
    if (!programmaticResize) userResizedMain = true;
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    deps.quit();
  });

  return mainWindow;
}

function getMainWindow() {
  return mainWindow;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function fitMain(height) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const { workArea } = screen.getPrimaryDisplay();
  const maxHeight = Math.max(260, Math.min(1000, workArea.height - 40));
  const desired = Math.round(Math.min(maxHeight, Math.max(260, Number(height) || 0)));
  const [width, current] = mainWindow.getContentSize();

  // Allow the window to grow to fit new content (like the rating-change feed)
  // even if the user has manually resized it. Only shrink if we never grew
  // programmatically beyond the user's size in a conflicting way; if the
  // requested height is larger than current, always expand. If smaller and the
  // user resized, we still avoid shrinking below what content needs, but we
  // don't fight the user's chosen height aggressively.
  const target = desired > current ? desired : userResizedMain ? current : desired;
  if (Math.abs(target - current) < 3) return;

  // Keep our own auto-fit from being mistaken for a user resize.
  programmaticResize = true;
  mainWindow.setContentSize(width, target);
  setTimeout(() => {
    programmaticResize = false;
  }, 120);
}

/* ---------- overlay window ---------- */

function createOverlayWindow(display) {
  overlayWindow = new BrowserWindow({
    width: display.overlayWidth,
    height: overlayHeight,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  overlayWindow.loadFile(path.join(RENDERER_DIR, 'overlay.html'));

  // Float above normal windows, and never intercept a single click.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setIgnoreMouseEvents(true);

  overlayWindow.once('ready-to-show', () => {
    positionOverlay(display);
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.showInactive();
  });

  overlayWindow.webContents.on('did-finish-load', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;

    overlayWindow.webContents.send('settings:update', deps.getSettings());

    // Transparent windows do not always emit ready-to-show; make sure the
    // overlay becomes visible either way.
    if (!overlayWindow.isVisible()) {
      positionOverlay();
      overlayWindow.showInactive();
    }
  });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
    lastBoundsLog = '';
  });
}

function positionOverlay(display) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  const settings = deps.getSettings();
  const d = { ...settings.display, ...(display || {}) };
  const area = screen.getPrimaryDisplay().workArea;

  const width = Math.round(d.overlayWidth || 300);
  const height = Math.max(24, Math.round(overlayHeight));
  const margin = Math.round(d.overlayMargin || 0);
  const corner = d.overlayCorner || 'top-right';

  const x = corner.endsWith('right')
    ? area.x + area.width - width - margin
    : area.x + margin;
  const y = corner.startsWith('bottom')
    ? area.y + area.height - height - margin
    : area.y + margin;

  overlayWindow.setBounds({
    x: Math.round(x),
    y: Math.round(y),
    width,
    height,
  });

  const bounds = overlayWindow.getBounds();
  const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
  if (key !== lastBoundsLog) {
    lastBoundsLog = key;
    console.log(
      `overlay: transparent + click-through at ${corner} ` +
        `bounds=(${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}) ` +
        `alwaysOnTop=${overlayWindow.isAlwaysOnTop()} ignoreMouse=true`
    );
  }
}

function setOverlayHeight(height) {
  const { workArea } = screen.getPrimaryDisplay();
  const maxHeight = Math.max(120, workArea.height - 40);
  const next = Math.max(24, Math.min(maxHeight, Math.round(Number(height) || 0)));
  if (Math.abs(next - overlayHeight) < 2) return;
  overlayHeight = next;
  positionOverlay();
}

function isOverlayOpen() {
  return Boolean(overlayWindow);
}

function applyDisplaySettings(display) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(display.mainAlwaysOnTop === true);
  }

  if (display.overlayEnabled) {
    if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow(display);
    else positionOverlay(display);
  } else if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.destroy();
    overlayWindow = null;
  }

  refreshTray();
}

/* ---------- messaging ---------- */

function broadcastRows(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('rows:update', payload);
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    // The overlay is read-only: it never reacts to alert transitions.
    overlayWindow.webContents.send('rows:update', { ...payload, alerts: [] });
  }
}

function broadcastSettings(settings) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('settings:update', settings);
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('settings:update', settings);
  }
}

/* ---------- tray & shortcuts ---------- */

function createTray() {
  let image = nativeImage.createFromPath(ICON_PATH);
  if (!image.isEmpty()) image = image.resize({ width: 16, height: 16 });

  tray = new Tray(image);
  tray.setToolTip('Sentinel Vector - StockWatcher');
  tray.on('click', () => showMainWindow());
  refreshTray();
}

function refreshTray() {
  if (!tray || tray.isDestroyed()) return;

  const settings = deps.getSettings();
  const menu = Menu.buildFromTemplate([
    { label: 'Show Sentinel Vector - StockWatcher', click: () => showMainWindow() },
    {
      label: 'Show overlay',
      type: 'checkbox',
      checked: Boolean(settings.display && settings.display.overlayEnabled),
      click: (item) => deps.updateSettings({ display: { overlayEnabled: item.checked } }),
    },
    { type: 'separator' },
    { label: 'Refresh now', click: () => deps.refresh() },
    { type: 'separator' },
    { label: 'Quit Sentinel Vector - StockWatcher', click: () => deps.quit() },
  ]);

  tray.setContextMenu(menu);
}

function registerShortcuts() {
  globalShortcut.register('Control+Alt+O', () => {
    const display = deps.getSettings().display || {};
    deps.updateSettings({ display: { overlayEnabled: !display.overlayEnabled } });
  });

  globalShortcut.register('Control+Alt+M', () => showMainWindow());
}

function initScreenListeners() {
  const reposition = () => positionOverlay();
  screen.on('display-metrics-changed', reposition);
  screen.on('display-added', reposition);
  screen.on('display-removed', reposition);
}

function dispose() {
  globalShortcut.unregisterAll();
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }
}

module.exports = {
  init,
  createMainWindow,
  getMainWindow,
  showMainWindow,
  fitMain,
  applyDisplaySettings,
  setOverlayHeight,
  isOverlayOpen,
  broadcastRows,
  broadcastSettings,
  createTray,
  registerShortcuts,
  initScreenListeners,
  dispose,
};
