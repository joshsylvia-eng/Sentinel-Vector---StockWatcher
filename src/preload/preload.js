'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The renderers never touch Node or the network directly; everything is a
 * narrow IPC call the main process validates.
 */
contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('app:init'),
  search: (query) => ipcRenderer.invoke('search:symbols', query),
  add: (candidate) => ipcRenderer.invoke('watchlist:add', candidate),
  remove: (symbol) => ipcRenderer.invoke('watchlist:remove', symbol),
  setStockAlert: (symbol, on) => ipcRenderer.invoke('watchlist:setAlert', { symbol, on }),
  exportData: () => ipcRenderer.invoke('data:export'),
  importData: () => ipcRenderer.invoke('data:import'),
  refresh: () => ipcRenderer.invoke('quotes:refresh'),
  setSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  openLink: (symbol, id) => ipcRenderer.invoke('link:open', { symbol, id }),
  chart: (symbol, range) => ipcRenderer.invoke('chart:get', { symbol, range }),
  setProviderKey: (id, key) => ipcRenderer.invoke('provider:setKey', { id, key }),
  testProvider: (id) => ipcRenderer.invoke('provider:test', { id }),
  refreshProvider: (id) => ipcRenderer.invoke('provider:refresh', { id }),
  openKeyPage: (id) => ipcRenderer.invoke('provider:openKeyPage', { id }),
  clearChanges: () => ipcRenderer.invoke('changes:clear'),

  // Window auto-sizing (fire and forget).
  fit: (height) => ipcRenderer.send('main:fit', height),
  fitOverlay: (height) => ipcRenderer.send('overlay:fit', height),

  onRows: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('rows:update', listener);
    return () => ipcRenderer.removeListener('rows:update', listener);
  },

  onSettings: (callback) => {
    const listener = (_event, settings) => callback(settings);
    ipcRenderer.on('settings:update', listener);
    return () => ipcRenderer.removeListener('settings:update', listener);
  },
});
