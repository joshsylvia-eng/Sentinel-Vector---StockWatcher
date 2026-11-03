'use strict';

/*
 * Dev-only: checks that the main table still responds to real DOM clicks and
 * reports what element is actually on top at the ticker position.
 *
 *   node tools/click-test.js
 */

const { spawn, spawnSync, execFile } = require('node:child_process');
const path = require('node:path');

const electronPath = require('electron');
const projectRoot = path.join(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function powershell(script) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr || error.message));
        else resolve(stdout);
      }
    );
  });
}

const HIT_TEST = String.raw`
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public struct POINT { public int X; public int Y; }
}
"@

$global:mainHwnd = [IntPtr]::Zero
$global:ovHwnd = [IntPtr]::Zero
$callback = [W+EnumProc]{
  param([IntPtr]$h, [IntPtr]$l)
  if ([W]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 256
    [void][W]::GetWindowText($h, $sb, 256)
    $title = $sb.ToString()
    if ($title -eq 'StockWatch' -or $title -eq 'Sentinel Vector - StockWatcher') { $global:mainHwnd = $h }
    elseif ($title -eq 'StockWatch Overlay' -or $title -eq 'Sentinel Vector - StockWatcher Overlay') { $global:ovHwnd = $h }
  }
  $true
}
[void][W]::EnumWindows($callback, [IntPtr]::Zero)

if ($global:mainHwnd -eq [IntPtr]::Zero -or $global:ovHwnd -eq [IntPtr]::Zero) {
  Write-Output "MISSING main=$($global:mainHwnd) overlay=$($global:ovHwnd)"
  exit 0
}

$mr = New-Object W+RECT
$or = New-Object W+RECT
[void][W]::GetWindowRect($global:mainHwnd, [ref]$mr)
[void][W]::GetWindowRect($global:ovHwnd, [ref]$or)
Write-Output "mainRect=$($mr.Left),$($mr.Top),$($mr.Right),$($mr.Bottom)"
Write-Output "overlayRect=$($or.Left),$($or.Top),$($or.Right),$($or.Bottom)"

# Move the main window underneath the overlay.
[void][W]::SetWindowPos($global:mainHwnd, [IntPtr]::Zero, ($or.Left + 20), ($or.Top - 50), 1100, 500, 0x0014)
Start-Sleep -Milliseconds 400

$pt = New-Object W+POINT
$pt.X = [int](($or.Left + $or.Right) / 2)
$pt.Y = [int](($or.Top + $or.Bottom) / 2)
$hit = [W]::WindowFromPoint($pt)
$root = [W]::GetAncestor($hit, 2)
$sb = New-Object System.Text.StringBuilder 256
[void][W]::GetWindowText($root, $sb, 256)
Write-Output "point=$($pt.X),$($pt.Y)"
Write-Output "hitRoot=$root title=$($sb.ToString())"
Write-Output "clickReachesMain=$($root -eq $global:mainHwnd)"
`;

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
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
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
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description);
    return result.result.value;
  }
}

async function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.onopen = () => resolve(socket);
    socket.onerror = () => reject(new Error('socket failed'));
  });
}

(async () => {
  const child = spawn(electronPath, ['--remote-debugging-port=9222', '.'], {
    cwd: projectRoot,
    stdio: 'ignore',
  });
  const cleanup = () => spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });

  try {
    let page = null;
    for (let i = 0; i < 60 && !page; i += 1) {
      try {
        const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
        page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
      } catch {
        // not ready
      }
      if (!page) await sleep(500);
    }

    const cdp = new Cdp(await connect(page.webSocketDebuggerUrl));
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await sleep(9000);

    const before = await cdp.evaluate(`
      (() => {
        const sym = document.querySelector('#gridBody .sym');
        const rect = sym.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const top = document.elementFromPoint(x, y);
        return {
          rowHeight: Math.round(document.querySelector('#gridBody tr').getBoundingClientRect().height),
          symRect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
          topElement: top ? top.tagName + '.' + top.className : null,
          topText: top ? (top.textContent || '').slice(0, 20) : null,
          symPointerEvents: getComputedStyle(sym).pointerEvents,
          bodyPointerEvents: getComputedStyle(document.body).pointerEvents,
          popoverHidden: document.querySelector('#popover').hidden,
          settingsHidden: document.querySelector('#settingsModal').hidden,
          modalHidden: document.querySelector('#modal').hidden,
          screen: { x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight, dpr: devicePixelRatio },
        };
      })()
    `);
    console.log('before:', JSON.stringify(before, null, 2));

    await cdp.evaluate(`document.querySelector('#gridBody .sym').click()`);
    await sleep(400);
    const after = await cdp.evaluate(`
      ({
        popoverHidden: document.querySelector('#popover').hidden,
        options: document.querySelectorAll('#popOptions [data-link]').length,
        left: document.querySelector('#popover').style.left,
        top: document.querySelector('#popover').style.top,
      })
    `);
    console.log('after synthetic click:', JSON.stringify(after));

    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: before.symRect.x + 10, y: before.symRect.y + 8, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: before.symRect.x + 10, y: before.symRect.y + 8, button: 'left', clickCount: 1 });
    await sleep(400);
    const afterInput = await cdp.evaluate(`document.querySelector('#popover').hidden`);
    console.log('popover hidden after Input.dispatchMouseEvent:', afterInput);

    const pop = await cdp.evaluate(`
      (() => {
        const p = document.querySelector('#popover');
        const r = p.getBoundingClientRect();
        return {
          hidden: p.hidden,
          left: Math.round(r.left),
          top: Math.round(r.top),
          right: Math.round(r.right),
          bottom: Math.round(r.bottom),
          height: Math.round(r.height),
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          items: document.querySelectorAll('#popOptions .pop-item').length,
        };
      })()
    `);
    console.log('popover geometry:', JSON.stringify(pop));

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    require('node:fs').writeFileSync(
      path.join(process.env.TEMP || '.', 'stockwatch-shots', 'popover-compact.png'),
      Buffer.from(shot.data, 'base64')
    );
    console.log('saved popover-compact.png');

    console.log('\nEnabling the overlay for an OS-level hit test…');
    await cdp.evaluate(`window.api.setSettings({ display: { overlayEnabled: true } })`);
    await sleep(2500);
    console.log(await powershell(HIT_TEST));
    await cdp.evaluate(`window.api.setSettings({ display: { overlayEnabled: false } })`);
  } catch (error) {
    console.error('click test failed:', error);
    process.exitCode = 1;
  } finally {
    cleanup();
  }
})();
