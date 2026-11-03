'use strict';

/*
 * Dev-only UI check: launches the real app with remote debugging, exercises the
 * compact table, the settings panel and the floating overlay, then saves
 * screenshots. Not part of the packaged app.
 *
 *   node tools/ui-shot.js
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const electronPath = require('electron');
const projectRoot = path.join(__dirname, '..');
const outDir = path.join(process.env.TEMP || os.tmpdir(), 'stockwatch-shots');
fs.mkdirSync(outDir, { recursive: true });

// `--exe` runs the packaged portable build instead of the dev Electron binary.
const useExe = process.argv.includes('--exe');
const exePath = path.join(projectRoot, 'dist', 'SentinelVector-StockWatcher.exe');
const binary = useExe ? exePath : electronPath;
const launchArgs = ['--remote-debugging-port=9222'];
if (!useExe) launchArgs.push('.');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let mainLog = '';

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    };
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(payload);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || 'evaluate failed');
    }
    return result.result.value;
  }

  async shot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, name), Buffer.from(data, 'base64'));
    console.log('  saved', name);
  }
}

async function listTargets() {
  const response = await fetch('http://127.0.0.1:9222/json/list');
  return response.json();
}

async function findTarget(fragment) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const targets = await listTargets();
      const page = targets.find((target) => target.type === 'page' && target.url.includes(fragment));
      if (page) return page;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`Could not find the ${fragment} window`);
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.onopen = () => resolve(socket);
    socket.onerror = () => reject(new Error('CDP socket failed'));
  });
}

async function attach(target) {
  const cdp = new Cdp(await connect(target.webSocketDebuggerUrl));
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return cdp;
}

async function setBackdrop(cdp, hex) {
  const value = parseInt(hex.replace('#', ''), 16);
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', {
    color: {
      r: (value >> 16) & 255,
      g: (value >> 8) & 255,
      b: value & 255,
      a: 1,
    },
  });
}

(async () => {
  const child = spawn(binary, launchArgs, {
    cwd: useExe ? path.join(projectRoot, 'dist') : projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    mainLog += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    mainLog += chunk.toString();
  });

  const cleanup = () => {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  };

  try {
    const main = await attach(await findTarget('index.html'));

    console.log('Waiting for first data load…');
    await sleep(10000);

    const mainMetrics = await main.evaluate(`
      (() => {
        const row = document.querySelector('#gridBody tr');
        const modal = document.querySelector('#settingsModal');
        return {
          rows: document.querySelectorAll('#gridBody tr').length,
          rowHeight: row ? Math.round(row.getBoundingClientRect().height) : 0,
          innerHeight: window.innerHeight,
          contentHeight: document.querySelector('.topbar').offsetHeight +
            document.querySelector('.stage').offsetHeight,
          settingsHidden: modal.hidden,
        };
      })()
    `);
    console.log(
      `  rows=${mainMetrics.rows} rowHeight=${mainMetrics.rowHeight}px ` +
        `window=${mainMetrics.innerHeight}px content=${mainMetrics.contentHeight}px`
    );
    await main.shot('01-main-compact.png');

    console.log('Simulating a rating change…');
    const feedBefore = await main.evaluate(`
      (async () => {
        const real = state.rows;
        state.__realRows = real;
        const target = real[0];
        const second = real[1];
        const next = target.rating === 'Strong Buy' ? 'Buy' : 'Strong Buy';
        const next2 = second.rating === 'Neutral' ? 'Sell' : 'Neutral';
        const demo = real.map((row) => {
          if (row.symbol === target.symbol) return { ...row, rating: next };
          if (row.symbol === second.symbol) return { ...row, rating: next2 };
          return row;
        });

        handleUpdate({
          rows: demo,
          alerts: [
            { symbol: target.symbol, rating: next, from: target.rating, at: Date.now() - 5000 },
            { symbol: second.symbol, rating: next2, from: second.rating, at: Date.now() - 4000 },
          ],
          reason: 'timer',
          marketOpen: true,
        });
        await new Promise((resolve) => setTimeout(resolve, 600));

        const rowEl = document.querySelector(
          '#gridBody tr[data-symbol="' + target.symbol + '"]'
        );
        return {
          symbol: target.symbol,
          from: target.rating,
          to: next,
          second: second.symbol,
          secondTo: next2,
          feedHidden: document.querySelector('#changeFeed').hidden,
          items: document.querySelectorAll('#changeFeedItems .change-item').length,
          texts: Array.from(document.querySelectorAll('#changeFeedItems .change-item')).map((el) =>
            el.innerText.replace(/\\s+/g, ' ').trim()
          ),
          highlight: rowEl ? rowEl.className : '(missing)',
          highlightCount: document.querySelectorAll('#gridBody tr.row-changed').length,
          windowHeight: window.innerHeight,
          feedHeight: Math.round(
            document.querySelector('#changeFeed').getBoundingClientRect().height
          ),
        };
      })()
    `);
    console.log('  feed:', JSON.stringify(feedBefore));
    await main.shot('08-change-feed.png');

    console.log('Checking the strip survives a link-only update…');
    const survivesLinks = await main.evaluate(`
      (async () => {
        handleUpdate({ rows: state.rows, alerts: [], reason: 'links' });
        await new Promise((resolve) => setTimeout(resolve, 250));
        return {
          feedHidden: document.querySelector('#changeFeed').hidden,
          highlights: document.querySelectorAll('#gridBody tr.row-changed').length,
        };
      })()
    `);
    console.log('  link update:', JSON.stringify(survivesLinks));
    console.log('Checking the strip clears on the next refresh…');
    const cleared = await main.evaluate(`
      (async () => {
        handleUpdate({ rows: state.__realRows, alerts: [], reason: 'timer' });
        delete state.__realRows;
        await new Promise((resolve) => setTimeout(resolve, 500));
        return {
          feedHidden: document.querySelector('#changeFeed').hidden,
          highlights: document.querySelectorAll('#gridBody tr.row-changed').length,
          windowHeight: window.innerHeight,
        };
      })()
    `);
    console.log('  cleared:', JSON.stringify(cleared));

    console.log('Opening settings…');
    await main.evaluate(`document.querySelector('#settingsBtn').click()`);
    await sleep(700);
    const settingsMetrics = await main.evaluate(`
      (() => {
        const card = document.querySelector('#settingsModal .settings-card');
        return {
          open: !document.querySelector('#settingsModal').hidden,
          cardHeight: Math.round(card.getBoundingClientRect().height),
          windowHeight: window.innerHeight,
          overlayEnabled: document.querySelector('#setOverlayEnabled').checked,
          background: document.querySelector('#setBackground .active')?.dataset.bg,
          corner: document.querySelector('#setCorner').value,
        };
      })()
    `);
    console.log('  settings:', JSON.stringify(settingsMetrics));

    const soundControls = await main.evaluate(`
      (() => ({
        ratings: Array.from(document.querySelectorAll('#soundList .sound-row')).map((row) => row.dataset.key),
        options: document.querySelectorAll('#soundList .sound-select option').length,
        values: Array.from(document.querySelectorAll('#soundList .sound-select')).map((s) => s.value),
      }))()
    `);
    console.log('  sounds:', JSON.stringify(soundControls));

    console.log('Setting Strong Sell to Digital…');
    await main.evaluate(`
      (() => {
        const select = document.querySelector('.sound-row[data-key="strongSell"] .sound-select');
        select.value = 'digital';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `);
    await sleep(600);

    const played = await main.evaluate(`
      (async () => {
        const out = [];
        for (const rating of ['Strong Buy', 'Buy', 'Neutral', 'Sell', 'Strong Sell']) {
          handleAlerts([{ symbol: 'FCX', rating, from: 'Neutral' }]);
          await new Promise((resolve) => setTimeout(resolve, 90));
          out.push([rating, window.Sounds.lastPlayed()]);
        }
        return out;
      })()
    `);
    console.log('  played:', JSON.stringify(played));

    await main.shot('02-settings.png');

    console.log('Restoring the Strong Sell sound…');
    await main.evaluate(`
      (() => {
        const select = document.querySelector('.sound-row[data-key="strongSell"] .sound-select');
        select.value = 'buzz';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `);
    await sleep(400);

    console.log('Enabling the overlay…');
    await main.evaluate(`document.querySelector('#setOverlayEnabled').click()`);
    await sleep(2500);

    const overlay = await attach(await findTarget('overlay.html'));
    await sleep(1200);

    // Make sure the transparent screenshot starts from None regardless of what
    // a previous session left in settings.
    await main.evaluate(`window.api.setSettings({ display: { overlayBackground: 'none' } })`);
    await sleep(800);

    const overlayMetrics = await overlay.evaluate(`
      (() => ({
        rows: document.querySelectorAll('.ov-row').length,
        rowHeight: document.querySelector('.ov-row')
          ? Math.round(document.querySelector('.ov-row').getBoundingClientRect().height)
          : 0,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        background: getComputedStyle(document.body).backgroundColor,
        bodyClass: document.body.className,
      }))()
    `);
    console.log('  overlay:', JSON.stringify(overlayMetrics));

    // Simulate a bright page behind the transparent overlay so legibility can
    // be judged from the screenshot.
    await setBackdrop(overlay, '#e8edf3');
    await overlay.shot('03-overlay-none.png');

    console.log('Switching to Dim…');
    await main.evaluate(`
      window.api.setSettings({ display: { overlayBackground: 'dim', overlayDim: 0.55 } })
    `);
    await sleep(900);
    const dimBg = await overlay.evaluate(`getComputedStyle(document.body).backgroundColor`);
    console.log('  dim background:', dimBg);
    await overlay.shot('04-overlay-dim.png');

    console.log('Switching to Solid…');
    await main.evaluate(`window.api.setSettings({ display: { overlayBackground: 'solid' } })`);
    await sleep(900);
    const solidBg = await overlay.evaluate(`getComputedStyle(document.body).backgroundColor`);
    console.log('  solid background:', solidBg);
    await overlay.shot('05-overlay-solid.png');

    console.log('Hiding the price column…');
    await main.evaluate(`
      window.api.setSettings({ display: { overlayBackground: 'none', overlayColumns: { price: false } } })
    `);
    await sleep(900);
    const columnCheck = await overlay.evaluate(`
      ({
        prices: document.querySelectorAll('.ov-price').length,
        changes: document.querySelectorAll('.ov-delta').length,
        pills: document.querySelectorAll('.ov-pill').length,
        height: window.innerHeight,
      })
    `);
    console.log('  columns:', JSON.stringify(columnCheck));
    await overlay.shot('06-overlay-no-price.png');

    console.log('Restoring defaults and closing the overlay…');
    await main.evaluate(`
      window.api.setSettings({
        display: {
          overlayEnabled: false,
          overlayBackground: 'none',
          overlayDim: 0.45,
          overlayColumns: { price: true, change: true, rating: true },
        },
      })
    `);
    await sleep(800);
    await main.evaluate(`document.querySelector('#closeSettingsBtn').click()`);
    await sleep(500);

    console.log('Clicking the price cell of the first row…');
    await main.evaluate(`document.querySelector('#gridBody tr td:nth-child(3)').click()`);
    await sleep(400);
    const rowClick = await main.evaluate(`
      ({
        popoverOpen: !document.querySelector('#popover').hidden,
        options: document.querySelectorAll('#popOptions [data-link]').length,
      })
    `);
    console.log('  row click:', JSON.stringify(rowClick));
    if (rowClick.popoverOpen) await main.shot('07-row-click.png');
    await main.evaluate(`closePopover()`);

    const logLines = mainLog
      .split(/\r?\n/)
      .filter(
        (line) =>
          line.includes('overlay:') ||
          line.includes('StockWatch watchlist') ||
          line.includes('Sentinel Vector')
      );
    console.log('\nMain-process log:');
    logLines.forEach((line) => console.log('  ' + line));

    console.log('\nUI check finished. Screenshots in', outDir);
  } catch (error) {
    console.error('UI check failed:', error);
    process.exitCode = 1;
  } finally {
    cleanup();
  }
})();
